// Publishing the leak (task 11.3): the snapshot JSON and `docs/LEAKAGE.md`. This is the
// boundary where every address and signature is truncated to its first four and last four
// characters; the program id alone stays in full, with an explorer link, so a judge can
// reproduce the numbers. Aggregates and structure, never a directory (CLAUDE.md, Leakage
// dashboard). Every headline figure is printed beside its sample size.
import type { Address } from "@solana/kit";
import type { Reconstruction } from "../reconstruct.js";
import type { LeakAggregate } from "./aggregate.js";
import { SNAPSHOT_SCHEMA, type LeakSnapshot, type SnapshotSample, type SnapshotSettled, type SnapshotTrajectory, type SnapshotX402scan } from "./snapshot.schema.js";

export const PROGRAM_ID = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX";
export const EXPLORER_URL = `https://explorer.solana.com/address/${PROGRAM_ID}`;
const USDC_MINT = "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v";

/** `AbCd…WxYz`. Anything shorter than nine characters is returned whole: it is not an address. */
export function shorten(value: string): string {
  return value.length < 9 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

export interface SnapshotMeta {
  readonly date: string;
  readonly rpcHost: string;
  readonly sample: SnapshotSample;
  readonly x402scan: SnapshotX402scan;
}

export interface SampleTrajectory {
  readonly payer: Address;
  readonly channels: number;
  readonly rebuilt: Reconstruction;
}

function settledOf(agg: LeakAggregate): SnapshotSettled {
  const mint: Address | null = agg.settled.mint;
  return {
    unit: mint === null ? null : mint === USDC_MINT ? "USDC" : shorten(mint),
    decimals: mint === null ? null : mint === USDC_MINT ? 6 : null,
    channelsWithSettlement: agg.settled.channelsWithSettlement,
    channelsWithoutSettlement: agg.settled.channelsWithoutSettlement,
    total: agg.settled.total.toString(),
    median: agg.settled.median.toString(),
    max: agg.settled.max.toString(),
    channelsInOtherMints: agg.settled.channelsInOtherMints,
    channelsWithUnknownMint: agg.settled.channelsWithUnknownMint,
  };
}

function trajectoryOf(sample: SampleTrajectory | null): SnapshotTrajectory | null {
  if (sample === null) return null;
  const t = sample.rebuilt;
  const spendPerVendor: Record<string, string> = {};
  for (const [vendor, amount] of Object.entries(t.spendPerVendor)) spendPerVendor[shorten(vendor)] = amount.toString();
  return {
    payer: shorten(sample.payer),
    channels: sample.channels,
    vendors: t.vendors.map(shorten),
    firstContactOrder: t.firstContactOrder.map(shorten),
    spendPerVendor,
    settlementTimes: [...t.settlementTimes],
    edges: t.edges.length,
  };
}

/** The snapshot, truncated. Only the program id is a full address. */
export function buildSnapshot(agg: LeakAggregate, meta: SnapshotMeta, sample: SampleTrajectory | null): LeakSnapshot {
  return {
    schema: SNAPSHOT_SCHEMA,
    date: meta.date,
    program: { id: PROGRAM_ID, explorer: EXPLORER_URL },
    rpcHost: meta.rpcHost,
    sample: meta.sample,
    headline: {
      channels: agg.channels.length,
      payers: agg.payers.length,
      payTo: agg.payTo.length,
      relationships: agg.relationships,
      payersWithTwoOrMorePayTo: agg.payersWithTwoOrMorePayTo,
      signaturesScanned: meta.sample.signaturesScanned,
    },
    channelsPerPayer: { median: agg.channelsPerPayer.median, max: agg.channelsPerPayer.max, payers: agg.payers.length },
    payToDegree: agg.payToDegree.slice(0, 10).map((d) => ({ payTo: shorten(d.payTo), payers: d.payers, channels: d.channels })),
    payeeSeats: agg.payeeSeats,
    settled: settledOf(agg),
    channelsPerWeek: agg.channelsPerWeek.map((w) => ({ week: w.week, channels: w.channels })),
    instructions: { ...agg.instructions },
    channelsWithFeeRecipient: agg.channelsWithFeeRecipient,
    sampleTrajectory: trajectoryOf(sample),
    x402scan: meta.x402scan,
  };
}

export function snapshotToJson(snapshot: LeakSnapshot): string {
  return JSON.stringify(snapshot, null, 2) + "\n";
}

// ----------------------------------------------------------------------------- markdown

const n = (v: number): string => v.toLocaleString("en-US");

function units(base: string, settled: SnapshotSettled): string {
  if (settled.unit === null) return base;
  if (settled.decimals === null) return `${base} base units of ${settled.unit}`;
  const value = BigInt(base);
  const scale = 10n ** BigInt(settled.decimals);
  const whole = value / scale;
  const frac = (value % scale).toString().padStart(settled.decimals, "0").replace(/0+$/, "");
  return `${whole.toLocaleString("en-US")}${frac === "" ? "" : `.${frac}`} ${settled.unit}`;
}

function day(iso: string | null): string {
  if (iso === null) return "unknown";
  return new Date(iso).toLocaleDateString("en-GB", { day: "numeric", month: "short", year: "numeric", timeZone: "UTC" });
}

function time(unixSeconds: number): string {
  return new Date(unixSeconds * 1000).toISOString().replace(".000Z", "Z");
}

/** The sentence that follows every headline figure. */
export function sampleSentence(s: SnapshotSample): string {
  const window = s.oldest === null || s.newest === null ? "" : `, ${day(s.oldest)} to ${day(s.newest)}`;
  return `of ${n(s.signaturesScanned)} signatures scanned${window}`;
}

function trajectorySection(t: SnapshotTrajectory | null, s: SnapshotSample): string[] {
  const lines = ["## One payer's trajectory, as the ledger shows it", ""];
  if (t === null) {
    lines.push(`No payer in the sample (${n(s.signaturesScanned)} signatures scanned) has three or more distinct payTo, so there is no trajectory to show. The structure above is the leak; a payer with three vendors would show as three public pairs, with a running total on each.`, "");
    return lines;
  }
  lines.push(
    `The payer in the sample with the most distinct payTo, rebuilt by \`reconstruct()\` from its ${n(t.channels)} channels' signatures and nothing else (the same function the side-by-side runs on devnet). Addresses truncated; the vendor set is what the distributions list (every payTo and any fee recipient), spend is the voucher's cumulative amount or the payout per recipient, in base units of each channel's mint.`,
    "",
    `- **Payer:** \`${t.payer}\``,
    `- **Vendor set:** ${t.vendors.length === 0 ? "none recovered" : t.vendors.map((v) => `\`${v}\``).join(", ")}`,
    `- **First-contact order:** ${t.firstContactOrder.length === 0 ? "none recovered" : t.firstContactOrder.map((v, i) => `${i + 1}. \`${v}\``).join(", ")}`,
    `- **Cumulative spend per vendor:** ${t.vendors.length === 0 ? "none recovered" : t.vendors.map((v) => `\`${v}\`: ${t.spendPerVendor[v] ?? "0"}`).join(", ")}`,
    `- **Settlements the ledger shows:** ${t.settlementTimes.length === 0 ? "none" : `${n(t.settlementTimes.length)}, from ${time(t.settlementTimes[0]!)} to ${time(t.settlementTimes.at(-1)!)}`}`,
    `- **Token transfers unlinked to this payer:** ${n(t.edges)}`,
    "",
  );
  return lines;
}

export function renderLeakage(snap: LeakSnapshot): string {
  const s = snap.sample;
  const h = snap.headline;
  const sample = sampleSentence(s);
  const lines: string[] = [];
  lines.push("# What the ledger already knows", "");
  lines.push(
    `Snapshot **${snap.date}**, generated by \`pnpm leak:index\` from the mainnet payment-channels program [\`${snap.program.id}\`](${snap.program.explorer}), read-only through \`${snap.rpcHost}\` (\`getSignaturesForAddress\`, \`getTransaction\`; no keypair loaded, nothing spent). Instructions decoded with the program's codama IDL (\`vendor/payment-channels\`, program 0.1.0): \`open\`, \`settle\`, \`settleAndSeal\`, \`topUp\`, \`requestClose\`, \`seal\`, \`distribute\`, \`withdrawPayer\` (the payer's refund) and \`reclaim\`. JSON: \`docs/leak/snapshot-${snap.date}.json\`.`,
    "",
    `**Sample:** ${n(s.signaturesScanned)} signatures scanned (cap ${n(s.signaturesCap)}${s.since === null ? ", the program's whole history" : `, since ${s.since}`}), block times ${day(s.oldest)} to ${day(s.newest)}; ${n(s.transactionsFetched)} transactions read, ${n(s.transactionsFailed)} of them failed on chain and counted for nothing. ${s.channelsWithoutOpen === 0 ? "Every channel's `open` is inside the window." : `${n(s.channelsWithoutOpen)} channels were seen only through later instructions; their \`open\` is older than the window.`} This is the public \`batch-settlement\` scheme as one facilitator runs it in preview; the numbers are the structure of the leak at this size, not a forecast.`,
    "",
    "Every address below is truncated to its first four and last four characters; the program id is the only full address. Aggregates and structure, not a directory of who pays whom.",
    "",
    `**payTo** is the recipient with the largest share in the distribution the \`open\` fixes (the x402 \`payTo\`). The program's \`payee\` seat is not the vendor: the x402 SVM profile puts the facilitator's sponsor key there with a zero share (\`vendor/x402/specs/schemes/upto/scheme_upto_svm.md\`), and the sample shows ${n(snap.payeeSeats)} distinct payee seats across ${n(h.channels)} channels, almost none of them a recipient.`,
    "",
  );
  lines.push("## Headline", "", "| Figure | Value | Sample |", "| --- | --- | --- |");
  lines.push(`| Channels the ledger names | **${n(h.channels)}** | ${sample} |`);
  lines.push(`| Distinct payers | **${n(h.payers)}** | ${sample} |`);
  lines.push(`| Distinct payTo | **${n(h.payTo)}** | ${sample} |`);
  lines.push(`| Public (payer, payTo) relationships | **${n(h.relationships)}** | ${sample} |`);
  lines.push(`| Payers with two or more distinct payTo | **${n(h.payersWithTwoOrMorePayTo)}** | ${sample} |`);
  lines.push(`| Channels per payer, median / max | **${n(snap.channelsPerPayer.median)}** / **${n(snap.channelsPerPayer.max)}** | ${sample}; ${n(snap.channelsPerPayer.payers)} payers |`);
  lines.push(`| Settled per channel, total / median | **${units(snap.settled.total, snap.settled)}** / **${units(snap.settled.median, snap.settled)}** | ${sample}; ${n(snap.settled.channelsWithSettlement)} channels in ${snap.settled.unit ?? "the main mint"} with a readable settlement, ${n(snap.settled.channelsWithoutSettlement)} without |`);
  lines.push("");
  lines.push(`A payer with two or more distinct payTo is an agent whose vendor set is readable today: each pair is a channel account naming payer and payee, with a running total updated by every settle. ${h.payersWithTwoOrMorePayTo === 0 ? "In this sample there is none yet; the structure is the same at any size." : `In this sample that is ${n(h.payersWithTwoOrMorePayTo)} of ${n(h.payers)} payers.`}`, "");

  lines.push("## payTo by number of distinct payers (top 10)", "");
  if (snap.payToDegree.length === 0) lines.push(`No payTo in the sample (${sample}).`, "");
  else {
    lines.push("| payTo | Distinct payers | Channels |", "| --- | --- | --- |");
    for (const d of snap.payToDegree) lines.push(`| \`${d.payTo}\` | ${n(d.payers)} | ${n(d.channels)} |`);
    lines.push("", `Degree is who the hubs are: a payTo with many payers is a vendor whose customer list is public. Of ${n(h.payTo)} payTo in the sample (${sample}).`, "");
  }

  lines.push("## Settled per channel", "");
  const unit = snap.settled.unit ?? "the main mint";
  lines.push(`Settled is the largest cumulative voucher the ledger verified for the channel (the \`settle\` and \`settleAndSeal\` instructions carry it in the Ed25519 instruction beside them), or the payouts of its \`distribute\` when no voucher was readable. ${snap.settled.unit === null ? "No `open` in the window names a mint." : `The figures cover the channels opened in ${snap.settled.unit}${snap.settled.decimals === null ? " (base units)" : ""}, the mint of most channels; ${n(snap.settled.channelsInOtherMints)} channels in other mints and ${n(snap.settled.channelsWithUnknownMint)} whose mint the window does not show are counted, never summed.`}`, "");
  lines.push("| | Value | Sample |", "| --- | --- | --- |");
  lines.push(`| Total settled | ${units(snap.settled.total, snap.settled)} | ${n(snap.settled.channelsWithSettlement)} channels in ${unit} with a settlement, ${sample} |`);
  lines.push(`| Median settled per channel | ${units(snap.settled.median, snap.settled)} | ${n(snap.settled.channelsWithSettlement)} channels in ${unit} with a settlement, ${sample} |`);
  lines.push(`| Largest settled on one channel | ${units(snap.settled.max, snap.settled)} | ${n(snap.settled.channelsWithSettlement)} channels in ${unit} with a settlement, ${sample} |`);
  lines.push(`| Channels in ${unit} with no readable settlement | ${n(snap.settled.channelsWithoutSettlement)} | ${sample} |`);
  lines.push(`| Channels in other mints / mint unknown | ${n(snap.settled.channelsInOtherMints)} / ${n(snap.settled.channelsWithUnknownMint)} | ${sample} |`);
  lines.push(`| Channels whose distribution names a fee recipient beside the payTo | ${n(snap.channelsWithFeeRecipient)} | ${sample} |`);
  lines.push("");

  lines.push("## Channels opened per week", "");
  if (snap.channelsPerWeek.length === 0) lines.push(`No \`open\` in the window (${sample}).`, "");
  else {
    lines.push("| Week of (Monday) | Channels opened |", "| --- | --- |");
    for (const w of snap.channelsPerWeek) lines.push(`| ${w.week} | ${n(w.channels)} |`);
    lines.push("", `${n(snap.channelsPerWeek.reduce((a, w) => a + w.channels, 0))} channels opened inside the window (${sample}).`, "");
  }

  lines.push("## Instructions seen", "", "| Instruction | Count |", "| --- | --- |");
  for (const [kind, count] of Object.entries(snap.instructions)) lines.push(`| \`${kind}\` | ${n(count)} |`);
  lines.push("", `${sample}. A settle per voucher is the shape of the public rail: one base-layer transaction per settlement, each naming the channel.`, "");

  lines.push(...trajectorySection(snap.sampleTrajectory, s));

  lines.push("## The `exact` scheme", "");
  if (snap.x402scan.exactTransfers === null) lines.push(`The \`exact\` scheme pays each call with a direct token transfer, which names payer, payTo and amount in one instruction; it is the larger leak. This snapshot carries no row for it: ${snap.x402scan.note} Source checked: ${snap.x402scan.source}.`, "");
  else lines.push("| Scheme | Per-call transfers on Solana | Source |", "| --- | --- | --- |", `| \`exact\` | ${n(snap.x402scan.exactTransfers)} | ${snap.x402scan.source} |`, "", snap.x402scan.note, "");

  lines.push("## What Wakeless changes, and what it does not", "");
  lines.push("A Wakeless channel puts none of this on the ledger: no channel account naming payer and payee, no voucher amount in an Ed25519 instruction, no payout per recipient. The watcher's `reconstruct()` recovers no vendor and no spend from a Wakeless run (`docs/WATCHER.md`, `docs/side-by-side.md`). The privacy claim is against the public ledger. Three operators see inside: the facilitator (vouchers), MagicBlock's enclave (private transfers) and NEAR's private shard (funding origin and route).", "");

  lines.push("## Reproduce", "");
  lines.push(`\`pnpm leak:index\` with \`HELIUS_API_KEY\` in \`.env\` (\`LEAK_MAX_SIGNATURES\`, default 20000; \`LEAK_SINCE\`, an ISO date, default the whole history). Program [\`${snap.program.id}\`](${snap.program.explorer}); IDL at \`vendor/payment-channels/program/payment_channels/idl/payment_channels.json\` (a clone of solana-foundation/payment-channels). The indexer stores nothing outside \`docs/leak/\`.`, "");
  return lines.join("\n");
}
