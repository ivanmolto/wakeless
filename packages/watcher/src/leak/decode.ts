// Decoding the payment-channels program's instructions for the leakage indexer (task 11.3).
// Layouts come from the program's codama IDL (`vendor/payment-channels/program/
// payment_channels/idl/payment_channels.json`, program 0.1.0): a one-byte discriminator,
// then the arguments; the account order is the IDL's. The argument decoders are the ones
// `reconstruct()` already uses. Everything here is pure, takes untrusted ledger data and
// never throws on it: an instruction that is not the program's, or is malformed, is skipped.
import type { Address, Signature } from "@solana/kit";
import type { BaseTransaction, LedgerInstruction, TokenTransfer } from "../parse.js";
import { decodeDistribute, decodeOpen, decodeTopUp, decodeVouchers, ED25519_PROGRAM, PAYMENT_CHANNELS_PROGRAM, type DistributionEntry } from "../reconstruct.js";

/** Discriminators of the IDL's instructions, in its order. */
export const DISCRIMINATORS = {
  open: 1,
  settle: 2,
  topUp: 3,
  settleAndSeal: 4,
  requestClose: 5,
  seal: 6,
  distribute: 7,
  /** The payer takes back the unspent deposit after the grace period: the program's refund. */
  withdrawPayer: 8,
  reclaim: 9,
} as const;

export type InstructionKind = keyof typeof DISCRIMINATORS;

export interface Payout {
  readonly destination: Address;
  /** The owner of the destination token account when the balances name it, the account otherwise. */
  readonly recipient: Address;
  readonly amount: bigint;
}

export type ChannelInstruction =
  | { readonly kind: "open"; readonly channel: Address; readonly payer: Address; readonly payee: Address; readonly mint: Address; readonly deposit: bigint; readonly gracePeriod: number; readonly openSlot: bigint | null; readonly recipients: readonly DistributionEntry[] }
  | { readonly kind: "settle"; readonly channel: Address; readonly cumulativeAmount: bigint | null }
  | { readonly kind: "topUp"; readonly channel: Address; readonly payer: Address; readonly amount: bigint }
  | { readonly kind: "settleAndSeal"; readonly channel: Address; readonly payee: Address; readonly hasVoucher: boolean; readonly cumulativeAmount: bigint | null }
  | { readonly kind: "requestClose"; readonly channel: Address; readonly payer: Address }
  | { readonly kind: "seal"; readonly channel: Address }
  | { readonly kind: "distribute"; readonly channel: Address; readonly payer: Address; readonly recipients: readonly DistributionEntry[]; readonly payouts: readonly Payout[] }
  | { readonly kind: "withdrawPayer"; readonly channel: Address; readonly payer: Address; readonly refunded: bigint }
  | { readonly kind: "reclaim"; readonly channel: Address };

/** One decoded instruction with where the ledger shows it. */
export interface ChannelEvent {
  readonly signature: Signature;
  readonly slot: number | null;
  readonly blockTime: number | null;
  readonly instruction: ChannelInstruction;
}

const OPEN = { payer: 0, payee: 2, mint: 3, channel: 5 } as const;
const SETTLE = { channel: 0 } as const;
const TOP_UP = { payer: 0, channel: 1 } as const;
const SETTLE_AND_SEAL = { payee: 0, channel: 1 } as const;
const REQUEST_CLOSE = { payer: 0, channel: 1 } as const;
const SEAL = { channel: 0 } as const;
const DISTRIBUTE = { channel: 0, payer: 1, channelTokenAccount: 3 } as const;
const WITHDRAW_PAYER = { payer: 0, channel: 1, channelTokenAccount: 2 } as const;
const RECLAIM = { channel: 0 } as const;

export interface DecodeContext {
  /** Cumulative amount per channel id, from the Ed25519 instructions beside the program's. */
  readonly vouchers: ReadonlyMap<Address, bigint>;
  /** Token transfers under the same top-level instruction. */
  readonly transfers: readonly TokenTransfer[];
  readonly ownerOf: (account: Address) => Address;
}

const EMPTY_CONTEXT: DecodeContext = { vouchers: new Map(), transfers: [], ownerOf: (a) => a };

function account(accounts: readonly Address[], index: number): Address | undefined {
  return accounts[index];
}

/**
 * Decodes one instruction's data and accounts; null when the data is not one of the
 * program's instructions or the accounts are short. `context` supplies what the layout
 * alone cannot: the voucher amount a `settle` verifies and the transfers a `distribute`
 * or `withdrawPayer` moved.
 */
export function decodeInstruction(data: Uint8Array | null, accounts: readonly Address[], context: DecodeContext = EMPTY_CONTEXT): ChannelInstruction | null {
  if (data === null || data.byteLength === 0) return null;
  const discriminator = data[0];
  switch (discriminator) {
    case DISCRIMINATORS.open: {
      const args = decodeOpen(data);
      const channel = account(accounts, OPEN.channel);
      const payer = account(accounts, OPEN.payer);
      const payee = account(accounts, OPEN.payee);
      const mint = account(accounts, OPEN.mint);
      if (args === null || channel === undefined || payer === undefined || payee === undefined || mint === undefined) return null;
      return { kind: "open", channel, payer, payee, mint, deposit: args.deposit, gracePeriod: args.gracePeriod, openSlot: args.openSlot, recipients: args.recipients };
    }
    case DISCRIMINATORS.settle: {
      const channel = account(accounts, SETTLE.channel);
      if (channel === undefined) return null;
      return { kind: "settle", channel, cumulativeAmount: context.vouchers.get(channel) ?? null };
    }
    case DISCRIMINATORS.topUp: {
      const args = decodeTopUp(data);
      const channel = account(accounts, TOP_UP.channel);
      const payer = account(accounts, TOP_UP.payer);
      if (args === null || channel === undefined || payer === undefined) return null;
      return { kind: "topUp", channel, payer, amount: args.amount };
    }
    case DISCRIMINATORS.settleAndSeal: {
      const channel = account(accounts, SETTLE_AND_SEAL.channel);
      const payee = account(accounts, SETTLE_AND_SEAL.payee);
      if (data.byteLength < 2 || channel === undefined || payee === undefined) return null;
      const hasVoucher = data[1] !== 0;
      return { kind: "settleAndSeal", channel, payee, hasVoucher, cumulativeAmount: hasVoucher ? (context.vouchers.get(channel) ?? null) : null };
    }
    case DISCRIMINATORS.requestClose: {
      const channel = account(accounts, REQUEST_CLOSE.channel);
      const payer = account(accounts, REQUEST_CLOSE.payer);
      if (channel === undefined || payer === undefined) return null;
      return { kind: "requestClose", channel, payer };
    }
    case DISCRIMINATORS.seal: {
      const channel = account(accounts, SEAL.channel);
      if (channel === undefined) return null;
      return { kind: "seal", channel };
    }
    case DISCRIMINATORS.distribute: {
      const args = decodeDistribute(data);
      const channel = account(accounts, DISTRIBUTE.channel);
      const payer = account(accounts, DISTRIBUTE.payer);
      const channelTokenAccount = account(accounts, DISTRIBUTE.channelTokenAccount);
      if (args === null || channel === undefined || payer === undefined) return null;
      const payouts = context.transfers
        .filter((t) => channelTokenAccount === undefined || t.source === channelTokenAccount)
        .map((t) => ({ destination: t.destination, recipient: context.ownerOf(t.destination), amount: t.amount }));
      return { kind: "distribute", channel, payer, recipients: args.recipients, payouts };
    }
    case DISCRIMINATORS.withdrawPayer: {
      const channel = account(accounts, WITHDRAW_PAYER.channel);
      const payer = account(accounts, WITHDRAW_PAYER.payer);
      const channelTokenAccount = account(accounts, WITHDRAW_PAYER.channelTokenAccount);
      if (channel === undefined || payer === undefined) return null;
      let refunded = 0n;
      for (const t of context.transfers) if (channelTokenAccount === undefined || t.source === channelTokenAccount) refunded += t.amount;
      return { kind: "withdrawPayer", channel, payer, refunded };
    }
    case DISCRIMINATORS.reclaim: {
      const channel = account(accounts, RECLAIM.channel);
      if (channel === undefined) return null;
      return { kind: "reclaim", channel };
    }
    default:
      return null;
  }
}

function isProgramInstruction(ix: LedgerInstruction): boolean {
  return ix.programId === PAYMENT_CHANNELS_PROGRAM;
}

/**
 * Every payment-channels instruction a parsed transaction carries, with the voucher amounts
 * of its Ed25519 instructions and the transfers under each one attached. A failed
 * transaction yields nothing: it moved nothing.
 */
export function decodeTransaction(tx: BaseTransaction): ChannelEvent[] {
  if (!tx.onBaseLayer || (tx.err !== null && tx.err !== undefined)) return [];
  const vouchers = new Map<Address, bigint>();
  for (const ix of tx.instructions) {
    if (ix.programId !== ED25519_PROGRAM || ix.inner) continue;
    for (const v of decodeVouchers(ix.data)) {
      const seen = vouchers.get(v.channelId);
      if (seen === undefined || v.cumulativeAmount > seen) vouchers.set(v.channelId, v.cumulativeAmount);
    }
  }
  const ownerOf = (a: Address): Address => tx.tokenOwners.get(a) ?? a;
  const events: ChannelEvent[] = [];
  for (const ix of tx.instructions) {
    if (!isProgramInstruction(ix)) continue;
    const transfers = tx.transfers.filter((t) => t.outerIndex === ix.outerIndex);
    const instruction = decodeInstruction(ix.data, ix.accounts, { vouchers, transfers, ownerOf });
    if (instruction !== null) events.push({ signature: tx.signature, slot: tx.slot, blockTime: tx.blockTime, instruction });
  }
  return events;
}
