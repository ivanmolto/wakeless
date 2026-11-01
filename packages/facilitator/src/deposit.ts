import { createHash } from "node:crypto";
import type { Address, Signature } from "@solana/kit";
import { clientRefId, type SettlementBinding } from "@wakeless/binding";
import { SCHEME_ERROR_CODES, nextWatermark, type DepositPayload, type PaymentRequirements, type SettlementResponse } from "@wakeless/scheme";
import type { DepositHandler } from "./http/deposit-handler.js";
import { Rejection } from "./http/errors.js";
import { checkDeposit } from "./http/validate.js";
import type { ChannelRecord, Stores } from "./stores/types.js";

/**
 * Task 4.1: a `deposit` payload confirmed through the binding.
 *
 * The buyer has already made the private transfer to the escrow. The facilitator
 * derives the channel id and the `clientRefId` from `channelConfig`, asks the
 * binding to confirm the signature against the client-signed transaction, the
 * rollup and the escrow's private balance, and on a match records the channel
 * with `deposit = amount` (a top-up adds to the existing channel) and accepts the
 * first (or next) voucher. The deposit signature is reserved as a `deposit`
 * operation on the channel before the binding is asked, so it is credited once.
 */

export interface DepositDeps {
  readonly binding: SettlementBinding;
  readonly stores: Stores;
  /** Unix seconds. */
  readonly now?: () => number;
  /** One line per event: channel id, op id, status. Never a signature or an amount. */
  readonly log?: (line: string) => void;
}

export interface ConfirmDepositInput {
  readonly payload: DepositPayload;
  readonly requirements: PaymentRequirements;
}

/** The operation id of a deposit: the signature hashed, so no store message or log ever carries the signature. */
export function depositOpId(depositSignature: string): string {
  return `deposit:${createHash("sha256").update(depositSignature).digest("hex")}`;
}

/**
 * Confirms one deposit and records it. Throws a `Rejection` for a verdict on the
 * payment; lets a binding error through for the HTTP layer to map.
 */
export async function confirmDeposit(input: ConfirmDepositInput, deps: DepositDeps): Promise<SettlementResponse> {
  const { payload, requirements } = input;
  const { binding, stores } = deps;
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const log = deps.log ?? (() => undefined);

  // 1. The channel as stored agrees with the config, is open, and the voucher would be
  //    acceptable once the deposit counts. Nothing has touched the binding yet.
  const verdict = await checkDeposit(payload, requirements, stores.channels);
  if (verdict instanceof Rejection) throw verdict;
  const { channelId, clientRef, buyer } = verdict;
  const amount = BigInt(payload.deposit.amount);
  const sig = payload.depositSignature;

  // 2. One credit per signature on the channel. `pending` means another confirmation of
  //    this deposit is in flight; `failed` is at rest and may be tried again.
  const opId = depositOpId(sig);
  const reserved = await stores.operations.reserve({ opId, channelId, type: "deposit", payload: { amount: payload.deposit.amount } });
  if (!reserved.created) {
    const { status } = reserved.operation;
    if (status === "failed") {
      await stores.operations.transition(channelId, opId, { status: "pending" });
    } else if (status === "pending") {
      throw new Rejection(SCHEME_ERROR_CODES.settlementPending, "a confirmation of this deposit is already in flight; retry with the same payload", buyer, sig);
    } else {
      throw new Rejection(SCHEME_ERROR_CODES.duplicateSettlement, "this deposit signature was already credited", buyer);
    }
  }

  // 3. The binding confirms the private transfer: the client-signed transaction names
  //    this buyer and amount and pays the escrow, it landed inside the rollup, and the
  //    escrow's private balance grew. Null is a verdict; a thrown error is the binding's.
  let read: { amount: bigint; buyer: Address } | null;
  try {
    read = await binding.readDeposit(sig as Signature, { id: clientRefId(clientRef), buyer: buyer as Address, amount, transaction: payload.deposit.transaction });
  } catch (error) {
    await stores.operations.transition(channelId, opId, { status: "failed" });
    throw error;
  }
  if (read === null || read.buyer !== buyer || read.amount !== amount) {
    await stores.operations.transition(channelId, opId, { status: "failed" });
    log(`deposit unconfirmed ${channelId} ${opId}`);
    throw new Rejection(SCHEME_ERROR_CODES.invalidTransactionState, "the deposit transfer is not confirmed: it is not this buyer's transfer of this amount to the escrow, has not landed, or was already credited", buyer);
  }

  // 4. Record it, re-checking the record as stored inside the atomic update. The updater
  //    is pure: the Redis store may run it more than once.
  let before: ChannelRecord | undefined;
  let after: ChannelRecord;
  try {
    after = await stores.channels.update(channelId, (current) => {
      before = current;
      const next = applyDeposit(current, payload, requirements, channelId, clientRef, now());
      if (next instanceof Rejection) throw next;
      return next;
    });
  } catch (error) {
    // The binding has attributed the amount to this deposit and the record refused it: a
    // race between the check in step 1 and the write. The operation stays `failed` with
    // the signature, so an operator can see what was credited and not recorded.
    await stores.operations.transition(channelId, opId, { status: "failed", signature: sig });
    log(`deposit credited but not recorded ${channelId} ${opId}`);
    throw error;
  }
  await stores.operations.transition(channelId, opId, { status: "confirmed", signature: sig });
  log(`deposit confirmed ${channelId} ${opId}`);

  return {
    success: true,
    transaction: sig,
    network: binding.network(),
    payer: buyer,
    amount: amount.toString(),
    extra: {
      commitmentId: `${channelId}:${after.accepted.toString()}`,
      chargedAmount: (after.accepted - (before?.accepted ?? 0n)).toString(),
      channelState: {
        channelId,
        balance: after.deposit.toString(),
        totalClaimed: after.settled.toString(),
        withdrawRequestedAt: null,
        chargedCumulativeAmount: after.accepted.toString(),
      },
    },
  };
}

/** The channel after `payload`'s deposit and voucher, or the rejection. Pure. */
export function applyDeposit(
  current: ChannelRecord | undefined,
  payload: DepositPayload,
  requirements: PaymentRequirements,
  channelId: string,
  clientRef: string,
  now: number,
): ChannelRecord | Rejection {
  const { buyer, vendor, mint } = payload.channelConfig;
  const amount = BigInt(payload.deposit.amount);
  if (current !== undefined) {
    if (current.buyer !== buyer || current.vendor !== vendor || current.mint !== mint) {
      return new Rejection(SCHEME_ERROR_CODES.channelState, "channelConfig does not match the channel record", buyer);
    }
    if (current.state !== "open") return new Rejection(SCHEME_ERROR_CODES.channelClosing, `channel is ${current.state}; no new deposits`, buyer);
  }
  const base: ChannelRecord = current ?? {
    channelId,
    clientRef,
    buyer,
    vendor,
    mint,
    deposit: 0n,
    settled: 0n,
    accepted: 0n,
    latestVoucher: null,
    state: "open",
    lastActivityAt: now,
  };
  const deposit = base.deposit + amount;
  const next = nextWatermark(base.accepted, payload.voucher, BigInt(requirements.amount), deposit);
  if (!next.ok) return new Rejection(next.code, "voucher.maxClaimableAmount is not acceptable against the deposit", buyer);
  return { ...base, deposit, accepted: next.watermark, latestVoucher: payload.voucher, lastActivityAt: now };
}

/** The `DepositHandler` the HTTP app hands `deposit` payloads to. */
export function createDepositHandler(deps: DepositDeps): DepositHandler {
  return {
    settle: ({ payload, requirements }) => confirmDeposit({ payload, requirements }, deps),
  };
}
