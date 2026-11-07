// Aggregating decoded payment-channels events into the structure of the leak (task 11.3,
// briefing §5b): how many channels, payers and payTo the public ledger names, who has a
// readable vendor set, who the hubs are, what is settled per relationship, and when channels
// open. Addresses are full here; `publish.ts` truncates everything that leaves the process.
// Pure functions over `ChannelEvent[]`; nothing here reads the network or the clock.
import type { Address, Signature } from "@solana/kit";
import type { ChannelEvent, InstructionKind } from "./decode.js";

export interface ChannelSummary {
  readonly channel: Address;
  readonly payer: Address | null;
  /**
   * The recipient with the most basis points in the distribution the `open` (or a later
   * `distribute`) lists: the x402 `payTo`. The IDL's `payee` seat is not the vendor: the
   * x402 SVM profile puts the facilitator's sponsor key there with a zero share.
   */
  readonly payTo: Address | null;
  /** The IDL's `payee` seat: the facilitator's sponsor key under the x402 profile. */
  readonly payee: Address | null;
  readonly mint: Address | null;
  /** Unix seconds of the `open`, when it is in the window. */
  readonly openedAt: number | null;
  readonly deposit: bigint;
  /** The largest cumulative voucher the ledger verified for the channel, or the payouts when no voucher was readable. */
  readonly settled: bigint;
  readonly paidOut: bigint;
  readonly refunded: bigint;
  readonly sealed: boolean;
  /** Distinct recipients the distribution names: the payTo and any fee recipient. */
  readonly recipients: readonly Address[];
  readonly signatures: readonly Signature[];
}

export interface Degree {
  readonly payTo: Address;
  readonly payers: number;
  readonly channels: number;
}

export interface WeekCount {
  /** The Monday of the ISO week, as a date. */
  readonly week: string;
  readonly channels: number;
}

export interface LeakAggregate {
  readonly channels: readonly ChannelSummary[];
  /** Channels whose `open` is in the window. */
  readonly channelsOpened: number;
  /** Channels seen only through later instructions; their open is older than the window. */
  readonly channelsWithoutOpen: number;
  readonly payers: readonly Address[];
  readonly payTo: readonly Address[];
  /** Distinct (payer, payTo) pairs. */
  readonly relationships: number;
  readonly payersWithTwoOrMorePayTo: number;
  readonly payersWithThreeOrMorePayTo: readonly Address[];
  readonly channelsPerPayer: { readonly median: number; readonly max: number };
  /** Every payTo by the number of distinct payers, most first; ties by channels, then by address. */
  readonly payToDegree: readonly Degree[];
  /** Distinct `payee` seats: facilitator sponsor keys, not vendors. */
  readonly payeeSeats: number;
  /** Settlement figures for the channels of the mint most channels use; other mints are counted, never summed. */
  readonly settled: {
    readonly mint: Address | null;
    readonly channelsWithSettlement: number;
    readonly channelsWithoutSettlement: number;
    readonly total: bigint;
    readonly median: bigint;
    readonly max: bigint;
    readonly channelsInOtherMints: number;
    readonly channelsWithUnknownMint: number;
  };
  readonly channelsPerWeek: readonly WeekCount[];
  readonly instructions: Readonly<Record<InstructionKind, number>>;
  readonly mints: ReadonlyMap<Address, number>;
  /** Channels whose distribution names more than one recipient (a fee recipient beside the payTo). */
  readonly channelsWithFeeRecipient: number;
}

interface Building {
  channel: Address;
  payer: Address | null;
  payee: Address | null;
  mint: Address | null;
  openedAt: number | null;
  deposit: bigint;
  voucher: bigint;
  paidOut: bigint;
  refunded: bigint;
  sealed: boolean;
  recipients: Map<Address, number>;
  signatures: Set<Signature>;
}

const compareBig = (a: bigint, b: bigint): number => (a < b ? -1 : a > b ? 1 : 0);

export function medianOf(values: readonly number[]): number {
  if (values.length === 0) return 0;
  const sorted = [...values].sort((a, b) => a - b);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : Math.floor((sorted[mid - 1]! + sorted[mid]!) / 2);
}

export function medianOfBig(values: readonly bigint[]): bigint {
  if (values.length === 0) return 0n;
  const sorted = [...values].sort(compareBig);
  const mid = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1 ? sorted[mid]! : (sorted[mid - 1]! + sorted[mid]!) / 2n;
}

/** The Monday of the ISO week that holds the Unix time, as `YYYY-MM-DD`. */
export function weekOf(unixSeconds: number): string {
  const d = new Date(unixSeconds * 1000);
  const back = (d.getUTCDay() + 6) % 7;
  d.setUTCDate(d.getUTCDate() - back);
  return d.toISOString().slice(0, 10);
}

function building(map: Map<Address, Building>, channel: Address): Building {
  let b = map.get(channel);
  if (b === undefined) {
    b = { channel, payer: null, payee: null, mint: null, openedAt: null, deposit: 0n, voucher: 0n, paidOut: 0n, refunded: 0n, sealed: false, recipients: new Map(), signatures: new Set() };
    map.set(channel, b);
  }
  return b;
}

function payToOf(b: Building): Address | null {
  let best: Address | null = null;
  let bps = -1;
  for (const [recipient, share] of b.recipients) {
    if (share > bps || (share === bps && best !== null && recipient < best)) {
      best = recipient;
      bps = share;
    }
  }
  return best;
}

export function aggregate(events: readonly ChannelEvent[]): LeakAggregate {
  const map = new Map<Address, Building>();
  const instructions: Record<InstructionKind, number> = { open: 0, settle: 0, topUp: 0, settleAndSeal: 0, requestClose: 0, seal: 0, distribute: 0, withdrawPayer: 0, reclaim: 0 };
  const ordered = [...events].sort((a, b) => (a.slot ?? Number.MAX_SAFE_INTEGER) - (b.slot ?? Number.MAX_SAFE_INTEGER));

  for (const event of ordered) {
    const ix = event.instruction;
    instructions[ix.kind] += 1;
    const b = building(map, ix.channel);
    b.signatures.add(event.signature);
    switch (ix.kind) {
      case "open":
        b.payer = ix.payer;
        b.payee = ix.payee;
        b.mint = ix.mint;
        b.openedAt = event.blockTime;
        b.deposit += ix.deposit;
        for (const e of ix.recipients) b.recipients.set(e.recipient, Math.max(b.recipients.get(e.recipient) ?? 0, e.bps));
        break;
      case "settle":
      case "settleAndSeal":
        if (ix.cumulativeAmount !== null && ix.cumulativeAmount > b.voucher) b.voucher = ix.cumulativeAmount;
        if (ix.kind === "settleAndSeal") {
          b.sealed = true;
          b.payee ??= ix.payee;
        }
        break;
      case "topUp":
        b.payer ??= ix.payer;
        b.deposit += ix.amount;
        break;
      case "requestClose":
        b.payer ??= ix.payer;
        break;
      case "seal":
        b.sealed = true;
        break;
      case "distribute":
        b.payer ??= ix.payer;
        for (const e of ix.recipients) b.recipients.set(e.recipient, Math.max(b.recipients.get(e.recipient) ?? 0, e.bps));
        for (const p of ix.payouts) b.paidOut += p.amount;
        break;
      case "withdrawPayer":
        b.payer ??= ix.payer;
        b.refunded += ix.refunded;
        break;
      case "reclaim":
        break;
    }
  }

  const channels: ChannelSummary[] = [...map.values()]
    .sort((a, b) => (a.channel < b.channel ? -1 : a.channel > b.channel ? 1 : 0))
    .map((b) => ({
      channel: b.channel,
      payer: b.payer,
      payTo: payToOf(b),
      payee: b.payee,
      mint: b.mint,
      openedAt: b.openedAt,
      deposit: b.deposit,
      settled: b.voucher > b.paidOut ? b.voucher : b.paidOut,
      paidOut: b.paidOut,
      refunded: b.refunded,
      sealed: b.sealed,
      recipients: [...b.recipients.keys()].sort(),
      signatures: [...b.signatures],
    }));

  const payers = [...new Set(channels.flatMap((c) => (c.payer === null ? [] : [c.payer])))].sort();
  const payTo = [...new Set(channels.flatMap((c) => (c.payTo === null ? [] : [c.payTo])))].sort();

  const payToByPayer = new Map<Address, Set<Address>>();
  const channelsByPayer = new Map<Address, number>();
  const payersByPayTo = new Map<Address, Set<Address>>();
  const channelsByPayTo = new Map<Address, number>();
  const pairs = new Set<string>();
  for (const c of channels) {
    if (c.payer !== null) channelsByPayer.set(c.payer, (channelsByPayer.get(c.payer) ?? 0) + 1);
    if (c.payTo !== null) channelsByPayTo.set(c.payTo, (channelsByPayTo.get(c.payTo) ?? 0) + 1);
    if (c.payer === null || c.payTo === null) continue;
    pairs.add(`${c.payer}\u0000${c.payTo}`);
    let set = payToByPayer.get(c.payer);
    if (set === undefined) payToByPayer.set(c.payer, (set = new Set()));
    set.add(c.payTo);
    let back = payersByPayTo.get(c.payTo);
    if (back === undefined) payersByPayTo.set(c.payTo, (back = new Set()));
    back.add(c.payer);
  }

  const perPayer = [...channelsByPayer.values()];
  const payToDegree: Degree[] = payTo
    .map((p) => ({ payTo: p, payers: payersByPayTo.get(p)?.size ?? 0, channels: channelsByPayTo.get(p) ?? 0 }))
    .sort((a, b) => b.payers - a.payers || b.channels - a.channels || (a.payTo < b.payTo ? -1 : 1));

  const mints = new Map<Address, number>();
  for (const c of channels) if (c.mint !== null) mints.set(c.mint, (mints.get(c.mint) ?? 0) + 1);
  let dominantMint: Address | null = null;
  let most = 0;
  for (const [m, count] of [...mints.entries()].sort(([a], [b]) => (a < b ? -1 : 1))) {
    if (count > most) {
      dominantMint = m;
      most = count;
    }
  }
  const inMint = channels.filter((c) => c.mint !== null && c.mint === dominantMint);
  const settledValues = inMint.filter((c) => c.settled > 0n).map((c) => c.settled);
  let total = 0n;
  let max = 0n;
  for (const v of settledValues) {
    total += v;
    if (v > max) max = v;
  }

  const weeks = new Map<string, number>();
  for (const c of channels) if (c.openedAt !== null) weeks.set(weekOf(c.openedAt), (weeks.get(weekOf(c.openedAt)) ?? 0) + 1);
  const channelsPerWeek = [...weeks.entries()].sort(([a], [b]) => (a < b ? -1 : 1)).map(([week, count]) => ({ week, channels: count }));

  return {
    channels,
    channelsOpened: channels.filter((c) => c.openedAt !== null).length,
    channelsWithoutOpen: channels.filter((c) => c.openedAt === null).length,
    payers,
    payTo,
    relationships: pairs.size,
    payersWithTwoOrMorePayTo: [...payToByPayer.values()].filter((s) => s.size >= 2).length,
    payersWithThreeOrMorePayTo: [...payToByPayer.entries()]
      .filter(([, s]) => s.size >= 3)
      .sort((a, b) => b[1].size - a[1].size || (a[0] < b[0] ? -1 : 1))
      .map(([p]) => p),
    channelsPerPayer: { median: medianOf(perPayer), max: perPayer.length === 0 ? 0 : Math.max(...perPayer) },
    payToDegree,
    payeeSeats: new Set(channels.flatMap((c) => (c.payee === null ? [] : [c.payee]))).size,
    settled: {
      mint: dominantMint,
      channelsWithSettlement: settledValues.length,
      channelsWithoutSettlement: inMint.length - settledValues.length,
      total,
      median: medianOfBig(settledValues),
      max,
      channelsInOtherMints: channels.filter((c) => c.mint !== null && c.mint !== dominantMint).length,
      channelsWithUnknownMint: channels.filter((c) => c.mint === null).length,
    },
    channelsPerWeek,
    instructions,
    mints,
    channelsWithFeeRecipient: channels.filter((c) => c.recipients.length > 1).length,
  };
}

/**
 * The payer whose trajectory the dashboard shows: the one with the most distinct payTo
 * among those with three or more, ties broken by address so the pick is stable.
 */
export function pickSamplePayer(agg: LeakAggregate): Address | null {
  return agg.payersWithThreeOrMorePayTo[0] ?? null;
}

/** The signatures the ledger shows for a payer's channels, for `reconstruct()`. */
export function signaturesOfPayer(agg: LeakAggregate, payer: Address): Signature[] {
  const set = new Set<Signature>();
  for (const c of agg.channels) if (c.payer === payer) for (const s of c.signatures) set.add(s);
  return [...set];
}
