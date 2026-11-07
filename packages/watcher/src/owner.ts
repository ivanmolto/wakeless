// The owner's view (task 9.2): what only the buyer holds. Its local trajectory of paid
// requests (`getTrajectory()` of `@wakeless/client`, or the channel file it reads), the
// channels it holds with their refunds and withdrawals, its private balance as read
// through the attested TEE RPC, and the fundings it made through Aurora. Rendered as a
// markdown block, and exported as the `Trajectory` reconstruct() produces, so compare()
// can measure what an observer recovered against what actually happened.
//
// The rail exposes the current private balance only (`GET /v1/spl/private-balance`); it
// keeps no history the owner can read. The balance history here is the readings the owner
// took (before a run, after it, now), each with its time, never an interpolation.
//
// The input types are structural: the watcher audits the client and the bindings, so it
// imports neither. A `WakelessFetch` is a `TrajectorySource`; a buyer rail is a
// `PrivateBalanceSource`. Everything read is parsed as untrusted data.
import { isAddress, type Address } from "@solana/kit";
import type { Trajectory } from "./reconstruct.js";

/** A funding through Aurora Confidential Intents, as the client records it. */
export interface OwnerFundingSource {
  readonly originChain: string;
  readonly amount: string;
  readonly solanaArrivalSignature: string;
}

/** One trajectory entry, as `getTrajectory()` returns it. Amounts are decimal u64 strings in base units. */
export interface OwnerEntry {
  readonly vendor: string;
  readonly route: string;
  /** What the vendor nets. */
  readonly amount: string;
  /** The channel's cumulative after this request, fee shares included. */
  readonly cumulative: string;
  /** ISO 8601. */
  readonly timestamp: string;
  readonly fundingSource?: string | OwnerFundingSource;
  readonly deposit?: string;
  readonly depositSignature?: string;
}

/** The parts of a local channel record the owner's view reads. */
export interface OwnerChannel {
  readonly buyer: string;
  readonly vendor: string;
  readonly channelId: string;
  readonly deposit: string;
  readonly accepted: string;
  readonly close?: {
    readonly state: "closing" | "closed";
    readonly refund?: { readonly amount: string; readonly signature: string | null; readonly confirmedAt: string };
    readonly withdraw?: { readonly performed?: { readonly amount: string; readonly signature: string; readonly at: string } };
  };
}

/** One reading of the buyer's private balance through the attested TEE RPC. */
export interface BalanceSample {
  /** ISO 8601. */
  readonly at: string;
  readonly balance: bigint;
  readonly label: string;
}

export interface OwnerInput {
  readonly payer?: Address;
  readonly trajectory: readonly OwnerEntry[];
  readonly channels: readonly OwnerChannel[];
  readonly balances: readonly BalanceSample[];
}

export interface TrajectorySource {
  getTrajectory(): readonly unknown[];
}

export interface PrivateBalanceSource {
  privateBalance(): Promise<bigint>;
}

export class OwnerDataError extends Error {
  constructor(detail: string) {
    super(`owner data: ${detail}`);
    this.name = "OwnerDataError";
  }
}

/** The vendor and route a funding entry carries (`wakeless fund`, task 8.3). */
export const FUNDING_VENDOR = "aurora";
export const FUNDING_ROUTE = "fund";

// ----------------------------------------------------------------------------- parsing

const U64 = /^(0|[1-9][0-9]*)$/;
const U64_MAX = 2n ** 64n - 1n;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function u64(value: unknown, field: string): string {
  if (typeof value !== "string" || !U64.test(value) || BigInt(value) > U64_MAX) throw new OwnerDataError(`${field} is not a decimal u64 string`);
  return value;
}

function text(value: unknown, field: string): string {
  if (typeof value !== "string") throw new OwnerDataError(`${field} is not a string`);
  return value;
}

function time(value: unknown, field: string): string {
  if (typeof value !== "string" || Number.isNaN(Date.parse(value))) throw new OwnerDataError(`${field} is not a time`);
  return value;
}

function isFunding(entry: OwnerEntry): boolean {
  return entry.vendor === FUNDING_VENDOR && entry.route === FUNDING_ROUTE;
}

function fundingSource(value: unknown, field: string): string | OwnerFundingSource {
  if (typeof value === "string") return value;
  if (!isRecord(value)) throw new OwnerDataError(`${field} is neither a string nor a funding record`);
  return { originChain: text(value.originChain, `${field}.originChain`), amount: u64(value.amount, `${field}.amount`), solanaArrivalSignature: text(value.solanaArrivalSignature, `${field}.solanaArrivalSignature`) };
}

function entry(value: unknown, field: string): OwnerEntry {
  if (!isRecord(value)) throw new OwnerDataError(`${field} is not an object`);
  const parsed: OwnerEntry = {
    vendor: text(value.vendor, `${field}.vendor`),
    route: text(value.route, `${field}.route`),
    amount: u64(value.amount, `${field}.amount`),
    cumulative: u64(value.cumulative, `${field}.cumulative`),
    timestamp: time(value.timestamp, `${field}.timestamp`),
    ...(value.fundingSource === undefined ? {} : { fundingSource: fundingSource(value.fundingSource, `${field}.fundingSource`) }),
    ...(value.deposit === undefined ? {} : { deposit: u64(value.deposit, `${field}.deposit`) }),
    ...(value.depositSignature === undefined ? {} : { depositSignature: text(value.depositSignature, `${field}.depositSignature`) }),
  };
  if (!isFunding(parsed) && !isAddress(parsed.vendor)) throw new OwnerDataError(`${field}.vendor is not an address`);
  if (parsed.depositSignature !== undefined && parsed.deposit === undefined) throw new OwnerDataError(`${field}.depositSignature without a deposit`);
  return parsed;
}

/** A trajectory as `getTrajectory()` returns it, or as `docs/runs/*-trajectory.json` publishes it. */
export function parseOwnerTrajectory(json: unknown): OwnerEntry[] {
  if (!Array.isArray(json)) throw new OwnerDataError("trajectory is not an array");
  return json.map((value, i) => entry(value, `trajectory[${i}]`));
}

function channel(value: unknown, field: string): OwnerChannel {
  if (!isRecord(value)) throw new OwnerDataError(`${field} is not an object`);
  let close: OwnerChannel["close"];
  if (value.close !== undefined && value.close !== null) {
    const c = value.close;
    if (!isRecord(c) || (c.state !== "closing" && c.state !== "closed")) throw new OwnerDataError(`${field}.close is not a close record`);
    let refund: NonNullable<OwnerChannel["close"]>["refund"];
    if (c.refund !== undefined) {
      if (!isRecord(c.refund)) throw new OwnerDataError(`${field}.close.refund is not an object`);
      const signature = c.refund.signature;
      if (signature !== null && typeof signature !== "string") throw new OwnerDataError(`${field}.close.refund.signature is neither a string nor null`);
      refund = { amount: u64(c.refund.amount, `${field}.close.refund.amount`), signature, confirmedAt: time(c.refund.confirmedAt, `${field}.close.refund.confirmedAt`) };
    }
    let withdraw: NonNullable<OwnerChannel["close"]>["withdraw"];
    if (c.withdraw !== undefined) {
      if (!isRecord(c.withdraw)) throw new OwnerDataError(`${field}.close.withdraw is not an object`);
      const p = c.withdraw.performed;
      if (p !== undefined && !isRecord(p)) throw new OwnerDataError(`${field}.close.withdraw.performed is not an object`);
      withdraw = p === undefined ? {} : { performed: { amount: u64(p.amount, `${field}.close.withdraw.performed.amount`), signature: text(p.signature, `${field}.close.withdraw.performed.signature`), at: time(p.at, `${field}.close.withdraw.performed.at`) } };
    }
    close = { state: c.state, ...(refund === undefined ? {} : { refund }), ...(withdraw === undefined ? {} : { withdraw }) };
  }
  return {
    buyer: text(value.buyer, `${field}.buyer`),
    vendor: text(value.vendor, `${field}.vendor`),
    channelId: text(value.channelId, `${field}.channelId`),
    deposit: u64(value.deposit, `${field}.deposit`),
    accepted: u64(value.accepted, `${field}.accepted`),
    ...(close === undefined ? {} : { close }),
  };
}

/**
 * The owner's channel file (`~/.wakeless/channels.json`, `LocalChannelStore`): its
 * trajectory and its channels, those of `buyer` only when given.
 */
export function parseOwnerChannelFile(json: unknown, buyer?: string): { trajectory: OwnerEntry[]; channels: OwnerChannel[] } {
  if (!isRecord(json) || json.version !== 1 || !isRecord(json.channels)) throw new OwnerDataError("not a version 1 channel file");
  const channels = Object.entries(json.channels).map(([key, value]) => channel(value, `channels.${key}`));
  return { trajectory: parseOwnerTrajectory(json.trajectory), channels: buyer === undefined ? channels : channels.filter((c) => c.buyer === buyer) };
}

/**
 * Reads the owner's view from the live objects: the wrapper's `getTrajectory()`, and one
 * reading of the private balance now, appended to the readings the owner kept.
 */
export async function readOwnerView(sources: {
  readonly trajectory: TrajectorySource;
  readonly balance?: PrivateBalanceSource;
  readonly channels?: readonly unknown[];
  readonly history?: readonly BalanceSample[];
  readonly payer?: Address;
  readonly now?: () => Date;
}): Promise<OwnerInput> {
  const now = sources.now ?? (() => new Date());
  const trajectory = parseOwnerTrajectory(sources.trajectory.getTrajectory());
  const channels = (sources.channels ?? []).map((value, i) => channel(value, `channels[${i}]`));
  const balances = [...(sources.history ?? [])];
  if (sources.balance !== undefined) {
    const balance = await sources.balance.privateBalance();
    balances.push({ at: now().toISOString(), balance, label: "now" });
  }
  return { ...(sources.payer === undefined ? {} : { payer: sources.payer }), trajectory, channels, balances };
}

// ----------------------------------------------------------------------- the trajectory

function paid(input: OwnerInput): OwnerEntry[] {
  return input.trajectory.filter((e) => !isFunding(e));
}

function seconds(iso: string): number {
  return Math.floor(Date.parse(iso) / 1000);
}

/**
 * Spend per vendor, fee shares included: the last cumulative of every channel the vendor
 * was paid through. A cumulative that drops below the one before it starts a new channel
 * (the old one closed). Entries are taken in time order.
 */
function spendOf(entries: readonly OwnerEntry[]): Map<Address, bigint> {
  const total = new Map<Address, bigint>();
  const last = new Map<Address, bigint>();
  for (const e of [...entries].sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp))) {
    const vendor = e.vendor as Address;
    const cumulative = BigInt(e.cumulative);
    const previous = last.get(vendor);
    if (previous !== undefined && cumulative < previous) total.set(vendor, (total.get(vendor) ?? 0n) + previous);
    last.set(vendor, cumulative);
  }
  for (const [vendor, cumulative] of last) total.set(vendor, (total.get(vendor) ?? 0n) + cumulative);
  return total;
}

/**
 * The actual trajectory in the shape reconstruct() returns: the vendors in first-contact
 * order, the spend per vendor (cumulative, fee shares included, which is what a voucher on
 * the public rail would show), and the time of every paid call in Unix seconds (each
 * voucher is settled with its request). Fundings are not vendor spend and are left out.
 */
export function ownerTrajectory(input: OwnerInput): Trajectory {
  const entries = paid(input).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const firstContactOrder = [...new Set(entries.map((e) => e.vendor as Address))];
  const spend = spendOf(entries);
  const spendPerVendor: Record<Address, bigint> = {};
  for (const vendor of firstContactOrder) spendPerVendor[vendor] = spend.get(vendor) ?? 0n;
  return {
    ...(input.payer === undefined ? {} : { payer: input.payer }),
    vendors: firstContactOrder,
    firstContactOrder,
    spendPerVendor,
    settlementTimes: entries.map((e) => seconds(e.timestamp)),
  };
}

// ---------------------------------------------------------------------------- rendering

interface Movement {
  readonly at: string;
  readonly kind: "funding" | "deposit" | "refund" | "withdrawal";
  readonly vendor: string;
  readonly amount: bigint;
  readonly note: string;
}

function short(value: string): string {
  return value.length <= 12 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function utc(iso: string): string {
  return new Date(iso).toISOString().replace(/\.\d{3}Z$/, "Z").replace("T", " ");
}

/** Paid calls keep the milliseconds: several calls a second is the usual pace, and the order the agent paid in is part of the view. */
function utcMs(iso: string): string {
  return new Date(iso).toISOString().replace("T", " ");
}

function usdc(amount: bigint): string {
  const sign = amount < 0n ? "−" : "";
  const abs = amount < 0n ? -amount : amount;
  return `${sign}${abs / 1_000_000n}.${(abs % 1_000_000n).toString().padStart(6, "0")}`;
}

function fundingNote(source: string | OwnerFundingSource): string {
  return typeof source === "string" ? `funded from ${source}` : `from ${source.originChain}, Solana arrival \`${short(source.solanaArrivalSignature)}\``;
}

function movements(input: OwnerInput): Movement[] {
  const list: Movement[] = [];
  for (const e of input.trajectory) {
    if (isFunding(e)) {
      const source = e.fundingSource;
      const amount = typeof source === "object" ? BigInt(source.amount) : BigInt(e.amount);
      list.push({ at: e.timestamp, kind: "funding", vendor: "—", amount, note: source === undefined ? "Aurora Confidential Intents" : `Aurora Confidential Intents, ${fundingNote(source)}; lands on the base layer, not in the private balance` });
    } else if (e.deposit !== undefined) {
      list.push({ at: e.timestamp, kind: "deposit", vendor: `\`${e.vendor}\``, amount: BigInt(e.deposit), note: `private transfer to the escrow, with ${e.route}${e.fundingSource === undefined ? "" : `; ${fundingNote(e.fundingSource)}`}` });
    }
  }
  for (const c of input.channels) {
    const refund = c.close?.refund;
    if (refund !== undefined) list.push({ at: refund.confirmedAt, kind: "refund", vendor: `\`${c.vendor}\``, amount: BigInt(refund.amount), note: refund.signature === null ? "reconciled by the facilitator without a transfer" : "private transfer from the escrow" });
    const withdrawn = c.close?.withdraw?.performed;
    if (withdrawn !== undefined) list.push({ at: withdrawn.at, kind: "withdrawal", vendor: `\`${c.vendor}\``, amount: BigInt(withdrawn.amount), note: "public base-layer transaction: names the buyer and the vault, amount in clear" });
  }
  return list.sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
}

/** How a movement changes the private balance; fundings land on the base layer. */
function balanceEffect(m: Movement): bigint {
  switch (m.kind) {
    case "deposit":
    case "withdrawal":
      return -m.amount;
    case "refund":
      return m.amount;
    case "funding":
      return 0n;
  }
}

/** The owner's view as markdown: paid calls, movements, totals per vendor, private balance readings. */
export function renderOwnerView(input: OwnerInput): string {
  const lines: string[] = [];
  const calls = paid(input).sort((a, b) => Date.parse(a.timestamp) - Date.parse(b.timestamp));
  const moves = movements(input);
  const actual = ownerTrajectory(input);

  lines.push("Amounts are USDC base units (6 decimals). Only the owner holds this view. Inside the rail, the facilitator sees the vouchers and deposits, MagicBlock's enclave sees the private transfers, and NEAR's private shard sees a funding's origin and route; the public ledger shows none of it.");
  lines.push("");
  lines.push(`- **Payer:** ${input.payer === undefined ? "not given" : `\`${input.payer}\``}`);
  lines.push("");

  lines.push("### Paid calls");
  lines.push("");
  if (calls.length === 0) lines.push("None.");
  else {
    lines.push("| # | Time (UTC) | Vendor | Route | Amount | Cumulative |");
    lines.push("| ---: | --- | --- | --- | ---: | ---: |");
    calls.forEach((e, i) => lines.push(`| ${i + 1} | ${utcMs(e.timestamp)} | \`${e.vendor}\` | ${e.route} | ${e.amount} | ${e.cumulative} |`));
  }
  lines.push("");

  lines.push("### Fundings, deposits and refunds");
  lines.push("");
  if (moves.length === 0) lines.push("None.");
  else {
    lines.push("| Time (UTC) | Kind | Vendor | Amount | Note |");
    lines.push("| --- | --- | --- | ---: | --- |");
    for (const m of moves) lines.push(`| ${utc(m.at)} | ${m.kind} | ${m.vendor} | ${m.amount} | ${m.note} |`);
  }
  lines.push("");

  lines.push("### Totals per vendor");
  lines.push("");
  if (actual.vendors.length === 0) lines.push("None.");
  else {
    lines.push("| Vendor | Paid calls | Net to vendor | Spend, fees included | Deposited | Refunded | Unspent in escrow |");
    lines.push("| --- | ---: | ---: | ---: | ---: | ---: | ---: |");
    const sum = { calls: 0, net: 0n, spend: 0n, deposited: 0n, refunded: 0n, unspent: 0n };
    for (const vendor of actual.vendors) {
      const mine = calls.filter((e) => e.vendor === vendor);
      const net = mine.reduce((s, e) => s + BigInt(e.amount), 0n);
      const spend = actual.spendPerVendor[vendor] ?? 0n;
      const deposited = mine.reduce((s, e) => s + (e.deposit === undefined ? 0n : BigInt(e.deposit)), 0n);
      const refunded = moves.filter((m) => m.kind === "refund" && m.vendor === `\`${vendor}\``).reduce((s, m) => s + m.amount, 0n);
      const unspent = deposited - spend - refunded;
      sum.calls += mine.length;
      sum.net += net;
      sum.spend += spend;
      sum.deposited += deposited;
      sum.refunded += refunded;
      sum.unspent += unspent;
      lines.push(`| \`${vendor}\` | ${mine.length} | ${net} | ${spend} | ${deposited} | ${refunded} | ${unspent} |`);
    }
    lines.push(`| **Total** | ${sum.calls} | ${sum.net} | ${sum.spend} | ${sum.deposited} | ${sum.refunded} | ${sum.unspent} |`);
  }
  lines.push("");

  lines.push("### Private balance");
  lines.push("");
  lines.push("Read through the attested TEE RPC. The rail returns the current balance only; these are the readings the owner took.");
  lines.push("");
  const samples = [...input.balances].sort((a, b) => Date.parse(a.at) - Date.parse(b.at));
  if (samples.length === 0) lines.push("No reading.");
  else {
    lines.push("| Time (UTC) | Reading | Balance | USDC |");
    lines.push("| --- | --- | ---: | ---: |");
    for (const s of samples) lines.push(`| ${utc(s.at)} | ${s.label} | ${s.balance} | ${usdc(s.balance)} |`);
    const first = samples[0]!;
    const after = moves.filter((m) => Date.parse(m.at) > Date.parse(first.at));
    const expected = after.reduce((b, m) => b + balanceEffect(m), first.balance);
    const lastMove = after.at(-1);
    lines.push("");
    if (lastMove === undefined) lines.push(`No deposit, refund or withdrawal after the first reading.`);
    else {
      const counted = (kind: Movement["kind"]) => after.filter((m) => m.kind === kind).reduce((s, m) => s + m.amount, 0n);
      lines.push(`Expected after the last movement (${utc(lastMove.at)}): ${first.balance} − deposits ${counted("deposit")} + refunds ${counted("refund")} − withdrawals ${counted("withdrawal")} = **${expected}** (${usdc(expected)} USDC).`);
      const later = samples.filter((s) => Date.parse(s.at) >= Date.parse(lastMove.at)).at(-1);
      if (later !== undefined) lines.push(later.balance === expected ? `The reading at ${utc(later.at)} matches.` : `The reading at ${utc(later.at)} differs by ${later.balance - expected}.`);
      else lines.push("No reading after the last movement to compare with.");
    }
  }
  return lines.join("\n") + "\n";
}
