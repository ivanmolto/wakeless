// Task 10.1: the pure half of `scripts/side-by-side.ts`. Takes what each rail's run
// produced (the observer report over its signatures, what reconstruct() rebuilt, the
// owner's actual trajectory) and renders `docs/side-by-side.md` and its JSON. No network.
import type { Address } from "@solana/kit";
import {
  compare,
  renderComparison,
  renderMarkdownTable,
  renderTrajectory,
  reportToJson,
  trajectoryToJson,
  type Comparison,
  type ObserverReport,
  type Reconstruction,
  type Trajectory,
} from "@wakeless/watcher";

/** What the driver decoded of one public-rail transaction, enough to label it truthfully. */
export interface PublicTransactionFacts {
  readonly instruction: "open" | "settle" | "topUp" | "settleAndSeal" | "distribute" | "other";
  readonly discriminator: number | undefined;
  readonly deposit?: bigint;
  /** Vendor numbers (1-based) of the recipients an open or distribute names; 0 for a recipient that is not one of the run's payTo keys. */
  readonly recipientVendors?: readonly number[];
  /** Vendor numbers of the channel's recipients, from an open seen earlier in the window; undefined when that open was not seen. */
  readonly channelVendors?: readonly number[];
}

function vendorList(vendors: readonly number[]): string {
  const named = vendors.map((v) => (v === 0 ? "a recipient outside the run" : `vendor ${v}`));
  return named.length === 1 ? named[0]! : `${named.length} recipients: ${named.join(", ")}`;
}

/**
 * The label for the observer table. It says what the ledger lets it say: an open or a
 * distribute names its recipients; a settle or top-up names a channel, whose vendor is
 * known only if its open fell inside the window.
 */
export function labelPublicTransaction(f: PublicTransactionFacts): string {
  switch (f.instruction) {
    case "open":
      return `open, ${vendorList(f.recipientVendors ?? [])} (deposit ${f.deposit ?? "?"}, call 1)`;
    case "distribute":
      return `distribute, payout to ${vendorList(f.recipientVendors ?? [])}`;
    case "settle":
    case "topUp":
    case "settleAndSeal": {
      const name = f.instruction === "settle" ? "settle (claim of the latest voucher)" : f.instruction === "topUp" ? "top-up" : "settle and seal";
      return f.channelVendors === undefined ? `${name}, vendor unknown (the channel's open is outside the window)` : `${name}, ${vendorList(f.channelVendors)}`;
    }
    case "other":
      return `payment-channels instruction ${f.discriminator ?? "?"}`;
  }
}

export interface RailRun {
  readonly rail: "public" | "wakeless";
  readonly title: string;
  /** How the run was made, in one paragraph: what ran, on which keys, which window. */
  readonly provenance: string;
  /** Paid calls the workload made that came back 200. */
  readonly calls: number;
  /** Base-layer transactions the rail produced for the workload (setup excluded). */
  readonly railTransactions: number;
  /** Setup transactions in the window, outside the rail (token accounts, fundings), listed apart. */
  readonly setup: readonly { readonly signature: string; readonly what: string }[];
  readonly report: ObserverReport;
  readonly rebuilt: Reconstruction;
  readonly actual: Trajectory;
  /** Markdown, Wakeless only: the owner's view (`renderOwnerView`). */
  readonly ownerView?: string;
}

export interface Headline {
  readonly railTransactions: number;
  readonly calls: number;
  readonly perCall: string;
  readonly comparison: Comparison;
}

export function perCall(transactions: number, calls: number): string {
  if (calls <= 0) throw new Error("no paid call to divide by");
  return (transactions / calls).toFixed(2);
}

export function headlineOf(run: RailRun): Headline {
  return { railTransactions: run.railTransactions, calls: run.calls, perCall: perCall(run.railTransactions, run.calls), comparison: compare(run.rebuilt, run.actual) };
}

function railName(rail: RailRun["rail"]): string {
  return rail === "public" ? "Public `batch-settlement`" : "Wakeless (`batch-settlement-shielded`)";
}

function pct(bps: number): string {
  return `${(bps / 100).toFixed(2)}%`;
}

function actualBlock(actual: Trajectory): string {
  const lines: string[] = [];
  lines.push(`- **Payer:** ${actual.payer === undefined ? "not given" : `\`${actual.payer}\``}`);
  lines.push(`- **Vendor set:** ${actual.vendors.map((v) => `\`${v}\``).join(", ")}`);
  lines.push(`- **First-contact order:** ${actual.firstContactOrder.map((v, i) => `${i + 1}. \`${v}\``).join(", ")}`);
  lines.push(`- **Cumulative spend per vendor:** ${actual.vendors.map((v) => `\`${v}\`: ${actual.spendPerVendor[v] ?? 0n}`).join(", ")}`);
  lines.push(`- **Paid calls:** ${actual.settlementTimes.length}, from ${iso(actual.settlementTimes[0])} to ${iso(actual.settlementTimes.at(-1))}`);
  return lines.join("\n");
}

function iso(seconds: number | undefined): string {
  return seconds === undefined ? "—" : new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function section(run: RailRun, h: Headline): string[] {
  const lines: string[] = [];
  lines.push(`## ${railName(run.rail)}`, "");
  lines.push(run.provenance, "");
  lines.push(`**Base-layer transactions per call: ${h.railTransactions} / ${h.calls} = ${h.perCall}**`, "");
  lines.push(`**Vendors recovered / actual: ${h.comparison.vendorsRecovered} / ${h.comparison.vendorsActual}**`, "");
  if (run.setup.length > 0) {
    lines.push("Setup in the window, outside the rail and not counted above:", "");
    for (const s of run.setup) lines.push(`- \`${s.signature}\`: ${s.what}`);
    lines.push("");
  }
  lines.push("### The observer table", "");
  lines.push(`Signatures: ${run.report.counts.signatures}; on the base layer: ${run.report.counts.onBaseLayer}; not on the base layer: ${run.report.counts.notOnBaseLayer}. ${run.rail === "wakeless" ? `Four checks: ${run.report.failures.length === 0 ? "every signature passes" : `${run.report.failures.length} failed`}.` : "The four checks are information on this rail: it is expected to fail them."}`, "");
  // The table numbers its rows; labels that arrive numbered (`watcherReport()` in the e2e helper) lose theirs.
  lines.push(renderMarkdownTable({ ...run.report, rows: run.report.rows.map((r) => ({ ...r, label: r.label.replace(/^\d+\. /, "") })) }), "");
  lines.push("### What the observer rebuilt, next to what the owner did", "");
  lines.push("What `reconstruct()` rebuilt from the signatures above and nothing else:", "", renderTrajectory(run.rebuilt), "");
  lines.push("The owner's actual trajectory:", "", actualBlock(run.actual), "");
  lines.push("`compare()`:", "", renderComparison(h.comparison), "");
  if (run.ownerView !== undefined) {
    lines.push("### The owner table", "", run.ownerView.trimEnd(), "");
  }
  return lines;
}

export interface SideBySideInput {
  readonly date: string;
  readonly workload: string;
  readonly publicRail: RailRun;
  readonly wakeless: RailRun;
  /** Set when the public examples could not be driven and the run fell back to `docs/public-rail-log.md`. */
  readonly publicFallback?: string;
}

function shortAddress(a: Address | string): string {
  return `${a.slice(0, 4)}…${a.slice(-4)}`;
}

/** The plain-English paragraph: the difference, what the base layer shows for Wakeless, what remains, the trust boundary. */
export function differenceParagraph(input: SideBySideInput): string {
  const p = headlineOf(input.publicRail);
  const w = headlineOf(input.wakeless);
  const edges = input.wakeless.rebuilt.edges;
  const vault =
    edges.length === 0
      ? "nothing from the run, and no vault deposit or withdrawal by any party landed in the window"
      : `nothing from the run beyond ${edges.length} vault ${edges.length === 1 ? "edge" : "edges"} (${edges.map((e) => `${e.amount} from \`${shortAddress(e.from)}\` to \`${shortAddress(e.to)}\``).join("; ")})`;
  const recoverable =
    w.comparison.vendorsRecovered === 0 && w.comparison.spendRecoveredBps === 0
      ? `What remains recoverable is the edge of the pool, not the relationship: a vault deposit, when the buyer makes one, names the buyer and an amount going in, and a vault withdrawal names a vendor and an amount coming out, but nothing on the ledger joins the two, so the observer rebuilt ${w.comparison.vendorsRecovered} of ${w.comparison.vendorsActual} vendors and ${pct(w.comparison.spendRecoveredBps)} of the spend; with one buyer and few vendors in the pool, timing and amounts at those edges are the residual risk.`
      : `The observer recovered ${w.comparison.vendorsRecovered} of ${w.comparison.vendorsActual} vendors and ${pct(w.comparison.spendRecoveredBps)} of the spend from the Wakeless signatures, which is a failure of the rail and is reported as one.`;
  return [
    `The same workload put ${p.railTransactions} transactions on the base layer through the public rail (${p.perCall} per call) and ${w.railTransactions} through Wakeless (${w.perCall} per call); from the public rail's transactions alone an observer rebuilt ${p.comparison.vendorsRecovered} of ${p.comparison.vendorsActual} vendors, ${pct(p.comparison.spendRecoveredBps)} of the spend and the order of first contact${p.comparison.orderRecovered ? "" : " (not the order)"}, because the open names the payer and the payTo, the claim carries the voucher's cumulative amount in clear, and the payout names the recipient.`,
    w.railTransactions === 0
      ? `For Wakeless the base layer shows vault deposits and withdrawals only, and the run itself added none: every deposit and every redemption the enclave accepted was a private transfer inside MagicBlock's Private Ephemeral Rollup, and a redemption it refused moved nothing, so the ledger holds ${vault}.`
      : `For Wakeless the base layer should show vault deposits and withdrawals only, but this run put ${w.railTransactions} rail transactions there, which is a failure of the rail and is reported as one.`,
    recoverable,
    "The privacy claim is against the public ledger, not against the operators: the facilitator sees the vouchers and the channels, MagicBlock's enclave sees the private transfers, and NEAR's private shard sees a funding's origin and route when a channel is funded through Aurora; each of the three sees inside, and none of what they see reaches the ledger.",
  ].join(" ");
}

export function renderSideBySide(input: SideBySideInput): string {
  const p = headlineOf(input.publicRail);
  const w = headlineOf(input.wakeless);
  const lines: string[] = [];
  lines.push("# Side by side: the same agent workload on both rails", "");
  lines.push(`Generated by \`pnpm side-by-side\` on ${input.date} on Solana devnet (\`solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1\`). ${input.workload} Every row below was read back from the devnet ledger with \`getTransaction\` (\`jsonParsed\`) through the watcher's own reader; nothing comes from a facilitator, server or client log. Amounts are USDC base units (6 decimals). JSON: \`docs/side-by-side.json\`.`, "");
  if (input.publicFallback !== undefined) lines.push(`**The public rail was not driven in this run.** ${input.publicFallback} Its numbers below come from the signatures in \`docs/public-rail-log.md\`.`, "");
  lines.push("## Headlines", "");
  lines.push("| | Public `batch-settlement` | Wakeless |");
  lines.push("| --- | ---: | ---: |");
  lines.push(`| Base-layer transactions per call | ${p.railTransactions} / ${p.calls} = ${p.perCall} | ${w.railTransactions} / ${w.calls} = ${w.perCall} |`);
  lines.push(`| Vendors recovered / actual | ${p.comparison.vendorsRecovered} / ${p.comparison.vendorsActual} | ${w.comparison.vendorsRecovered} / ${w.comparison.vendorsActual} |`);
  lines.push(`| Spend recovered | ${pct(p.comparison.spendRecoveredBps)} | ${pct(w.comparison.spendRecoveredBps)} |`);
  lines.push(`| First-contact order recovered | ${p.comparison.orderRecovered ? "yes" : "no"} | ${w.comparison.orderRecovered ? "yes" : "no"} |`);
  lines.push("");
  lines.push("Sample size: one run per rail, one payer, three vendors, the call counts above. The public rail's vendors are its own payTo keys and the Wakeless vendors are the three synthetic vendors; the two payers are different keys, so neither run's history leaks into the other's reconstruction.", "");
  lines.push("## The difference", "", differenceParagraph(input), "");
  lines.push(...section(input.publicRail, p), ...section(input.wakeless, w));
  lines.push("## Reproduce", "");
  lines.push("`https://explorer.solana.com/tx/<signature>?cluster=devnet`. Payment-channels program `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` ([explorer](https://explorer.solana.com/address/CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX?cluster=devnet)), decoded with the layouts of its codama IDL. Devnet history is pruned over time; `docs/side-by-side.json` keeps what the observer read.", "");
  return lines.join("\n");
}

function railJson(run: RailRun): unknown {
  const h = headlineOf(run);
  return {
    rail: run.rail,
    title: run.title,
    calls: run.calls,
    railTransactions: run.railTransactions,
    transactionsPerCall: h.perCall,
    comparison: h.comparison,
    setup: run.setup,
    observer: JSON.parse(reportToJson(run.report)) as unknown,
    rebuilt: JSON.parse(trajectoryToJson(run.rebuilt)) as unknown,
    actual: JSON.parse(trajectoryToJson(run.actual)) as unknown,
  };
}

export function sideBySideJson(input: SideBySideInput): string {
  return JSON.stringify({ date: input.date, workload: input.workload, ...(input.publicFallback === undefined ? {} : { publicFallback: input.publicFallback }), public: railJson(input.publicRail), wakeless: railJson(input.wakeless) }, null, 2) + "\n";
}

/** The script's two asserted titles, each with what failed; empty lists pass. */
export function verdicts(input: SideBySideInput): { title: string; failures: string[] }[] {
  const p = headlineOf(input.publicRail);
  const w = headlineOf(input.wakeless);
  const leaks: string[] = [];
  if (w.railTransactions !== 0) leaks.push(`Wakeless put ${w.railTransactions} transactions on the base layer`);
  if (input.wakeless.report.failures.length > 0) leaks.push(`${input.wakeless.report.failures.length} watcher check(s) failed on Wakeless`);
  if (w.comparison.spendRecoveredBps !== 0) leaks.push(`Wakeless spend recovered ${pct(w.comparison.spendRecoveredBps)}`);
  if (p.railTransactions === 0) leaks.push("the public rail put nothing on the base layer");
  if (p.comparison.spendRecoveredBps === 0) leaks.push("the public rail leaked no spend");
  const recovers: string[] = [];
  if (p.comparison.vendorsActual === 0 || p.comparison.vendorsRecovered !== p.comparison.vendorsActual) recovers.push(`public rail recovered ${p.comparison.vendorsRecovered} / ${p.comparison.vendorsActual} vendors`);
  if (w.comparison.vendorsRecovered !== 0) recovers.push(`Wakeless recovered ${w.comparison.vendorsRecovered} / ${w.comparison.vendorsActual} vendors`);
  return [
    { title: "side-by-side: Wakeless leaks zero and the public rail leaks more than zero", failures: leaks },
    { title: "side-by-side: compare recovers every vendor on the public rail and none on Wakeless", failures: recovers },
  ];
}
