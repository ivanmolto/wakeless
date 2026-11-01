// Task 6.2: the two ends of a recorded agent run; `scripts/agent-run.md` is the runbook.
// Devnet only. `before` notes the newest signature of every address the run could touch
// and the buyer's private balance. `finish` exports `getTrajectory()`, counts what the
// run put on the base layer, and writes the transcript from Claude Code's stream-json.
//
//   pnpm agent-run before run-1
//   pnpm agent-run finish run-1 <stream.jsonl> <facilitator.log>
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { address, createKeyPairFromBytes, createSolanaRpc, type Address } from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { MagicBlockBuyer } from "@wakeless/binding-magicblock";
import { wrapFetchWithWakeless } from "@wakeless/client";
import { publicKeyOf } from "@wakeless/scheme";
import { assertDevnetRpcUrl, redactSecrets } from "./lib/devnet.js";
import { loadDotEnv } from "./lib/env.js";
import { assertNotMainnetKeyPath } from "./lib/keypairs.js";

const ROOT = resolve(import.meta.dirname, "..");
const PROMPT_FILE = join(ROOT, "scripts", "agent-run-prompt.txt");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see .env.example`);
  return value;
}

/** Solana CLI format, 64 bytes. Never under keys/mainnet/. Errors never quote the file. */
function keyBytes(envVar: string, fallback: string): Uint8Array {
  const path = resolve(ROOT, process.env[envVar] || fallback);
  assertNotMainnetKeyPath(path);
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${envVar} is not a readable JSON keypair file; run pnpm keys`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${envVar} is not an array of 64 bytes`);
  return Uint8Array.from(bytes as number[]);
}

function publicAddress(envVar: string, fallback: string): Address {
  return address(publicKeyOf({ secretKey: keyBytes(envVar, fallback) }));
}

interface Before {
  readonly at: string;
  /** Private balance, atomic units. */
  readonly balance: string;
  /** Watched address to its newest signature, null when it has none. */
  readonly newest: Record<string, string | null>;
}

function statePath(run: string): string {
  return join(homedir(), ".wakeless", `agent-${run}-before.json`);
}

function storePath(run: string): string {
  return join(homedir(), ".wakeless", `agent-${run}-channels.json`);
}

function setup() {
  loadDotEnv(ROOT);
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured here: this script runs on devnet only");
  const baseRpcUrl = required("SOLANA_RPC_URL");
  assertDevnetRpcUrl(baseRpcUrl);
  return { baseRpcUrl, mint: address(required("USDC_MINT")), rpc: createSolanaRpc(baseRpcUrl) };
}

/** Constructing the buyer asserts the cluster's genesis hash and attests the TEE, before any other RPC call here. */
async function buyerRail(baseRpcUrl: string, mint: Address, run: string): Promise<MagicBlockBuyer> {
  return MagicBlockBuyer.create({
    network: DEVNET_CAIP2,
    baseRpcUrl,
    teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
    paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app",
    mint,
    buyer: await createKeyPairFromBytes(keyBytes("BUYER_KEYPAIR", "keys/buyer.json")),
    attestationReportPath: join(ROOT, "docs", "runs", `${run}-attestation-counter.json`),
  });
}

/** The buyer, the escrow, the three vendors, and each one's token accounts of the mint. */
async function watchedAddresses(rpc: ReturnType<typeof setup>["rpc"], mint: Address): Promise<readonly Address[]> {
  const owners = [
    publicAddress("BUYER_KEYPAIR", "keys/buyer.json"),
    publicAddress("ESCROW_KEYPAIR", "keys/escrow.json"),
    publicAddress("VENDOR1_KEYPAIR", "keys/vendor1.json"),
    publicAddress("VENDOR2_KEYPAIR", "keys/vendor2.json"),
    publicAddress("VENDOR3_KEYPAIR", "keys/vendor3.json"),
  ];
  const watched: Address[] = [...owners];
  for (const owner of owners) {
    const accounts = await rpc.getTokenAccountsByOwner(owner, { mint }, { encoding: "jsonParsed" }).send();
    watched.push(...accounts.value.map((account) => account.pubkey));
  }
  return watched;
}

async function before(run: string): Promise<void> {
  const { baseRpcUrl, mint, rpc } = setup();
  if (existsSync(storePath(run))) throw new Error(`${storePath(run)} exists: this run has been made; pick a new run name`);
  mkdirSync(join(ROOT, "docs", "runs"), { recursive: true });
  const rail = await buyerRail(baseRpcUrl, mint, run);
  const newest: Record<string, string | null> = {};
  for (const watched of await watchedAddresses(rpc, mint)) {
    const [latest] = await rpc.getSignaturesForAddress(watched, { limit: 1 }).send();
    newest[watched] = latest?.signature ?? null;
  }
  const balance = await rail.privateBalance();
  const state: Before = { at: new Date().toISOString(), balance: balance.toString(), newest };
  writeFileSync(statePath(run), JSON.stringify(state, null, 2) + "\n", { mode: 0o600 });
  console.log(`[agent-run] ${Object.keys(newest).length} addresses watched, private balance ${Number(balance) / 1e6} USDC`);
}

/** Signatures on any watched address newer than `before` noted. An address first seen now is walked whole. */
async function newOnBaseLayer(rpc: ReturnType<typeof setup>["rpc"], mint: Address, state: Before): Promise<ReadonlySet<string>> {
  const found = new Set<string>();
  for (const watched of await watchedAddresses(rpc, mint)) {
    const until = state.newest[watched];
    const page = await rpc.getSignaturesForAddress(watched, { limit: 1000, ...(until ? { until: until as never } : {}) }).send();
    for (const entry of page) found.add(entry.signature);
  }
  return found;
}

interface Block {
  readonly type: string;
  readonly text?: string;
  readonly name?: string;
  readonly tool_name?: string;
  readonly input?: unknown;
  readonly content?: string | readonly Block[];
  readonly is_error?: boolean;
}

interface StreamLine {
  readonly type: string;
  readonly subtype?: string;
  readonly model?: string;
  readonly mcp_servers?: readonly { name: string; status: string }[];
  readonly message?: { model?: string; content?: string | readonly Block[] };
  readonly is_error?: boolean;
  readonly isSidechain?: boolean;
}

function blockText(content: string | readonly Block[] | undefined): string {
  if (typeof content === "string") return content;
  return (content ?? []).map((block) => block.text ?? block.tool_name ?? "").join("\n");
}

function fenced(body: string, language = ""): string {
  return `\`\`\`${language}\n${body.trim()}\n\`\`\``;
}

interface Transcript {
  readonly markdown: string;
  readonly model: string;
  /** What the session was given: the app's first message, or the prompt file for `claude -p`, whose stream does not echo it. */
  readonly prompt: string;
  readonly how: string;
  readonly wakelessCalls: number;
}

/** The session, turn by turn, from `claude -p` stream-json or the app's session file (same message shape). Thinking blocks stay out. */
function renderTranscript(lines: readonly StreamLine[]): Transcript {
  const init = lines.find((line) => line.type === "system" && line.subtype === "init");
  if (init !== undefined) {
    const server = init.mcp_servers?.find((entry) => entry.name === "wakeless");
    if (server?.status !== "connected") throw new Error(`the session's wakeless server was ${server?.status ?? "absent"}, not connected`);
  }
  const result = lines.find((line) => line.type === "result");
  if (result?.is_error === true || (init !== undefined && result === undefined)) throw new Error("the session did not end in a successful result");
  const out: string[] = [];
  let wakelessCalls = 0;
  let model = init?.model;
  for (const line of lines) {
    if ((line.type !== "assistant" && line.type !== "user") || line.isSidechain === true) continue;
    if (line.type === "assistant") model ??= line.message?.model;
    const content = line.message?.content;
    if (!Array.isArray(content)) continue;
    for (const block of content as readonly Block[]) {
      if (line.type === "assistant" && block.type === "text") {
        out.push(`**Agent:**\n\n${block.text?.trim() ?? ""}`);
      } else if (line.type === "assistant" && block.type === "tool_use") {
        if (block.name?.startsWith("mcp__wakeless__") === true) wakelessCalls++;
        out.push(`**Tool call:** \`${block.name ?? ""}\`\n\n${fenced(JSON.stringify(block.input), "json")}`);
      } else if (line.type === "user" && block.type === "tool_result") {
        out.push(`**Tool result${block.is_error === true ? " (error)" : ""}:**\n\n${fenced(blockText(block.content))}`);
      }
    }
  }
  if (wakelessCalls === 0) throw new Error("the session made no wakeless tool call");
  const first = lines.find((line) => line.type === "user" && typeof line.message?.content === "string");
  return {
    markdown: out.join("\n\n"),
    model: model ?? "unknown",
    prompt: first === undefined ? readFileSync(PROMPT_FILE, "utf8").trim() : (first.message?.content as string).trim(),
    how: init === undefined ? "a new session of the Claude desktop app" : "`claude -p`",
    wakelessCalls,
  };
}

async function finish(run: string, streamPath: string, facilitatorLogPath: string): Promise<void> {
  const { baseRpcUrl, mint, rpc } = setup();
  const state = JSON.parse(readFileSync(statePath(run), "utf8")) as Before;

  // An app session cannot be given the run's environment, so it uses the server's default channel file.
  const pay = wrapFetchWithWakeless(fetch, { buyerKeypair: keyBytes("BUYER_KEYPAIR", "keys/buyer.json"), ...(existsSync(storePath(run)) ? { channelStoreLocal: storePath(run) } : {}) });
  const trajectory = pay.getTrajectory();
  if (trajectory.length === 0) throw new Error("the trajectory is empty: the agent paid for nothing");
  if (trajectory.some((entry) => entry.timestamp < state.at)) throw new Error("the channel file holds requests older than this run; the trajectory would not be this run's");
  const deposits = trajectory.filter((entry) => entry.deposit !== undefined);
  const deposited = deposits.reduce((sum, entry) => sum + BigInt(entry.deposit as string), 0n);

  const rail = await buyerRail(baseRpcUrl, mint, run);
  const onLedger = await newOnBaseLayer(rpc, mint, state);
  const balanceMoved = BigInt(state.balance) - (await rail.privateBalance());
  const facilitatorLog = readFileSync(facilitatorLogPath, "utf8").split("\n");
  const confirmed = facilitatorLog.filter((line) => line.includes("deposit confirmed")).length;
  const settled = facilitatorLog.filter((line) => line.includes("POST /settle 200 settled")).length;

  if (confirmed !== deposits.length) throw new Error(`the facilitator confirmed ${confirmed} deposits, the trajectory holds ${deposits.length}`);
  if (balanceMoved !== deposited) throw new Error(`the private balance moved ${balanceMoved}, the deposits add up to ${deposited}`);

  const lines = readFileSync(streamPath, "utf8").split("\n").filter(Boolean).map((line) => JSON.parse(line) as StreamLine);
  const transcript = renderTranscript(lines);
  const usdc = (atomic: bigint): string => `${Number(atomic) / 1e6} USDC`;
  const body = `# Agent run: ${run}

A fresh Claude Code session (${transcript.model}, ${transcript.how}, no prior context) with the wakeless MCP server configured from \`.mcp.json\`, on Solana devnet, recorded by [\`scripts/agent-run.md\`](../../scripts/agent-run.md) on ${state.at.slice(0, 10)}. The vendors are synthetic: the market view below is about made-up feeds. Status: devnet alpha, unaudited.

## Base-layer transactions

**Base-layer transaction count: ${deposits.length}** (the conservative bound \`pnpm e2e\` also reports: every transaction the run emitted, and they are the deposits only, one per vendor; vouchers are off-chain and the redemption worker does not exist until task 7.2.)

**Of those, on the public ledger: ${onLedger.size}** (measured: new signatures on the buyer, the escrow, the three vendors and their token accounts between the start and the end of the run. A deposit is a private transfer executed inside the MagicBlock rollup, so the bound overstates what the ledger shows.)

| Measure | Value | Source |
| --- | --- | --- |
| Paid requests | ${trajectory.length} | \`getTrajectory()\`, [\`${run}-trajectory.json\`](${run}-trajectory.json) |
| Wakeless tool calls by the agent | ${transcript.wakelessCalls} | the transcript below; \`budget_status\` is free |
| Deposits | ${deposits.length} | entries with \`deposit\` in the trajectory |
| Deposits the facilitator confirmed | ${confirmed} | its log, \`deposit confirmed\` |
| Vouchers and deposits the facilitator settled | ${settled} | its log, \`POST /settle 200 settled\` |
| Private balance moved into escrow | ${usdc(balanceMoved)} | the buyer's private balance, before and after; equals the deposits' sum |

The watcher's four checks did not run: \`packages/watcher\` has no code yet (Day 9). The ledger measure above covers these addresses only.

## Trust boundary

The privacy claim is against the public ledger. Three operators see inside: the facilitator (vouchers, deposits, amounts), MagicBlock's enclave (the private transfers) and, for channels funded through Aurora Confidential Intents, NEAR's private shard (origin and route; this run used no Aurora funding). The trajectory file is the owner's own view and only the owner holds it until it is published here; these are devnet keys and synthetic vendors.

## Transcript

**Prompt:**

${transcript.prompt}

${transcript.markdown}
`;
  if (/[1-9A-HJ-NP-Za-km-z]{87,88}/.test(body) || /bearer|api[-_]?key=/i.test(body)) throw new Error("the transcript carries a signature, a token or a key; not writing it");

  const dir = join(ROOT, "docs", "runs");
  writeFileSync(join(dir, `${run}-trajectory.json`), JSON.stringify(trajectory, null, 2) + "\n");
  writeFileSync(join(dir, `${run}.md`), body);
  console.log(`[agent-run] ${trajectory.length} paid requests, ${deposits.length} deposits, ${onLedger.size} on the base layer, ${usdc(balanceMoved)} into escrow`);
}

async function main(): Promise<void> {
  const [command, run, stream, facilitatorLog] = process.argv.slice(2);
  if (command === "before" && run !== undefined) return before(run);
  if (command === "finish" && run !== undefined && stream !== undefined && facilitatorLog !== undefined) return finish(run, stream, facilitatorLog);
  throw new Error("usage: pnpm agent-run before <run> | finish <run> <stream.jsonl> <facilitator.log>");
}

main().catch((error: unknown) => {
  console.error(`[agent-run] ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
});
