// Observer reconstruction (task 9.1, briefing §5): from a set of base-layer signatures and
// nothing else, what an unprivileged reader rebuilds of an agent's trajectory. On the public
// rail it decodes the payment-channels program's `open` (payer, recipients, deposit),
// `settle` (the voucher's cumulative amount, from the Ed25519 instruction beside it) and
// `distribute` (the payout per recipient), with the instruction layouts of the program's
// codama IDL (`vendor/payment-channels/program/payment_channels/idl/payment_channels.json`,
// program 0.1.0); and the `exact` scheme's direct transfers. On Wakeless it attempts the
// same from whatever the base layer shows. Token transfers it cannot attribute to a payer
// are returned as `edges`: readable, unlinked. Nothing here is tunable.
import { getBase58Decoder, type Address, type Signature } from "@solana/kit";
import { TOKEN_PROGRAMS, type BaseTransaction, type LedgerInstruction, type TokenTransfer } from "./parse.js";

export const PAYMENT_CHANNELS_PROGRAM = "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX" as Address;
export const ED25519_PROGRAM = "Ed25519SigVerify111111111111111111111111111" as Address;

/** What the owner knows and the observer tries to rebuild. Amounts are base units. */
export interface Trajectory {
  readonly payer?: Address;
  readonly vendors: readonly Address[];
  readonly firstContactOrder: readonly Address[];
  readonly spendPerVendor: Readonly<Record<Address, bigint>>;
  /** Unix seconds of every settlement the ledger shows. */
  readonly settlementTimes: readonly number[];
}

/** A token transfer the ledger shows that links to no payer: what remains readable of Wakeless. */
export interface Edge {
  readonly signature: Signature;
  readonly blockTime: number | null;
  /** The top-level program the transfer ran under. */
  readonly program: Address;
  /** Owners when the balances give them, token accounts otherwise. */
  readonly from: Address;
  readonly to: Address;
  readonly amount: bigint;
  readonly mint?: Address;
}

export interface Reconstruction extends Trajectory {
  readonly edges: readonly Edge[];
}

export interface Comparison {
  readonly vendorsRecovered: number;
  readonly vendorsActual: number;
  /** Basis points of the actual spend the reconstruction recovered, per vendor and capped at the actual. */
  readonly spendRecoveredBps: number;
  readonly orderRecovered: boolean;
}

// ------------------------------------------------------------------- IDL instruction layouts

const DISCRIMINATOR = { open: 1, settle: 2, topUp: 3, settleAndSeal: 4, distribute: 7 } as const;
const OPEN_ACCOUNTS = { payer: 0, channel: 5 } as const;
const SETTLE_ACCOUNTS = { channel: 0 } as const;
const SETTLE_AND_SEAL_ACCOUNTS = { channel: 1 } as const;
const DISTRIBUTE_ACCOUNTS = { channel: 0, payer: 1, channelTokenAccount: 3 } as const;
const VOUCHER_SIZE = 50;
const VOUCHER_MAGIC = 0x56;

export interface DistributionEntry {
  readonly recipient: Address;
  readonly bps: number;
}

class Reader {
  private offset = 0;
  private readonly view: DataView;
  constructor(private readonly bytes: Uint8Array) {
    this.view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
  }
  get remaining(): number {
    return this.bytes.byteLength - this.offset;
  }
  u8(): number {
    if (this.remaining < 1) throw new RangeError("short");
    return this.view.getUint8(this.offset++);
  }
  u16(): number {
    if (this.remaining < 2) throw new RangeError("short");
    const v = this.view.getUint16(this.offset, true);
    this.offset += 2;
    return v;
  }
  u32(): number {
    if (this.remaining < 4) throw new RangeError("short");
    const v = this.view.getUint32(this.offset, true);
    this.offset += 4;
    return v;
  }
  u64(): bigint {
    if (this.remaining < 8) throw new RangeError("short");
    const v = this.view.getBigUint64(this.offset, true);
    this.offset += 8;
    return v;
  }
  pubkey(): Address {
    if (this.remaining < 32) throw new RangeError("short");
    const slice = this.bytes.subarray(this.offset, this.offset + 32);
    this.offset += 32;
    return base58(slice) as Address;
  }
}

function base58(bytes: Uint8Array): string {
  return getBase58Decoder().decode(bytes);
}

function entries(r: Reader): DistributionEntry[] {
  const count = r.u32();
  if (count > 64) throw new RangeError("too many recipients");
  const list: DistributionEntry[] = [];
  for (let i = 0; i < count; i++) list.push({ recipient: r.pubkey(), bps: r.u16() });
  return list;
}

/**
 * `open` arguments, or null when the data is not an `open`. Two layouts: the IDL's (salt,
 * deposit, gracePeriod, openSlot, recipients) and the one the program used before `openSlot`
 * existed (mainnet opens of June and July 2026), which yields `openSlot: null`. Each layout
 * must consume the data exactly, so neither can be read as the other.
 */
export function decodeOpen(data: Uint8Array | null): { salt: bigint; deposit: bigint; gracePeriod: number; openSlot: bigint | null; recipients: DistributionEntry[] } | null {
  if (data === null || data[0] !== DISCRIMINATOR.open) return null;
  try {
    const r = new Reader(data.subarray(1));
    const open = { salt: r.u64(), deposit: r.u64(), gracePeriod: r.u32(), openSlot: r.u64(), recipients: entries(r) };
    if (r.remaining === 0) return open;
  } catch {
    // Not the IDL's layout; try the earlier one.
  }
  try {
    const r = new Reader(data.subarray(1));
    const open = { salt: r.u64(), deposit: r.u64(), gracePeriod: r.u32(), openSlot: null, recipients: entries(r) };
    return r.remaining === 0 ? open : null;
  } catch {
    return null;
  }
}

export function decodeDistribute(data: Uint8Array | null): { recipients: DistributionEntry[] } | null {
  if (data === null || data[0] !== DISCRIMINATOR.distribute) return null;
  try {
    return { recipients: entries(new Reader(data.subarray(1))) };
  } catch {
    return null;
  }
}

export function decodeTopUp(data: Uint8Array | null): { amount: bigint } | null {
  if (data === null || data[0] !== DISCRIMINATOR.topUp) return null;
  try {
    return { amount: new Reader(data.subarray(1)).u64() };
  } catch {
    return null;
  }
}

export interface Voucher {
  readonly channelId: Address;
  readonly cumulativeAmount: bigint;
  readonly expiresAt: bigint;
  /** The key the Ed25519 instruction verifies: the channel's authorized signer. */
  readonly signer: Address | null;
}

/**
 * The vouchers an Ed25519 program instruction verifies, in its own data: the standard's
 * 50-byte message (`0x56 0x01 ‖ channelId ‖ cumulativeAmount u64 ‖ expiresAt i64`).
 * Messages of another size are not vouchers and are skipped.
 */
export function decodeVouchers(data: Uint8Array | null): Voucher[] {
  if (data === null || data.byteLength < 2) return [];
  const vouchers: Voucher[] = [];
  try {
    const r = new Reader(data);
    const count = r.u8();
    r.u8(); // padding
    for (let i = 0; i < count; i++) {
      r.u16(); // signature offset
      r.u16(); // signature instruction index
      const publicKeyOffset = r.u16();
      const publicKeyIndex = r.u16();
      const messageOffset = r.u16();
      const messageSize = r.u16();
      const messageIndex = r.u16();
      if (messageIndex !== 0xffff || messageSize !== VOUCHER_SIZE || messageOffset + messageSize > data.byteLength) continue;
      const message = new Reader(data.subarray(messageOffset, messageOffset + messageSize));
      const magic = message.u8();
      message.u8(); // version
      if (magic !== VOUCHER_MAGIC) continue;
      const channelId = message.pubkey();
      const cumulativeAmount = message.u64();
      const expiresAt = message.u64();
      const signer = publicKeyIndex === 0xffff && publicKeyOffset + 32 <= data.byteLength ? (base58(data.subarray(publicKeyOffset, publicKeyOffset + 32)) as Address) : null;
      vouchers.push({ channelId, cumulativeAmount, expiresAt, signer });
    }
  } catch {
    return vouchers;
  }
  return vouchers;
}

// ------------------------------------------------------------------------- reconstruction

interface ChannelState {
  payer: Address;
  recipients: DistributionEntry[];
  deposit: bigint;
  cumulative: bigint;
  paidOut: Map<Address, bigint>;
}

interface Order {
  slot: number;
  index: number;
}

function orderOf(tx: BaseTransaction, index: number): Order {
  return { slot: tx.slot ?? Number.MAX_SAFE_INTEGER, index };
}

function before(a: Order, b: Order): boolean {
  return a.slot < b.slot || (a.slot === b.slot && a.index < b.index);
}

function ownerOf(tx: BaseTransaction, account: Address): Address {
  return tx.tokenOwners.get(account) ?? account;
}

function topLevelProgram(tx: BaseTransaction, ix: LedgerInstruction | TokenTransfer): Address {
  const outer = tx.instructions.find((i) => !i.inner && i.outerIndex === ix.outerIndex);
  return outer?.programId ?? ("programId" in ix ? ix.programId : ("11111111111111111111111111111111" as Address));
}

/**
 * Rebuilds the trajectory from parsed transactions. Order of input does not matter: the
 * transactions are taken in slot order, then in the order given for equal or unknown slots.
 */
export function reconstruct(transactions: readonly BaseTransaction[]): Reconstruction {
  const sorted = transactions
    .map((tx, index) => ({ tx, order: orderOf(tx, index) }))
    .sort((a, b) => (before(a.order, b.order) ? -1 : before(b.order, a.order) ? 1 : 0));

  const channels = new Map<Address, ChannelState>();
  const firstContact = new Map<Address, Order>();
  const direct = new Map<Address, bigint>();
  const settlementTimes: number[] = [];
  const edges: Edge[] = [];
  let payer: Address | undefined;

  const contact = (vendor: Address, order: Order): void => {
    const seen = firstContact.get(vendor);
    if (seen === undefined || before(order, seen)) firstContact.set(vendor, order);
  };
  const settledAt = (tx: BaseTransaction): void => {
    if (tx.blockTime !== null) settlementTimes.push(tx.blockTime);
  };

  for (const { tx, order } of sorted) {
    if (!tx.onBaseLayer || (tx.err !== null && tx.err !== undefined)) continue;
    const consumed = new Set<TokenTransfer>();
    const channelInstructions = tx.instructions.filter((ix) => ix.programId === PAYMENT_CHANNELS_PROGRAM);
    const vouchers = tx.instructions.filter((ix) => ix.programId === ED25519_PROGRAM && !ix.inner).flatMap((ix) => decodeVouchers(ix.data));

    for (const ix of channelInstructions) {
      const open = decodeOpen(ix.data);
      if (open !== null) {
        const channel = ix.accounts[OPEN_ACCOUNTS.channel];
        const channelPayer = ix.accounts[OPEN_ACCOUNTS.payer];
        if (channel === undefined || channelPayer === undefined) continue;
        channels.set(channel, { payer: channelPayer, recipients: open.recipients, deposit: open.deposit, cumulative: 0n, paidOut: new Map() });
        payer ??= channelPayer;
        for (const entry of open.recipients) contact(entry.recipient, order);
        for (const t of tx.transfers) if (t.outerIndex === ix.outerIndex) consumed.add(t);
        continue;
      }
      const topUp = decodeTopUp(ix.data);
      if (topUp !== null) {
        const state = channels.get(ix.accounts[1] as Address);
        if (state !== undefined) state.deposit += topUp.amount;
        for (const t of tx.transfers) if (t.outerIndex === ix.outerIndex) consumed.add(t);
        continue;
      }
      const discriminator = ix.data?.[0];
      if (discriminator === DISCRIMINATOR.settle || discriminator === DISCRIMINATOR.settleAndSeal) {
        const channel = ix.accounts[discriminator === DISCRIMINATOR.settle ? SETTLE_ACCOUNTS.channel : SETTLE_AND_SEAL_ACCOUNTS.channel];
        const voucher = vouchers.find((v) => v.channelId === channel);
        if (channel === undefined || voucher === undefined) continue;
        const state = channels.get(channel) ?? { payer: voucher.signer ?? channel, recipients: [], deposit: 0n, cumulative: 0n, paidOut: new Map() };
        channels.set(channel, state);
        if (voucher.cumulativeAmount > state.cumulative) state.cumulative = voucher.cumulativeAmount;
        settledAt(tx);
        continue;
      }
      const distribute = decodeDistribute(ix.data);
      if (distribute !== null) {
        const channel = ix.accounts[DISTRIBUTE_ACCOUNTS.channel];
        const channelPayer = ix.accounts[DISTRIBUTE_ACCOUNTS.payer];
        const channelTokenAccount = ix.accounts[DISTRIBUTE_ACCOUNTS.channelTokenAccount];
        if (channel === undefined || channelPayer === undefined) continue;
        const state = channels.get(channel) ?? { payer: channelPayer, recipients: distribute.recipients, deposit: 0n, cumulative: 0n, paidOut: new Map() };
        channels.set(channel, state);
        if (state.recipients.length === 0) state.recipients = distribute.recipients;
        payer ??= channelPayer;
        for (const entry of distribute.recipients) contact(entry.recipient, order);
        const payouts = tx.transfers.filter((t) => t.outerIndex === ix.outerIndex && t.source === channelTokenAccount);
        let total = 0n;
        let attributed = 0n;
        for (const t of payouts) {
          consumed.add(t);
          total += t.amount;
          const owner = ownerOf(tx, t.destination);
          if (distribute.recipients.some((e) => e.recipient === owner)) {
            state.paidOut.set(owner, (state.paidOut.get(owner) ?? 0n) + t.amount);
            attributed += t.amount;
          }
        }
        if (attributed === 0n && total > 0n) {
          for (const entry of distribute.recipients) state.paidOut.set(entry.recipient, (state.paidOut.get(entry.recipient) ?? 0n) + (total * BigInt(entry.bps)) / 10_000n);
        }
        continue;
      }
      // Other instructions (requestClose, seal, withdrawPayer, reclaim, emitEvent) move no vendor spend.
    }
    if (channelInstructions.length > 0) for (const t of tx.transfers) consumed.add(t);

    // The `exact` scheme and any direct payment: a top-level token transfer the payer signs.
    for (const t of tx.transfers) {
      if (consumed.has(t) || t.inner || t.authority === undefined || !tx.signers.includes(t.authority)) continue;
      const outer = tx.instructions.find((i) => !i.inner && i.outerIndex === t.outerIndex);
      if (outer === undefined || !TOKEN_PROGRAMS.has(outer.programId)) continue;
      consumed.add(t);
      const vendor = ownerOf(tx, t.destination);
      payer ??= ownerOf(tx, t.source);
      direct.set(vendor, (direct.get(vendor) ?? 0n) + t.amount);
      contact(vendor, order);
      settledAt(tx);
    }

    for (const t of tx.transfers) {
      if (consumed.has(t)) continue;
      edges.push({ signature: tx.signature, blockTime: tx.blockTime, program: topLevelProgram(tx, t), from: ownerOf(tx, t.source), to: ownerOf(tx, t.destination), amount: t.amount, ...(t.mint === undefined ? {} : { mint: t.mint }) });
    }
  }

  const spend = new Map<Address, bigint>();
  for (const state of channels.values()) {
    for (const entry of state.recipients) {
      const byVoucher = (state.cumulative * BigInt(entry.bps)) / 10_000n;
      const byPayout = state.paidOut.get(entry.recipient) ?? 0n;
      spend.set(entry.recipient, (spend.get(entry.recipient) ?? 0n) + (byPayout > byVoucher ? byPayout : byVoucher));
    }
    for (const [recipient, amount] of state.paidOut) {
      if (!state.recipients.some((e) => e.recipient === recipient)) spend.set(recipient, (spend.get(recipient) ?? 0n) + amount);
    }
  }
  for (const [vendor, amount] of direct) spend.set(vendor, (spend.get(vendor) ?? 0n) + amount);

  const firstContactOrder = [...firstContact.entries()].sort((a, b) => (before(a[1], b[1]) ? -1 : before(b[1], a[1]) ? 1 : 0)).map(([vendor]) => vendor);
  const vendors = [...new Set([...firstContactOrder, ...spend.keys()])];
  const spendPerVendor: Record<Address, bigint> = {};
  for (const vendor of vendors) spendPerVendor[vendor] = spend.get(vendor) ?? 0n;

  return {
    ...(payer === undefined ? {} : { payer }),
    vendors,
    firstContactOrder,
    spendPerVendor,
    settlementTimes: [...settlementTimes].sort((a, b) => a - b),
    edges,
  };
}

export function compare(reconstructed: Trajectory, actual: Trajectory): Comparison {
  const vendorsRecovered = actual.vendors.filter((vendor) => reconstructed.vendors.includes(vendor)).length;
  let totalActual = 0n;
  let recovered = 0n;
  for (const vendor of actual.vendors) {
    const want = actual.spendPerVendor[vendor] ?? 0n;
    const got = reconstructed.spendPerVendor[vendor] ?? 0n;
    totalActual += want;
    recovered += got < want ? got : want;
  }
  const spendRecoveredBps = totalActual === 0n ? 0 : Number((recovered * 10_000n) / totalActual);
  const orderRecovered = actual.firstContactOrder.length === reconstructed.firstContactOrder.length && actual.firstContactOrder.every((vendor, i) => reconstructed.firstContactOrder[i] === vendor);
  return { vendorsRecovered, vendorsActual: actual.vendors.length, spendRecoveredBps, orderRecovered };
}

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function trajectoryToJson(trajectory: Trajectory | Reconstruction): string {
  return JSON.stringify(trajectory, jsonReplacer, 2) + "\n";
}

/** The trajectory as a markdown block in the shape of `docs/public-rail-log.md`, "What an observer rebuilds". */
export function renderTrajectory(t: Reconstruction): string {
  const lines: string[] = [];
  lines.push(`- **Payer:** ${t.payer === undefined ? "not recovered" : `\`${t.payer}\``}`);
  lines.push(`- **Vendor set:** ${t.vendors.length === 0 ? "none recovered" : t.vendors.map((v) => `\`${v}\``).join(", ")}`);
  lines.push(`- **First-contact order:** ${t.firstContactOrder.length === 0 ? "none recovered" : t.firstContactOrder.map((v, i) => `${i + 1}. \`${v}\``).join(", ")}`);
  lines.push(`- **Cumulative spend per vendor:** ${t.vendors.length === 0 ? "none recovered" : t.vendors.map((v) => `\`${v}\`: ${t.spendPerVendor[v] ?? 0n}`).join(", ")}`);
  lines.push(`- **Settlement times:** ${t.settlementTimes.length === 0 ? "none recovered" : t.settlementTimes.map((s) => `${s} (${new Date(s * 1000).toISOString().replace(".000Z", "Z")})`).join(", ")}`);
  lines.push(`- **Edges, unlinked to any payer:** ${t.edges.length === 0 ? "none" : t.edges.map((e) => `${e.amount} \`${e.from}\` → \`${e.to}\` under ${e.program.slice(0, 4)}…${e.program.slice(-4)} in \`${e.signature}\``).join("; ")}`);
  return lines.join("\n");
}

export function renderComparison(c: Comparison): string {
  return [
    "| | Recovered |",
    "| --- | --- |",
    `| Vendors recovered / actual | ${c.vendorsRecovered} / ${c.vendorsActual} |`,
    `| Spend recovered | ${(c.spendRecoveredBps / 100).toFixed(2)}% |`,
    `| First-contact order recovered | ${c.orderRecovered ? "yes" : "no"} |`,
  ].join("\n");
}
