import {
  SCHEME_ERROR_CODES,
  SchemeError,
  clientRefOf,
  deriveChannelId,
  nextWatermark,
  verifyVoucher,
  type BatchVoucher,
  type ChannelConfig,
  type DepositPayload,
  type PaymentRequirements,
  type VoucherPayload,
} from "@wakeless/scheme";
import type { ChannelRecord, ChannelStore } from "../stores/types.js";
import { Rejection, type CorrectiveState } from "./errors.js";

/** The two verdicts on which the seller answers a corrective 402 (briefing §3, rows 1 and 2). */
export const CORRECTIVE_CODES: ReadonlySet<string> = new Set([SCHEME_ERROR_CODES.cumulativeAmountMismatch, SCHEME_ERROR_CODES.cumulativeExceedsDeposit]);

/** The snapshot a corrective verdict carries, from the record as stored. */
export function correctiveOf(record: ChannelRecord): CorrectiveState {
  const voucher = record.latestVoucher;
  return {
    channelState: {
      channelId: record.channelId,
      balance: record.deposit.toString(),
      totalClaimed: record.settled.toString(),
      withdrawRequestedAt: null,
      chargedCumulativeAmount: record.accepted.toString(),
    },
    ...(voucher === null ? {} : { voucherState: { signedMaxClaimable: voucher.maxClaimableAmount, expiresAt: voucher.expiresAt, signature: voucher.signature } }),
  };
}

/**
 * The checks a voucher must pass, split so `/verify` can run them against a
 * read and `/settle` can run the same ones inside the store's atomic update.
 */

export interface ChannelIdentity {
  readonly channelId: string;
  readonly clientRef: string;
  readonly buyer: string;
}

/** Derives the channel id from the config and checks the voucher names it and the buyer signed it. */
export function identify(config: ChannelConfig, voucher: BatchVoucher, requirements: PaymentRequirements): ChannelIdentity | Rejection {
  const { buyer } = config;
  let channelId: string;
  try {
    channelId = deriveChannelId({ buyer, escrowAddress: requirements.extra.escrowAddress, mint: config.mint, salt: config.salt });
  } catch (error) {
    const code = error instanceof SchemeError ? error.code : SCHEME_ERROR_CODES.invalidPayload;
    return new Rejection(code, "channelConfig does not derive a channel id", buyer);
  }
  if (voucher.channelId !== channelId) {
    return new Rejection(SCHEME_ERROR_CODES.channelIdMismatch, "voucher.channelId is not the channel id derived from channelConfig", buyer);
  }
  if (!verifyVoucher(buyer, voucher)) {
    return new Rejection(SCHEME_ERROR_CODES.voucherSignature, "voucher.signature is not the buyer's signature over the voucher", buyer);
  }
  return { channelId, clientRef: clientRefOf(channelId), buyer };
}

/**
 * The next record after accepting `voucher` on the channel as stored, or the
 * rejection. Pure, so a store may run it more than once. `now` is unix seconds.
 */
export function applyVoucher(
  current: ChannelRecord | undefined,
  config: ChannelConfig,
  voucher: BatchVoucher,
  requirements: PaymentRequirements,
  now: number,
): ChannelRecord | Rejection {
  const { buyer } = config;
  if (current === undefined) {
    return new Rejection(SCHEME_ERROR_CODES.channelState, "unknown channel: no confirmed deposit; send a deposit payload first", buyer);
  }
  if (current.buyer !== buyer || current.vendor !== config.vendor || current.mint !== config.mint) {
    return new Rejection(SCHEME_ERROR_CODES.channelState, "channelConfig does not match the channel record", buyer);
  }
  if (current.state !== "open") {
    return new Rejection(SCHEME_ERROR_CODES.channelClosing, `channel is ${current.state}; no new vouchers`, buyer);
  }
  const next = nextWatermark(current.accepted, voucher, BigInt(requirements.amount), current.deposit);
  if (!next.ok) return new Rejection(next.code, "voucher.maxClaimableAmount is not acceptable against the channel's watermark", buyer);
  return { ...current, accepted: next.watermark, latestVoucher: voucher, lastActivityAt: now };
}

export interface VoucherVerdict extends ChannelIdentity {
  readonly before: ChannelRecord;
  readonly after: ChannelRecord;
}

/**
 * `/verify` for a voucher: reads the channel, writes nothing. A rejection on the
 * cumulative (stale, or above the deposit) carries the corrective snapshot; a
 * rejection of the signature or the channel id carries nothing of the record.
 */
export async function checkVoucher(payload: VoucherPayload, requirements: PaymentRequirements, channels: ChannelStore, now: number): Promise<VoucherVerdict | Rejection> {
  const identity = identify(payload.channelConfig, payload.voucher, requirements);
  if (identity instanceof Rejection) return identity;
  const before = await channels.get(identity.channelId);
  const after = applyVoucher(before, payload.channelConfig, payload.voucher, requirements, now);
  if (after instanceof Rejection) {
    if (before !== undefined && CORRECTIVE_CODES.has(after.code)) return new Rejection(after.code, after.message, after.payer, undefined, correctiveOf(before));
    return after;
  }
  return { ...identity, before: before as ChannelRecord, after };
}

export interface DepositVerdict extends ChannelIdentity {
  /** The channel as stored, when this deposit tops one up. */
  readonly existing: ChannelRecord | undefined;
  /** The watermark the first (or next) voucher would set once the deposit is confirmed. */
  readonly watermark: bigint;
}

/**
 * `/verify` for a deposit: the deposit object is checked without confirming it
 * (task 4.1 confirms through the binding). The voucher is checked against the
 * deposit the payload claims plus any confirmed deposit already recorded; the
 * facilitator does not enforce `minDeposit` (`docs/SCHEME.md` §1.2).
 */
export async function checkDeposit(payload: DepositPayload, requirements: PaymentRequirements, channels: ChannelStore): Promise<DepositVerdict | Rejection> {
  const identity = identify(payload.channelConfig, payload.voucher, requirements);
  if (identity instanceof Rejection) return identity;
  const { buyer } = identity;
  const existing = await channels.get(identity.channelId);
  if (existing !== undefined) {
    if (existing.buyer !== buyer || existing.vendor !== payload.channelConfig.vendor || existing.mint !== payload.channelConfig.mint) {
      return new Rejection(SCHEME_ERROR_CODES.channelState, "channelConfig does not match the channel record", buyer);
    }
    if (existing.state !== "open") return new Rejection(SCHEME_ERROR_CODES.channelClosing, `channel is ${existing.state}; no new deposits`, buyer);
  }
  const deposit = (existing?.deposit ?? 0n) + BigInt(payload.deposit.amount);
  const next = nextWatermark(existing?.accepted ?? 0n, payload.voucher, BigInt(requirements.amount), deposit);
  if (!next.ok) return new Rejection(next.code, "voucher.maxClaimableAmount is not acceptable against the deposit", buyer);
  return { ...identity, existing, watermark: next.watermark };
}
