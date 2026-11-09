// Evidence capture (docs/shots/watcher.png, docs/shots/watcher-output.txt): the watcher's
// four checks, reconstruct() and compare() over the signatures of one recorded agent run,
// read from Solana devnet, next to the public rail's recorded run for the comparison. The
// run's deposit signatures come from its channel file under ~/.wakeless/ (the published
// trajectory does not carry them); the addresses and token accounts are the ones
// docs/watcher/wakeless-run.json already names. Reads only; writes nothing under docs/:
// `pnpm watcher` owns docs/WATCHER.md and docs/watcher/, which this leaves as recorded.
//
//   pnpm shots:watch run-3 > docs/shots/watcher-output.txt
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import {
  compare,
  createDevnetReader,
  formatFailures,
  observe,
  parseRunFile,
  reconstruct,
  renderComparison,
  renderMarkdownTable,
  renderTrajectory,
  type ObserverReport,
  type Reconstruction,
  type RunFile,
} from "@wakeless/watcher";
import { loadDotEnv } from "../lib/env.js";

const ROOT = join(import.meta.dirname, "..", "..");
const DOCS = join(ROOT, "docs", "watcher");

interface ChannelFile {
  readonly channels: Record<string, { readonly vendor: string; readonly channelId: string; readonly deposit: string; readonly accepted: string; readonly accept: { readonly amount: string } }>;
  readonly trajectory: readonly { readonly vendor: string; readonly at?: string; readonly deposit?: string; readonly depositSignature?: string; readonly price?: string; readonly charged?: string }[];
}

/** The run file for a recorded agent run: the template's addresses, the run's own signatures and actual trajectory. */
function runFileFor(run: string): unknown {
  const template = JSON.parse(readFileSync(join(DOCS, "wakeless-run.json"), "utf8")) as Record<string, unknown>;
  const file = JSON.parse(readFileSync(join(homedir(), ".wakeless", `agent-${run}-channels.json`), "utf8")) as ChannelFile;
  const channels = Object.values(file.channels);
  const deposits = file.trajectory.filter((entry) => entry.depositSignature !== undefined);
  if (deposits.length === 0) throw new Error(`the ${run} channel file keeps no deposit signatures`);
  const order: string[] = [];
  for (const entry of file.trajectory) if (!order.includes(entry.vendor)) order.push(entry.vendor);
  const spend: Record<string, string> = {};
  for (const channel of channels) spend[channel.vendor] = channel.accepted;
  const amounts = new Set<string>();
  for (const channel of channels) {
    amounts.add(channel.deposit);
    amounts.add(channel.accepted);
    for (let n = 1n; n <= 3n; n++) amounts.add((BigInt(channel.accept.amount) * n).toString());
  }
  return {
    ...template,
    title: `Wakeless, devnet: agent ${run} (${file.trajectory.length} paid requests, ${channels.length} channels), its ${deposits.length} deposits read from the ledger`,
    attributableAmounts: [...amounts],
    signatures: deposits.map((entry, i) => ({ signature: entry.depositSignature, label: `channel deposit ${i + 1}: buyer → escrow for vendor ${order.indexOf(entry.vendor) + 1} (private transfer inside the rollup)`, party: "buyer" })),
    actual: {
      payer: template.buyer,
      vendors: order,
      firstContactOrder: order,
      spendPerVendor: spend,
      settlementTimes: [],
    },
  };
}

interface RailResult {
  readonly run: RunFile;
  readonly report: ObserverReport;
  readonly rebuilt: Reconstruction;
}

async function runRail(run: RunFile, read: ReturnType<typeof createDevnetReader>): Promise<RailResult> {
  const report = await observe(run, read);
  const transactions = [];
  for (const s of run.signatures) transactions.push(await read(s.signature));
  return { run, report, rebuilt: reconstruct(transactions) };
}

function section(result: RailResult): string[] {
  const { run, report, rebuilt } = result;
  const comparison = compare(rebuilt, run.actual);
  const lines: string[] = [];
  lines.push(`## ${run.rail === "public" ? "Public rail" : "Wakeless"}: ${run.title}`, "");
  lines.push(`Signatures: ${report.counts.signatures}; on the base layer: ${report.counts.onBaseLayer}; not on the base layer: ${report.counts.notOnBaseLayer}.`);
  if (run.rail === "wakeless") lines.push(`Four checks: ${report.failures.length === 0 ? "every signature passes" : `${report.failures.length} failed`}.`);
  else lines.push("Four checks on the public rail are information: the rail is expected to fail them, and does.");
  lines.push("", "### What the ledger shows, per signature", "", renderMarkdownTable(report), "");
  lines.push("### What an observer rebuilds", "", renderTrajectory(rebuilt), "", "Against the owner's actual trajectory:", "", renderComparison(comparison), "");
  return lines;
}

async function main(): Promise<void> {
  loadDotEnv(ROOT);
  const run = process.argv[2] ?? "run-3";
  const rpcUrl = process.env.SOLANA_RPC_URL;
  if (!rpcUrl) throw new Error("SOLANA_RPC_URL is not set; copy .env.example to .env");
  const read = createDevnetReader(rpcUrl);
  const publicRail = await runRail(parseRunFile(JSON.parse(readFileSync(join(DOCS, "public-rail.json"), "utf8"))), read);
  const wakeless = await runRail(parseRunFile(runFileFor(run)), read);

  const out: string[] = [];
  out.push(`# Watcher: the observer's view of agent ${run}`, "");
  out.push(`Generated by \`pnpm shots:watch ${run}\` on ${new Date().toISOString().slice(0, 10)}: the public rail's recorded signatures (\`docs/watcher/public-rail.json\`) and the ${run} deposits, read from Solana devnet with \`getTransaction\`. The four checks: 1 no vendor address; 2 no vendor-attributable amount; 3 no Memo instruction; 4 no fee transfer naming the vendor.`, "");
  out.push("The privacy claim is against the public ledger. Three operators see inside: the facilitator (vouchers), MagicBlock's enclave (private transfers) and NEAR's private shard (funding origin and route).", "");
  out.push(...section(publicRail), ...section(wakeless));
  console.log(out.join("\n"));
  if (wakeless.report.failures.length > 0) {
    console.error(formatFailures(wakeless.report));
    process.exit(1);
  }
}

main().catch((error: unknown) => {
  console.error(`[shots:watch] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
