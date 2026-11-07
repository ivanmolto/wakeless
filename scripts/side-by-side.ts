// Task 10.1: the same scripted agent workload on both rails, then docs/side-by-side.md.
// Devnet only; the script is the test (two titles, exits non-zero on either failing).
//
// Workload: 30 paid calls across three vendors, ten to vendor 1, then ten to vendor 2, then
// ten to vendor 3. Blocks, not round-robin, because the stock x402 example server listens
// on a hard-coded port (4021) and serves one payTo, so the public rail runs one server per
// vendor in turn; Wakeless runs the same blocks so the two workloads are the same.
//
// Public rail: the unmodified `batch-settlement` facilitator, server and client examples in
// vendor/x402/examples/typescript (their own .env files for keys), started as child
// processes with env overrides only: the RPC (ours, asserted devnet), the server's payTo,
// the client's target, call count, deposit multiplier and a fresh channel salt. After each
// vendor's ten calls the server's redemption worker claims and pays out; the script waits
// for that, then stops the server. Every rail transaction is then found on the ledger
// (getSignaturesForAddress over the parties, in the run's window) and read back.
//
// Wakeless: the in-process facilitator, vendors and client of `pnpm e2e` over the real
// MagicBlock binding, then one redemption run. The observer reads every signature the run
// emitted plus every base-layer transaction touching the buyer, the escrow or a vendor in
// the run's window.
//
//   pnpm side-by-side                    # both rails, live
//   pnpm side-by-side --public-from-log  # public rail from docs/public-rail-log.md's signatures
//
// Spends: 0.30 devnet USDC of the public payer (three 0.10 deposits, paid out to the three
// payTo keys) and 0.6 devnet USDC of the buyer's private balance (into escrow, redeemed to
// the vendors' private balances). Never prints a signature, a key or the RPC URL.
import { spawn, type ChildProcess } from "node:child_process";
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { createServer } from "node:net";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { findAssociatedTokenPda, getCreateAssociatedTokenIdempotentInstructionAsync, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  address,
  appendTransactionMessageInstructions,
  createKeyPairFromBytes,
  createKeyPairSignerFromBytes,
  createSolanaRpc,
  createTransactionMessage,
  getBase58Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayerSigner,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransactionMessageWithSigners,
  type Address,
  type Signature,
} from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { MagicBlockBuyer } from "@wakeless/binding-magicblock";
import { VENDORS } from "@wakeless/vendors";
import {
  createDevnetReader,
  decodeDistribute,
  decodeOpen,
  observe,
  ownerTrajectory,
  parseOwnerChannelFile,
  parseRunFile,
  PAYMENT_CHANNELS_PROGRAM,
  readOwnerView,
  reconstruct,
  renderOwnerView,
  type BaseTransaction,
  type FetchTransaction,
  type SignatureInput,
  type Trajectory,
} from "@wakeless/watcher";
import { assertDevnetGenesisHash, assertDevnetRpcUrl, redactSecrets } from "./lib/devnet.js";
import { loadDotEnv } from "./lib/env.js";
import { startInProcessRun } from "./lib/in-process-run.js";
import { assertNotMainnetKeyPath, generateKeypairJson, publicKeyFromKeypairJson } from "./lib/keypairs.js";
import { labelPublicTransaction, renderSideBySide, sideBySideJson, verdicts, type RailRun } from "./lib/side-by-side-doc.js";

const ROOT = resolve(import.meta.dirname, "..");
const EXAMPLES = join(ROOT, "vendor", "x402", "examples", "typescript");
const CALLS_PER_VENDOR = 10;
const VENDOR_COUNT = 3;
/** The example server's route price, `$0.01`, in USDC base units. */
const PUBLIC_PRICE = 10_000n;
/** Deposit = multiplier × price: one 0.10 USDC deposit carries ten calls, as in task 2.3. */
const DEPOSIT_MULTIPLIER = 10;
const SYMBOLS = ["SOL", "BTC", "ETH", "USDC", "JUP"];
const LISTEN_TIMEOUT_MS = 90_000;
const REDEEM_TIMEOUT_MS = 240_000;

// ------------------------------------------------------------------------------- helpers

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see .env.example`);
  return value;
}

/** Signatures and long base58 strings never reach stdout. */
function mask(text: string): string {
  return redactSecrets(text).replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/g, "[base58]");
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

function readKeypairFile(path: string): Uint8Array {
  assertNotMainnetKeyPath(path);
  const bytes = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`a keypair file under keys/public-rail is not an array of 64 bytes`);
  return Uint8Array.from(bytes as number[]);
}

async function assertPortFree(port: number): Promise<void> {
  await new Promise<void>((done, fail) => {
    const server = createServer();
    server.once("error", () => fail(new Error(`port ${port} is in use; the stock x402 examples need 4021 and 4022 (stop pnpm vendors or other servers first)`)));
    server.listen(port, "127.0.0.1", () => server.close(() => done()));
  });
}

type Rpc = ReturnType<typeof createSolanaRpc>;

/** Every signature touching any of `addresses` with a block time inside [from, to]. */
async function signaturesInWindow(rpc: Rpc, addresses: readonly Address[], from: number, to: number): Promise<Signature[]> {
  const found = new Map<string, number>();
  for (const a of addresses) {
    const list = await rpc.getSignaturesForAddress(a, { limit: 100, commitment: "confirmed" }).send();
    for (const entry of list) {
      const t = entry.blockTime === null ? null : Number(entry.blockTime);
      if (t !== null && t >= from && t <= to) found.set(entry.signature, t);
    }
  }
  return [...found.entries()].sort((a, b) => a[1] - b[1]).map(([s]) => s as Signature);
}

// ------------------------------------------------------------------- child processes

interface Child {
  readonly process: ChildProcess;
  readonly lines: string[];
  /** Resolves on the first line matching, rejects on exit or timeout. */
  waitFor(pattern: RegExp, timeoutMs: number): Promise<string>;
  exited(): Promise<number | null>;
}

function startExample(name: string, dir: string, env: Record<string, string>, logDir: string, onLine?: (line: string) => void): Child {
  const lines: string[] = [];
  let carry = "";
  const child = spawn(join(dir, "node_modules", ".bin", "tsx"), ["index.ts"], {
    cwd: dir,
    // A clean environment: the repo's .env must not leak into the examples (FACILITATOR_URL
    // and PORT mean other things there). The examples' own .env fills in their keys.
    env: { PATH: process.env.PATH ?? "", HOME: process.env.HOME ?? "", ...env },
    stdio: ["ignore", "pipe", "pipe"],
  });
  const waiters: { pattern: RegExp; done: (line: string) => void }[] = [];
  const onData = (chunk: Buffer): void => {
    const parts = (carry + chunk.toString("utf8")).split("\n");
    carry = parts.pop() ?? "";
    for (const line of parts) {
      if (line.length === 0) continue;
      lines.push(line);
      onLine?.(line);
      for (const w of [...waiters]) if (w.pattern.test(line)) { waiters.splice(waiters.indexOf(w), 1); w.done(line); }
    }
  };
  child.stdout.on("data", onData);
  child.stderr.on("data", onData);
  let exitCode: number | null | undefined;
  const exit = new Promise<number | null>((done) => child.once("exit", (code) => {
    exitCode = code;
    // The child's own log, kept private for debugging; it may hold signatures, so never stdout.
    writeFileSync(join(logDir, `${name}.log`), lines.join("\n") + "\n", { mode: 0o600 });
    done(code);
  }));
  return {
    process: child,
    lines,
    exited: () => exit,
    waitFor(pattern, timeoutMs) {
      const already = lines.find((l) => pattern.test(l));
      if (already !== undefined) return Promise.resolve(already);
      return new Promise((done, fail) => {
        const timer = setTimeout(() => fail(new Error(`${name}: timed out waiting for ${pattern}`)), timeoutMs);
        waiters.push({ pattern, done: (line) => { clearTimeout(timer); done(line); } });
        void exit.then((code) => { clearTimeout(timer); fail(new Error(`${name} exited (${exitCode ?? code}) before ${pattern}; last line: ${mask(lines.at(-1) ?? "none")}`)); });
      });
    },
  };
}

async function stop(child: Child, signal: NodeJS.Signals = "SIGINT", timeoutMs = 60_000): Promise<void> {
  if (child.process.exitCode !== null || child.process.signalCode !== null) return;
  child.process.kill(signal);
  const done = await Promise.race([child.exited().then(() => true), sleep(timeoutMs).then(() => false)]);
  if (!done) {
    child.process.kill("SIGKILL");
    await child.exited();
  }
}

// --------------------------------------------------------------------------- the public rail

interface PublicKeys {
  readonly facilitator: Address;
  readonly facilitatorBytes: Uint8Array;
  readonly payTos: readonly Address[];
}

/** keys/public-rail/payto.json (task 2.3) is vendor 1; payto-2 and payto-3 are made once here. */
function publicKeys(): PublicKeys {
  const dir = join(ROOT, "keys", "public-rail");
  const facilitatorBytes = readKeypairFile(join(dir, "facilitator.json"));
  const payTos: Address[] = [];
  for (const file of ["payto.json", "payto-2.json", "payto-3.json"]) {
    const path = join(dir, file);
    assertNotMainnetKeyPath(path);
    if (!existsSync(path)) {
      writeFileSync(path, generateKeypairJson(), { mode: 0o600 });
      console.log(`public rail: generated keys/public-rail/${file}`);
    }
    payTos.push(publicKeyFromKeypairJson(readFileSync(path, "utf8")));
  }
  return { facilitator: publicKeyFromKeypairJson(readFileSync(join(dir, "facilitator.json"), "utf8")), facilitatorBytes, payTos };
}

async function sendAndConfirm(rpc: Rpc, wire: string, signature: Signature): Promise<void> {
  await rpc.sendTransaction(wire as Parameters<Rpc["sendTransaction"]>[0], { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3n }).send();
  for (let i = 0; i < 60; i++) {
    const status = (await rpc.getSignatureStatuses([signature]).send()).value[0];
    if (status?.err) throw new Error("a setup transaction failed on chain");
    if (status?.confirmationStatus === "confirmed" || status?.confirmationStatus === "finalized") return;
    await sleep(1_000);
  }
  throw new Error("a setup transaction was not confirmed in 60 s");
}

/** The facilitator refuses an `open` to a payTo without a token account (task 2.3); creates any missing one, fee paid by the public-rail facilitator key. */
async function ensureTokenAccounts(rpc: Rpc, keys: PublicKeys, mint: Address): Promise<{ accounts: Address[]; setup: { signature: string; what: string }[] }> {
  const accounts: Address[] = [];
  const setup: { signature: string; what: string }[] = [];
  const payer = await createKeyPairSignerFromBytes(keys.facilitatorBytes);
  for (const [i, owner] of keys.payTos.entries()) {
    const [ata] = await findAssociatedTokenPda({ owner, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    accounts.push(ata);
    const info = await rpc.getAccountInfo(ata, { encoding: "base64" }).send();
    if (info.value !== null) continue;
    const instruction = await getCreateAssociatedTokenIdempotentInstructionAsync({ payer, owner, mint });
    const { value: blockhash } = await rpc.getLatestBlockhash().send();
    const message = pipe(
      createTransactionMessage({ version: 0 }),
      (m) => setTransactionMessageFeePayerSigner(payer, m),
      (m) => setTransactionMessageLifetimeUsingBlockhash(blockhash, m),
      (m) => appendTransactionMessageInstructions([instruction], m),
    );
    const signed = await signTransactionMessageWithSigners(message);
    const signature = getSignatureFromTransaction(signed);
    await sendAndConfirm(rpc, getBase64EncodedWireTransaction(signed), signature);
    setup.push({ signature, what: `vendor ${i + 1}'s payTo USDC token account created, fee and rent paid by the public-rail facilitator key (the stock facilitator refuses an \`open\` to a payTo without one)` });
    console.log(`public rail: created vendor ${i + 1}'s USDC token account`);
  }
  return { accounts, setup };
}

interface Classified {
  readonly input: SignatureInput;
  readonly rail: boolean;
}

/**
 * Labels a transaction by its payment-channels instruction. The vendor of an open or a
 * distribute is read from its recipients; a settle or top-up names its channel only, so its
 * vendor comes from an open seen earlier in the same window, or is marked unknown.
 */
function classifyPublic(tx: BaseTransaction, payTos: readonly Address[], channelVendor: Map<Address, readonly number[]>): Classified {
  const ix = tx.instructions.find((i) => !i.inner && i.programId === PAYMENT_CHANNELS_PROGRAM);
  if (ix === undefined) return { input: { signature: tx.signature, label: "outside the rail", party: "escrow" }, rail: false };
  const open = decodeOpen(ix.data);
  const distribute = decodeDistribute(ix.data);
  const d = ix.data?.[0];
  const channelAt = open !== null ? 5 : distribute !== null ? 0 : d === 4 ? 1 : 0;
  const channel = ix.accounts[channelAt];
  const vendorsOf = (recipients: readonly { recipient: Address }[]) => recipients.map((r) => payTos.indexOf(r.recipient) + 1);
  if (open !== null && channel !== undefined) channelVendor.set(channel, vendorsOf(open.recipients));
  const labelled = labelPublicTransaction({
    instruction: open !== null ? "open" : distribute !== null ? "distribute" : d === 2 ? "settle" : d === 3 ? "topUp" : d === 4 ? "settleAndSeal" : "other",
    discriminator: d,
    ...(open === null ? {} : { deposit: open.deposit }),
    recipientVendors: open !== null ? vendorsOf(open.recipients) : distribute !== null ? vendorsOf(distribute.recipients) : undefined,
    channelVendors: channel === undefined ? undefined : channelVendor.get(channel),
  });
  return { input: { signature: tx.signature, label: labelled, party: open !== null ? "buyer" : "escrow" }, rail: true };
}

// ------------------------------------------------------------------------------- preflight

/** Base-unit USDC a run spends on each side; checked before anything starts, so a short balance costs nothing. */
const PUBLIC_NEED = PUBLIC_PRICE * BigInt(DEPOSIT_MULTIPLIER) * BigInt(VENDOR_COUNT);
const WAKELESS_NEED = VENDORS.reduce((sum, v) => sum + BigInt(v.amount) * 100n, 0n);
const FACILITATOR_SOL_NEED = 50_000_000n;

/** The payer the stock client will use: its own `.env` key, read and never printed. */
function publicPayerAddress(): Promise<Address> {
  const env = readFileSync(join(EXAMPLES, "clients", "batch-settlement", ".env"), "utf8");
  const line = env.split("\n").find((l) => l.startsWith("SVM_PRIVATE_KEY="));
  const key = line?.slice("SVM_PRIVATE_KEY=".length).trim();
  if (!key) throw new Error("the client example's .env has no SVM_PRIVATE_KEY");
  return createKeyPairSignerFromBytes(getBase58Encoder().encode(key)).then((s) => s.address);
}

async function preflight(rpc: Rpc, mint: Address, publicRail: boolean): Promise<void> {
  const short: string[] = [];
  const usdc = (n: bigint) => `${Number(n) / 1e6} USDC`;
  if (publicRail) {
    const keys = publicKeys();
    const payer = await publicPayerAddress();
    const [ata] = await findAssociatedTokenPda({ owner: payer, mint, tokenProgram: TOKEN_PROGRAM_ADDRESS });
    const info = await rpc.getAccountInfo(ata, { encoding: "base64" }).send();
    const balance = info.value === null ? 0n : BigInt((await rpc.getTokenAccountBalance(ata).send()).value.amount);
    if (balance < PUBLIC_NEED) short.push(`the public payer holds ${usdc(balance)} of the ${usdc(PUBLIC_NEED)} the three deposits need`);
    const sol = (await rpc.getBalance(keys.facilitator).send()).value;
    if (sol < FACILITATOR_SOL_NEED) short.push(`the public-rail facilitator key holds ${Number(sol) / 1e9} SOL, under 0.05 (fees and channel rent)`);
  }
  const buyerKey = resolve(ROOT, process.env.BUYER_KEYPAIR || "keys/buyer.json");
  assertNotMainnetKeyPath(buyerKey);
  const buyer = await MagicBlockBuyer.create({
    network: DEVNET_CAIP2,
    baseRpcUrl: required("SOLANA_RPC_URL"),
    teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
    paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app",
    mint,
    buyer: await createKeyPairFromBytes(readKeypairFile(buyerKey)),
    attestationReportPath: resolve(ROOT, "docs/attestation-client.json"),
  });
  const privateBalance = await buyer.privateBalance();
  if (privateBalance < WAKELESS_NEED) short.push(`the buyer's private balance is ${usdc(privateBalance)}, under the ${usdc(WAKELESS_NEED)} the three channel deposits need (pnpm fund:private --role buyer --usdc 1)`);
  if (short.length > 0) throw new Error(`not enough to run both rails; nothing was spent:\n  ${short.join("\n  ")}`);
  console.log(`preflight: ${publicRail ? `public payer ≥ ${usdc(PUBLIC_NEED)}, facilitator ≥ 0.05 SOL, ` : ""}buyer private balance ≥ ${usdc(WAKELESS_NEED)}`);
}

async function drivePublic(rpc: Rpc, read: FetchTransaction, rpcUrl: string, mint: Address, logDir: string): Promise<RailRun> {
  for (const dir of ["facilitator", "servers", "clients"]) {
    const env = join(EXAMPLES, dir, "batch-settlement", ".env");
    if (!existsSync(env)) throw new Error(`vendor/x402/examples/typescript/${dir}/batch-settlement/.env is missing (task 2.3 set it up)`);
  }
  await assertPortFree(4021);
  await assertPortFree(4022);
  const keys = publicKeys();
  const { accounts, setup: setupBefore } = await ensureTokenAccounts(rpc, keys, mint);

  const windowStart = Math.floor(Date.now() / 1000) - 5;
  const facilitator = startExample("facilitator", join(EXAMPLES, "facilitator", "batch-settlement"), { SVM_RPC_URL: rpcUrl, PORT: "4022" }, logDir);
  let payer: Address | undefined;
  const callTimes: number[][] = [];
  try {
    await facilitator.waitFor(/listening on/, LISTEN_TIMEOUT_MS);
    for (const [i, payTo] of keys.payTos.entries()) {
      const server = startExample(`server-${i + 1}`, join(EXAMPLES, "servers", "batch-settlement"), { SVM_ADDRESS: payTo, FACILITATOR_URL: "http://localhost:4022" }, logDir);
      try {
        await server.waitFor(/listening at/, LISTEN_TIMEOUT_MS);
        const salt = BigInt(`0x${randomBytes(6).toString("hex")}`).toString();
        const times: number[] = [];
        const client = startExample(
          `client-${i + 1}`,
          join(EXAMPLES, "clients", "batch-settlement"),
          {
            SVM_RPC_URL: rpcUrl,
            RESOURCE_SERVER_URL: "http://localhost:4021",
            ENDPOINT_PATH: "/weather",
            NUMBER_OF_REQUESTS: String(CALLS_PER_VENDOR),
            DEPOSIT_MULTIPLIER: String(DEPOSIT_MULTIPLIER),
            SVM_CHANNEL_SALT: salt,
            REFUND_AFTER_REQUESTS: "false",
          },
          logDir,
          // "settled" is what the stock client prints for a 200 with a payment response.
          (line) => {
            if (/^Request \d+ — RESPONSE/.test(line)) times.push(Math.floor(Date.now() / 1000));
          },
        );
        const code = await client.exited();
        const payerLine = client.lines.find((l) => l.startsWith("SVM payer:"));
        const thisPayer = payerLine === undefined ? undefined : address(payerLine.slice("SVM payer:".length).trim());
        if (thisPayer === undefined) throw new Error(`client ${i + 1} did not report its payer`);
        if (payer !== undefined && payer !== thisPayer) throw new Error("the client example changed payer between vendors");
        payer = thisPayer;
        if (code !== 0) throw new Error(`client ${i + 1} exited ${code}; last line: ${mask(client.lines.at(-1) ?? "none")}`);
        callTimes.push(times);
        console.log(`public rail: vendor ${i + 1}: ${times.length} of ${CALLS_PER_VENDOR} calls settled; waiting for the server's redemption worker`);
        await server.waitFor(/\[SVM\] Settled to/, REDEEM_TIMEOUT_MS);
      } finally {
        await stop(server);
      }
    }
  } finally {
    await stop(facilitator, "SIGTERM");
  }
  if (payer === undefined) throw new Error("no payer");

  // The ledger, not the logs: everything touching the parties in the window.
  await sleep(5_000);
  const windowEnd = Math.floor(Date.now() / 1000) + 5;
  const found = await signaturesInWindow(rpc, [keys.facilitator, payer, ...keys.payTos], windowStart, windowEnd);
  const transactions: BaseTransaction[] = [];
  for (const s of found) transactions.push(await read(s));
  transactions.sort((a, b) => (a.slot ?? 0) - (b.slot ?? 0));
  const channelVendor = new Map<Address, readonly number[]>();
  const classified = transactions.map((tx) => classifyPublic(tx, keys.payTos, channelVendor));
  const rail = classified.filter((c) => c.rail);
  const setup = [...setupBefore.filter((s) => !found.includes(s.signature as Signature)), ...classified.filter((c) => !c.rail).map((c) => ({ signature: c.input.signature, what: setupBefore.find((s) => s.signature === c.input.signature)?.what ?? "a transaction touching a party, outside the payment-channels program" }))];
  const railTxs = transactions.filter((tx) => rail.some((c) => c.input.signature === tx.signature));

  const calls = callTimes.reduce((n, t) => n + t.length, 0);
  const actual: Trajectory = {
    payer,
    vendors: keys.payTos,
    firstContactOrder: keys.payTos,
    spendPerVendor: Object.fromEntries(keys.payTos.map((v, i) => [v, BigInt(callTimes[i]?.length ?? 0) * PUBLIC_PRICE])) as Record<Address, bigint>,
    settlementTimes: callTimes.flat(),
  };
  const amounts = new Set<bigint>();
  for (let k = 1n; k <= BigInt(CALLS_PER_VENDOR); k++) amounts.add(k * PUBLIC_PRICE);
  const report = await observe(
    {
      rail: "public",
      buyer: payer,
      escrow: keys.facilitator,
      vendors: keys.payTos,
      tokenAccounts: Object.fromEntries(keys.payTos.map((v, i) => [v, [accounts[i]!]])),
      attributableAmounts: [...amounts],
      signatures: rail.map((c) => c.input),
    },
    read,
  );
  return {
    rail: "public",
    title: "Public batch-settlement, stock x402 examples",
    provenance: `The stock \`batch-settlement\` facilitator, server and client examples from \`vendor/x402/examples/typescript\` (checkout \`e208bd3\`, unmodified, configured through their own \`.env\` files plus environment overrides for the RPC, the server's payTo, and the client's target, call count, \`DEPOSIT_MULTIPLIER=${DEPOSIT_MULTIPLIER}\` and a fresh channel salt per vendor). One facilitator; the server, which listens on a fixed port and serves one payTo, was started once per vendor in turn, and each time its redemption worker claimed and paid out before it was stopped. Route \`GET /weather\` at \`$0.01\` (${PUBLIC_PRICE}). Payer \`${payer}\` (the CLI keypair, as in task 2.3); facilitator fee payer \`${keys.facilitator}\`; payTo keys \`keys/public-rail/payto.json\`, \`payto-2.json\`, \`payto-3.json\`. The rail's transactions were found by \`getSignaturesForAddress\` over the facilitator, the payer and the three payTo keys between ${new Date(windowStart * 1000).toISOString()} and ${new Date(windowEnd * 1000).toISOString()}, then read back; every transaction under the payment-channels program in that window counts.`,
    calls,
    railTransactions: railTxs.length,
    setup,
    report,
    rebuilt: reconstruct(railTxs),
    actual,
  };
}

/** The fallback the prompt allows: task 2.3's three signatures, recorded in docs/watcher/public-rail.json. */
async function publicFromLog(read: FetchTransaction): Promise<RailRun> {
  const run = parseRunFile(JSON.parse(readFileSync(join(ROOT, "docs", "watcher", "public-rail.json"), "utf8")));
  const transactions: BaseTransaction[] = [];
  for (const s of run.signatures) transactions.push(await read(s.signature));
  return {
    rail: "public",
    title: run.title,
    provenance: "Task 2.3's run of the stock examples (`docs/public-rail-log.md`): ten calls to one vendor at `$0.01`, not this script's workload.",
    calls: 10,
    railTransactions: transactions.filter((t) => t.onBaseLayer).length,
    setup: [],
    report: await observe(run, read),
    rebuilt: reconstruct(transactions),
    actual: run.actual,
  };
}

// ------------------------------------------------------------------------------- Wakeless

async function driveWakeless(rpc: Rpc, read: FetchTransaction): Promise<RailRun> {
  const buyer = publicKeyFromKeypairJson(readFileSync(resolve(ROOT, process.env.BUYER_KEYPAIR || "keys/buyer.json"), "utf8"));
  const escrow = publicKeyFromKeypairJson(readFileSync(resolve(ROOT, process.env.ESCROW_KEYPAIR || "keys/escrow.json"), "utf8"));
  const windowStart = Math.floor(Date.now() / 1000) - 5;
  const startedAt = new Date().toISOString();
  const run = await startInProcessRun("side-by-side");
  const vendors = run.vendors.vendors;
  let served = 0;
  let redeemed: Awaited<ReturnType<typeof run.redeem>> | undefined;
  try {
    for (let v = 0; v < VENDOR_COUNT; v++) {
      const vendor = vendors[v]!;
      for (let c = 0; c < CALLS_PER_VENDOR; c++) {
        const url = `${vendor.url}${vendor.route.replace(":symbol", SYMBOLS[c % SYMBOLS.length]!)}`;
        const response = await run.pay(url);
        await response.arrayBuffer();
        if (response.status === 200) served++;
        else console.error(`wakeless: call ${c + 1} to vendor ${v + 1} answered ${response.status}`);
      }
      console.log(`wakeless: vendor ${v + 1}: ${CALLS_PER_VENDOR} calls made`);
    }
    redeemed = await run.redeem();
  } finally {
    await run.close();
  }
  if (redeemed === undefined) throw new Error("the redemption run did not complete");
  // Which channels the binding refused, and with which codes: the facilitator logs ids and
  // codes only (`settle rejected <channelId> <opId> <period> <attempts> <code> <apiCode>`).
  const vendorOfChannel = new Map((await run.stores.channels.list()).map((c) => [c.channelId, vendors.findIndex((v) => v.payTo === c.vendor) + 1]));
  const refusals = run.facilitatorLog
    .map((line) => /^settle rejected (\S+) \S+ \S+ \S+ (\S+)(?: (\S+))?/.exec(line))
    .filter((m): m is RegExpExecArray => m !== null)
    .map((m) => ({ vendor: vendorOfChannel.get(m[1]!) ?? 0, codes: [m[2], m[3]].filter((c): c is string => c !== undefined) }));
  const redemption =
    `one redemption run: ${redeemed.owed} channels owed, ${redeemed.confirmed} redeemed by private transfer` +
    (refusals.length === 0
      ? ""
      : `, ${refusals.length} refused by the binding (${refusals.map((r) => `vendor ${r.vendor}: ${r.codes.map((c) => `\`${c}\``).join(", ")}`).join("; ")}). A refused private transfer is terminal: it is not retried and never sent as a public transfer, so those amounts stay owed in escrow. \`TEE_INGRESS\` is the enclave's ingress refusing the transfer; the likely cause is that the refused vendors have never made a deposit of their own into the rail, which the rail asked of a recipient before it could receive when it was first tried on 31 Oct. The refusal is not a privacy failure: nothing reached the base layer`) +
    (redeemed.failed + redeemed.skipped === 0 ? "" : `, ${redeemed.failed} failed and ${redeemed.skipped} skipped`);
  console.log(`wakeless: ${redemption.replace(/`/g, "").split(". ")[0]}`);
  run.assertLogsClean();
  const watcher = await run.watcherReport();

  await sleep(5_000);
  const windowEnd = Math.floor(Date.now() / 1000) + 5;
  const vendorAddresses = vendors.map((v) => address(v.payTo));
  const inWindow = await signaturesInWindow(rpc, [buyer, escrow, ...vendorAddresses], windowStart, windowEnd);
  const emitted = new Set<string>(run.signatures);
  const extra = inWindow.filter((s) => !emitted.has(s));
  const extraRows = extra.length === 0 ? null : await observe({ rail: "wakeless", buyer, escrow, vendors: vendorAddresses, signatures: extra.map((signature) => ({ signature, label: "base-layer transaction touching a party in the window", party: "buyer" as const })) }, read);
  const report = extraRows === null ? watcher : { ...watcher, rows: [...watcher.rows, ...extraRows.rows], failures: [...watcher.failures, ...extraRows.failures], counts: { signatures: watcher.counts.signatures + extraRows.counts.signatures, onBaseLayer: watcher.counts.onBaseLayer + extraRows.counts.onBaseLayer, notOnBaseLayer: watcher.counts.notOnBaseLayer + extraRows.counts.notOnBaseLayer } };

  const transactions: BaseTransaction[] = [];
  for (const s of [...run.signatures, ...extra]) transactions.push(await read(s));
  const onBase = transactions.filter((t) => t.onBaseLayer);
  // Base-layer transactions in the window that the run did not make (a vault deposit by
  // someone else, a validator crank) are listed, and counted against the rail only if the
  // run emitted them.
  const railTransactions = onBase.filter((t) => emitted.has(t.signature)).length;
  const setup = onBase.filter((t) => !emitted.has(t.signature)).map((t) => ({ signature: t.signature, what: "a base-layer transaction touching the buyer, the escrow or a vendor in the window, not made by the run" }));

  const channelFile = JSON.parse(readFileSync(run.channelStoreLocal, "utf8")) as unknown;
  const owner = await readOwnerView({
    trajectory: run.pay,
    balance: { privateBalance: () => run.privateBalance() },
    channels: parseOwnerChannelFile(channelFile, buyer).channels,
    history: [{ at: startedAt, balance: run.balanceBefore, label: "before the run" }],
    payer: buyer,
  });
  const balanceAfter = owner.balances.at(-1)!;
  const relabelled = { ...owner, balances: [...owner.balances.slice(0, -1), { ...balanceAfter, label: "after the run" }] };
  return {
    rail: "wakeless",
    title: "Wakeless over the MagicBlock Private Ephemeral Rollup",
    provenance: `The in-process facilitator, the three synthetic vendors and the client of \`pnpm e2e\`, over the real attested MagicBlock binding (\`docs/attestation-client.json\`, \`docs/attestation-facilitator.json\`), then ${redemption}. Buyer \`${buyer}\`, escrow \`${escrow}\`. Each vendor's channel opened with a deposit of 100 × its route price from the buyer's private balance. The observer read every signature the run emitted, plus every base-layer transaction touching the buyer, the escrow or a vendor between ${new Date(windowStart * 1000).toISOString()} and ${new Date(windowEnd * 1000).toISOString()} (${extra.length} found).`,
    calls: served,
    railTransactions,
    setup,
    report,
    rebuilt: reconstruct(transactions),
    actual: ownerTrajectory(owner),
    ownerView: renderOwnerView(relabelled),
  };
}

// ----------------------------------------------------------------------------------- main

async function main(): Promise<void> {
  loadDotEnv(ROOT);
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured here: this script runs on devnet only");
  const rpcUrl = required("SOLANA_RPC_URL");
  assertDevnetRpcUrl(rpcUrl);
  const rpc = createSolanaRpc(rpcUrl);
  assertDevnetGenesisHash(await rpc.getGenesisHash().send());
  const read = createDevnetReader(rpcUrl);
  const mint = address(required("USDC_MINT"));
  const logDir = join(homedir(), ".wakeless", `side-by-side-${new Date().toISOString().replace(/[:.]/g, "-")}`);
  mkdirSync(logDir, { recursive: true, mode: 0o700 });
  chmodSync(logDir, 0o700);

  const fromLog = process.argv.includes("--public-from-log");
  await preflight(rpc, mint, !fromLog);

  let publicRail: RailRun;
  let publicFallback: string | undefined;
  if (fromLog) {
    publicFallback = "`--public-from-log` was given.";
    publicRail = await publicFromLog(read);
  } else {
    try {
      publicRail = await drivePublic(rpc, read, rpcUrl, mint, logDir);
    } catch (error) {
      publicFallback = `Driving the stock examples failed: ${mask(error instanceof Error ? error.message : String(error))}.`;
      console.error(`public rail: ${publicFallback} Falling back to docs/public-rail-log.md.`);
      publicRail = await publicFromLog(read);
    }
  }
  const wakeless = await driveWakeless(rpc, read);

  const input = {
    date: new Date().toISOString().slice(0, 10),
    workload: `Workload: ${CALLS_PER_VENDOR * VENDOR_COUNT} paid calls across three vendors, ${CALLS_PER_VENDOR} to vendor 1, then ${CALLS_PER_VENDOR} to vendor 2, then ${CALLS_PER_VENDOR} to vendor 3, each vendor's calls in one block because the stock example server serves one payTo on a fixed port; then each rail's redemption.`,
    publicRail,
    wakeless,
    ...(publicFallback === undefined ? {} : { publicFallback }),
  };
  writeFileSync(join(ROOT, "docs", "side-by-side.md"), renderSideBySide(input));
  writeFileSync(join(ROOT, "docs", "side-by-side.json"), sideBySideJson(input));

  const results = verdicts(input);
  for (const r of [publicRail, wakeless]) {
    console.log(`${r.rail.padEnd(9)} calls ${r.calls}, base-layer transactions ${r.railTransactions} (${(r.railTransactions / Math.max(r.calls, 1)).toFixed(2)} per call), signatures observed ${r.report.counts.signatures}`);
  }
  console.log("docs/side-by-side.md and docs/side-by-side.json written");
  let failed = false;
  for (const r of results) {
    if (r.failures.length === 0) console.log(`PASS ${r.title}`);
    else {
      failed = true;
      for (const f of r.failures) console.error(`  ${f}`);
      console.error(`FAIL ${r.title}`);
    }
  }
  if (publicFallback !== undefined) console.error("note: the public rail came from docs/public-rail-log.md, not from this run");
  if (failed) process.exit(1);
}

main().catch((error: unknown) => {
  console.error(`[side-by-side] ${mask(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
});
