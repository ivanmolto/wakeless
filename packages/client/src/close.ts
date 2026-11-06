// The buyer's close (task 8.1): one `refund` payload to the facilitator's `/settle`,
// signed twice by the buyer key (the latest voucher, and the close message over it). The
// facilitator answers where the close stands; calling again polls it. Once the refund has
// landed in the buyer's private balance, the client *offers* a withdrawal to the buyer's
// base token account and performs it only through the offer, never on its own: that
// withdrawal is a public base-layer transaction, and the owner's view says so.
import type { BuyerBinding } from "@wakeless/binding";
import { X402_VERSION, signCloseRequest, signVoucher, type CloseState, type PaymentPayload, type RefundPayload, type VoucherKeypair } from "@wakeless/scheme";
import { CLIENT_ERROR_CODES, WakelessClientError } from "./errors.js";
import { parseCloseResponse } from "./parse.js";
import { WITHDRAW_NOTE, type LocalChannel, type LocalChannelClose, type LocalChannelStore } from "./store.js";

/** The withdrawal the client offers after a refund. Nothing happens until `perform()` is called. */
export interface WithdrawOffer {
  /** The refund amount, base units: what the buyer's private balance received and may now withdraw. */
  readonly amount: bigint;
  /** Why this is offered and not done: a public base-layer transaction naming the buyer and the vault. */
  readonly note: typeof WITHDRAW_NOTE;
  /** Makes the withdrawal through the rail and records it in the channel file. */
  perform(): Promise<{ signature: string }>;
}

export interface CloseOutcome {
  readonly channelId: string;
  readonly state: CloseState["state"];
  /** Unix seconds: the vendor's latest voucher is accepted until then; the refund follows. */
  readonly refundAfter: number;
  /** The refund once confirmed. */
  readonly refund?: { readonly amount: bigint; readonly signature: string | null };
  /** Offered once the refund is confirmed; absent before, and after a withdrawal was performed. */
  readonly withdraw?: WithdrawOffer;
}

export interface CloseDeps {
  readonly fetchImpl: typeof fetch;
  readonly facilitatorUrl: string | undefined;
  readonly buyer: VoucherKeypair;
  readonly buyerAddress: string;
  readonly store: LocalChannelStore;
  readonly rail: () => Promise<BuyerBinding>;
  readonly now: () => Date;
  readonly log: (line: string) => void;
}

function refundPayloadOf(buyer: VoucherKeypair, channel: LocalChannel): RefundPayload {
  const accept = channel.accept!;
  const voucher = signVoucher(buyer, { channelId: channel.channelId, maxClaimableAmount: channel.accepted, expiresAt: 0 });
  return {
    type: "refund",
    channelConfig: { buyer: channel.buyer, vendor: channel.vendor, mint: channel.mint, salt: channel.salt, withdrawDelay: accept.extra.withdrawDelay },
    voucher,
    closeSignature: signCloseRequest(buyer, voucher),
  };
}

/** Sends the close request (or polls it) and brings the channel file up to date. */
export async function closeChannel(deps: CloseDeps, channelId: string): Promise<CloseOutcome> {
  const { facilitatorUrl, store, buyerAddress, now, log } = deps;
  if (facilitatorUrl === undefined) throw new WakelessClientError(CLIENT_ERROR_CODES.closeUnconfigured, "close needs facilitatorUrl: the close request goes to the facilitator, not through a vendor");
  const channel = store.byId(buyerAddress, channelId);
  if (channel === undefined) throw new WakelessClientError(CLIENT_ERROR_CODES.closeUnconfigured, "no such channel in the local channel file");
  if (channel.accept === undefined) throw new WakelessClientError(CLIENT_ERROR_CODES.closeUnconfigured, "the channel file holds no accept for this channel; pay once more before closing");
  if (channel.pendingDeposit !== undefined) {
    throw new WakelessClientError(CLIENT_ERROR_CODES.closeUnconfigured, "a deposit on this channel is not yet credited; present it with one more paid request before closing");
  }

  const payload = refundPayloadOf(deps.buyer, channel);
  const envelope: PaymentPayload = { x402Version: X402_VERSION, accepted: channel.accept, payload };
  const body = JSON.stringify({ x402Version: X402_VERSION, paymentPayload: envelope, paymentRequirements: channel.accept });
  const response = await deps.fetchImpl(`${facilitatorUrl.replace(/\/$/, "")}/settle`, { method: "POST", headers: { "content-type": "application/json", accept: "application/json" }, body });
  let json: unknown;
  try {
    json = await response.json();
  } catch {
    json = undefined;
  }
  const parsed = parseCloseResponse(json);
  if (parsed === undefined || !parsed.success || parsed.closeState === undefined) {
    const code = parsed?.errorReason ?? (typeof (json as { code?: unknown } | undefined)?.code === "string" ? (json as { code: string }).code : `http ${response.status}`);
    log(`close refused ${channelId} ${code}`);
    throw new WakelessClientError(CLIENT_ERROR_CODES.closeRefused, `the facilitator refused the close request: ${code}`);
  }
  const state = parsed.closeState;
  const at = now().toISOString();
  const previous = channel.close;
  const refund =
    state.refund === null
      ? previous?.refund
      : (previous?.refund ?? { amount: state.refund.amount, signature: state.refund.signature, confirmedAt: at });
  // The offer is recorded when the refund is first seen confirmed; nothing is performed here.
  const withdraw = refund === undefined ? previous?.withdraw : (previous?.withdraw ?? { note: WITHDRAW_NOTE, offeredAt: at });
  const close: LocalChannelClose = {
    state: state.state,
    requestedAt: new Date(state.requestedAt * 1000).toISOString(),
    refundAfter: new Date(state.refundAfter * 1000).toISOString(),
    ...(refund === undefined ? {} : { refund }),
    ...(withdraw === undefined ? {} : { withdraw }),
  };
  const updated: LocalChannel = { ...channel, deposit: state.deposit, accepted: parsed.channelState?.chargedCumulativeAmount ?? channel.accepted, close, updatedAt: at };
  store.put(updated);
  log(`close ${channelId} ${state.state}${refund === undefined ? "" : " refunded"}`);

  const outcome: CloseOutcome = {
    channelId,
    state: state.state,
    refundAfter: state.refundAfter,
    ...(refund === undefined ? {} : { refund: { amount: BigInt(refund.amount), signature: refund.signature } }),
  };
  if (refund === undefined || withdraw?.performed !== undefined) return outcome;
  return { ...outcome, withdraw: offerOf(deps, channelId, BigInt(refund.amount)) };
}

function offerOf(deps: CloseDeps, channelId: string, amount: bigint): WithdrawOffer {
  return {
    amount,
    note: WITHDRAW_NOTE,
    async perform() {
      const rail = await deps.rail();
      if (rail.withdraw === undefined) throw new WakelessClientError(CLIENT_ERROR_CODES.withdrawUnavailable, `the ${rail.id} rail has no withdrawal`);
      const channel = deps.store.byId(deps.buyerAddress, channelId);
      if (channel?.close?.refund === undefined) throw new WakelessClientError(CLIENT_ERROR_CODES.withdrawUnavailable, "no confirmed refund on this channel");
      if (channel.close.withdraw?.performed !== undefined) throw new WakelessClientError(CLIENT_ERROR_CODES.withdrawUnavailable, "the withdrawal for this channel was already made");
      const { sig } = await rail.withdraw(amount);
      const at = deps.now().toISOString();
      deps.store.put({
        ...channel,
        updatedAt: at,
        close: { ...channel.close, withdraw: { note: WITHDRAW_NOTE, offeredAt: channel.close.withdraw?.offeredAt ?? at, performed: { amount: amount.toString(), signature: sig, at } } },
      });
      deps.log(`withdraw performed ${channelId}`);
      return { signature: sig };
    },
  };
}


