// `wrapFetchWithWakeless`: a fetch that pays `batch-settlement-shielded` 402s with
// channel vouchers (task 5.1). One deposit opens a channel per (vendor, mint); every
// request after it is a signed cumulative voucher and touches no chain. The buyer key
// signs vouchers here and the deposit inside the rail, and goes nowhere else.
import { randomBytes } from "node:crypto";
import { isDeepStrictEqual } from "node:util";
import { DEVNET_CAIP2, type BuyerBinding, type Caip2 } from "@wakeless/binding";
import {
  SCHEME_ERROR_CODES,
  publicKeyOf,
  signVoucher,
  verifyVoucher,
  type ChannelConfig,
  type ChannelState,
  type DepositPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type ShieldedPayload,
  type VoucherKeypair,
  type VoucherState,
} from "@wakeless/scheme";
import { closeChannel, type CloseOutcome } from "./close.js";
import { deposit } from "./deposit.js";
import { WakelessClientError } from "./errors.js";
import { chargeOf } from "./fee.js";
import { KeyedMutex } from "./mutex.js";
import {
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_RESPONSE_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  encodePaymentSignature,
  parsePaymentRequired,
  parsePaymentResponse,
} from "./parse.js";
import { createMagicBlockRail, type MagicBlockRailOptions } from "./rail.js";
import { LocalChannelStore, defaultStorePath, type FundingSource, type LocalChannel, type TrajectoryEntry } from "./store.js";

/** `extra.minDeposit` absent and no `defaultDeposit` configured: deposit this many requests' worth, as the vendor middleware's own default does. */
export const DEFAULT_DEPOSIT_MULTIPLE = 100n;

/** Paid attempts per request: the first, one after a resynchronisation, one after a top-up. */
const MAX_ATTEMPTS = 3;

export interface WakelessOptions extends MagicBlockRailOptions {
  /** The buyer: a 64-byte Solana keypair (seed then public key) or a 32-byte seed. Signs vouchers and, inside the rail, the deposit. Never sent anywhere. */
  readonly buyerKeypair: Uint8Array;
  /**
   * The private-transfer rail, or a function that builds it on the first 402. When
   * absent the client builds `MagicBlockBuyer` from `paymentsApi`, `teeRpc` and
   * `baseRpc`, once per session: that construction is the TEE attestation.
   */
  readonly rail?: BuyerBinding | (() => Promise<BuyerBinding>);
  /** Path of the local channel file. Default `~/.wakeless/channels.json`, mode 0600. */
  readonly channelStoreLocal?: string;
  /** The facilitator's base URL, for `close()`: a close request goes to the facilitator, not through a vendor. */
  readonly facilitatorUrl?: string;
  /** Opening deposit when the accept names no `extra.minDeposit`. Default: 100 times the route's price. */
  readonly defaultDeposit?: bigint;
  /** Recorded on each trajectory entry, for channels funded through Aurora (`wakeless fund`): the `FundingSource` the funding recorded, or a label. */
  readonly fundingSource?: string | FundingSource;
  /**
   * A spend policy, run once per paid request after the 402 is read and before any
   * deposit is made or voucher signed. Throw to refuse: nothing is signed or sent and
   * the error reaches the caller of the fetch. The MCP server's caps live here.
   */
  readonly beforePayment?: (payment: PendingPayment) => void | Promise<void>;
  /** One line per event: channel ids, codes and statuses. Never an amount, a signature or a token. */
  readonly log?: (line: string) => void;
  readonly now?: () => Date;
  /** Tests only: the salt of a new channel. Default: eight random bytes as a u64. */
  readonly salt?: () => string;
}

/** What one paid request is about to commit, as `beforePayment` sees it. Amounts in the asset's atomic units. */
export interface PendingPayment {
  /** The vendor's `payTo`, base58. */
  readonly vendor: string;
  /** The request's path. */
  readonly route: string;
  /** The mint, base58. */
  readonly asset: string;
  /** The route's price: what the vendor nets. */
  readonly amount: bigint;
  /** What the voucher's cumulative moves by: the price plus the privacy fee share. */
  readonly charge: bigint;
  readonly privacyFeeBps: number;
}

export interface WakelessFetch {
  (input: string | URL | Request, init?: RequestInit): Promise<Response>;
  /** Every paid request, oldest first. */
  getTrajectory(): readonly TrajectoryEntry[];
  /** The channels this buyer holds, as the local file records them. */
  getChannels(): readonly LocalChannel[];
  /** The buyer's public key, base58: `channelConfig.buyer`. */
  readonly buyer: string;
  /**
   * Asks the facilitator (`facilitatorUrl`) to close a channel: the channel moves to
   * closing, the vendor may still present its latest voucher for `withdrawDelay` seconds,
   * then the vendor is paid and `deposit − settled` is refunded to the buyer's private
   * balance. Calling again polls. Once the refund is confirmed the outcome carries a
   * `withdraw` offer that nothing performs but its own `perform()` (task 8.1).
   */
  close(channelId: string): Promise<CloseOutcome>;
}

function randomSalt(): string {
  return randomBytes(8).readBigUInt64LE().toString();
}

function configOf(channel: LocalChannel, accept: PaymentRequirements): ChannelConfig {
  return { buyer: channel.buyer, vendor: channel.vendor, mint: channel.mint, salt: channel.salt, withdrawDelay: accept.extra.withdrawDelay };
}

function withSignature(base: Request, envelope: PaymentPayload): Request {
  const request = base.clone();
  request.headers.set(PAYMENT_SIGNATURE_HEADER, encodePaymentSignature(envelope));
  return request;
}

async function discard(response: Response): Promise<void> {
  try {
    await response.body?.cancel();
  } catch {
    // A body already consumed or closed is what we wanted.
  }
}

function max(a: bigint, b: bigint): bigint {
  return a > b ? a : b;
}

/** The entry less its price, its funding requirement and what a terms or corrective 402 adds: the same route's offer under other terms. */
function withoutTerms(entry: PaymentRequirements): unknown {
  const { amount: _amount, extra, ...rest } = entry;
  void _amount;
  const { minDeposit: _min, termsReceipt: _terms, channelState: _cs, voucherState: _vs, ...kept } = extra;
  void _min;
  void _terms;
  void _cs;
  void _vs;
  return { ...rest, extra: kept };
}

/**
 * Terms this vendor quoted on an earlier call (`extra.termsReceipt`, task 12.1T), carried
 * onto the fresh entry when the two differ only in price and funding requirement. The
 * vendor corrects them with `shielded_terms_quoted` if they have changed since.
 */
function rememberedTerms(fresh: PaymentRequirements, remembered: PaymentRequirements | undefined): PaymentRequirements {
  if (remembered?.extra.termsReceipt === undefined || !isDeepStrictEqual(withoutTerms(fresh), withoutTerms(remembered))) return fresh;
  return {
    ...fresh,
    amount: remembered.amount,
    extra: { ...fresh.extra, ...(remembered.extra.minDeposit === undefined ? {} : { minDeposit: remembered.extra.minDeposit }), termsReceipt: remembered.extra.termsReceipt },
  };
}

/**
 * Wraps `fetchImpl`. The returned function makes the request; on a 402 whose
 * `accepts[]` lists a shielded entry this rail can serve, it pays and returns the
 * paid response. A 402 it cannot fix (another scheme, a refusal that is not
 * corrective) comes back as it is. Failures of the client's own (attestation
 * mismatch, a rail that refuses the private transfer, an unreadable channel file)
 * are thrown.
 */
export function wrapFetchWithWakeless(fetchImpl: typeof fetch, options: WakelessOptions): WakelessFetch {
  const network: Caip2 = options.network ?? DEVNET_CAIP2;
  if (network !== DEVNET_CAIP2) {
    throw new WakelessClientError(SCHEME_ERROR_CODES.invalidNetwork, "this client runs on devnet only; mainnet is a human decision after Gate D");
  }
  const buyer: VoucherKeypair = { secretKey: options.buyerKeypair };
  const buyerAddress = publicKeyOf(buyer);
  const store = new LocalChannelStore(options.channelStoreLocal ?? defaultStorePath());
  const mutex = new KeyedMutex();
  const log = options.log ?? (() => undefined);
  const now = options.now ?? (() => new Date());
  const salt = options.salt ?? randomSalt;

  // One rail per session. A failed construction is not cached: the next request attests again.
  let railPromise: Promise<BuyerBinding> | undefined;
  function rail(): Promise<BuyerBinding> {
    if (railPromise === undefined) {
      const given = options.rail;
      railPromise = (given === undefined ? createMagicBlockRail(options.buyerKeypair, { ...options, network }) : typeof given === "function" ? given() : Promise.resolve(given)).catch((error: unknown) => {
        railPromise = undefined;
        throw error;
      });
    }
    return railPromise;
  }

  /**
   * The facilitator's snapshot on a corrective 402, adopted only when it is this
   * channel's and the last accepted voucher it quotes carries this buyer's own
   * signature (`scheme_batch_settlement_svm.md:L1259`-`L1266`).
   */
  function resync(channelId: string, state: ChannelState, voucher: VoucherState | undefined): { accepted: bigint; balance: bigint } | undefined {
    if (state.channelId !== channelId || state.chargedCumulativeAmount === undefined) return undefined;
    const charged = state.chargedCumulativeAmount;
    if (voucher === undefined) return charged === "0" ? { accepted: 0n, balance: BigInt(state.balance) } : undefined;
    if (voucher.signedMaxClaimable !== charged || voucher.expiresAt !== 0) return undefined;
    if (!verifyVoucher(buyerAddress, { channelId, maxClaimableAmount: charged, expiresAt: 0, signature: voucher.signature })) return undefined;
    return { accepted: BigInt(charged), balance: BigInt(state.balance) };
  }

  async function payUnderLock(base: Request, offered: readonly PaymentRequirements[]): Promise<Response> {
    const theRail = await rail();
    const fresh = offered.find((entry) => entry.extra.binding === theRail.id);
    if (fresh === undefined) {
      throw new WakelessClientError(SCHEME_ERROR_CODES.unsupportedScheme, `the 402 offers no shielded entry on the ${theRail.id} rail`);
    }
    if (theRail.teeValidator !== undefined && fresh.extra.teeValidator !== theRail.teeValidator) {
      throw new WakelessClientError(SCHEME_ERROR_CODES.shieldedAttestationFailed, "the vendor's extra.teeValidator is not the identity this session attested; not paying");
    }
    const route = new URL(base.url).pathname;

    let channel = store.get(buyerAddress, fresh.payTo, fresh.asset);
    if (channel !== undefined && channel.escrowAddress !== fresh.extra.escrowAddress) {
      // The channel id includes the escrow: a new escrow is a new channel. The old record is kept for its close (task 8.1).
      log(`escrow changed for channel ${channel.channelId}; opening a new channel`);
      channel = undefined;
    }
    if (channel?.close !== undefined) {
      // A closing or closed channel takes no more vouchers; paying this vendor again means a new channel.
      log(`channel ${channel.channelId} is ${channel.close.state}; opening a new channel`);
      channel = undefined;
    }
    let accept = rememberedTerms(fresh, channel?.accept);
    let price = BigInt(accept.amount);
    let charge = chargeOf(price, accept.extra.privacyFeeBps);
    // The policy runs before anything is signed; a throw here leaves no trace anywhere.
    const policy = async (): Promise<void> => {
      if (options.beforePayment !== undefined) {
        await options.beforePayment({ vendor: accept.payTo, route, asset: accept.asset, amount: price, charge, privacyFeeBps: accept.extra.privacyFeeBps });
      }
    };
    await policy();
    const target = (entry: PaymentRequirements): bigint => (entry.extra.minDeposit === undefined ? (options.defaultDeposit ?? price * DEFAULT_DEPOSIT_MULTIPLE) : BigInt(entry.extra.minDeposit));

    let accepted = channel === undefined ? 0n : BigInt(channel.accepted);
    let balance = channel === undefined ? 0n : BigInt(channel.deposit);
    let echo: PaymentRequirements = accept;
    let topUps = 0;
    let termsAdopted = false;
    let last: Response | undefined;

    for (let attempt = 0; attempt < MAX_ATTEMPTS; attempt++) {
      const cumulative = accepted + charge;
      let payload: ShieldedPayload;
      let depositAmount: bigint | undefined;
      let depositSignature: string | undefined;

      if (channel === undefined) {
        const amount = max(target(echo), cumulative);
        const opened = await deposit({ rail: theRail, requirements: accept, buyer, salt: salt(), amount, cumulative });
        const at = now().toISOString();
        channel = {
          buyer: buyerAddress,
          vendor: accept.payTo,
          mint: accept.asset,
          escrowAddress: accept.extra.escrowAddress,
          network: accept.network,
          salt: opened.payload.channelConfig.salt,
          channelId: opened.channelId,
          deposit: "0",
          accepted: "0",
          pendingDeposit: { amount: amount.toString(), signature: opened.signature, transaction: opened.payload.deposit.transaction },
          createdAt: at,
          updatedAt: at,
        };
        store.put(channel);
        log(`deposit made for channel ${channel.channelId}`);
        payload = opened.payload;
        depositAmount = amount;
        depositSignature = opened.signature;
      } else if (channel.pendingDeposit !== undefined) {
        // Made, not yet credited: the same transfer again with a voucher at the current watermark.
        const pending = channel.pendingDeposit;
        const voucher = signVoucher(buyer, { channelId: channel.channelId, maxClaimableAmount: cumulative.toString(), expiresAt: 0 });
        const resend: DepositPayload = { type: "deposit", channelConfig: configOf(channel, accept), depositSignature: pending.signature, deposit: { amount: pending.amount, transaction: pending.transaction }, voucher };
        log(`deposit resent for channel ${channel.channelId}`);
        payload = resend;
        depositAmount = BigInt(pending.amount);
        depositSignature = pending.signature;
      } else if (cumulative > balance) {
        if (topUps >= 1) break;
        topUps++;
        const amount = max(target(echo), cumulative - balance);
        const topped = await deposit({ rail: theRail, requirements: accept, buyer, salt: channel.salt, amount, cumulative });
        channel = { ...channel, pendingDeposit: { amount: amount.toString(), signature: topped.signature, transaction: topped.payload.deposit.transaction }, updatedAt: now().toISOString() };
        store.put(channel);
        log(`top-up made for channel ${channel.channelId}`);
        payload = topped.payload;
        depositAmount = amount;
        depositSignature = topped.signature;
      } else {
        payload = { type: "voucher", channelConfig: configOf(channel, accept), voucher: signVoucher(buyer, { channelId: channel.channelId, maxClaimableAmount: cumulative.toString(), expiresAt: 0 }) };
      }

      const response = await fetchImpl(withSignature(base, { x402Version: 2, accepted: echo, payload }));
      last = response;

      if (response.ok) {
        const settlement = parsePaymentResponse(response.headers.get(PAYMENT_RESPONSE_HEADER));
        const state = settlement?.channelState;
        const confirmedAccepted = state?.chargedCumulativeAmount === undefined ? cumulative : BigInt(state.chargedCumulativeAmount);
        const confirmedBalance = state === undefined ? balance + (depositAmount ?? 0n) : BigInt(state.balance);
        const { pendingDeposit: _settled, ...rest } = channel;
        void _settled;
        // The accept is kept as it came (less a corrective entry's snapshot fields), so a later close can echo it.
        const { channelState: _cs, voucherState: _vs, ...extra } = accept.extra;
        void _cs;
        void _vs;
        channel = { ...rest, deposit: confirmedBalance.toString(), accepted: confirmedAccepted.toString(), updatedAt: now().toISOString(), accept: { ...accept, extra } };
        store.put(channel);
        store.appendTrajectory({
          vendor: accept.payTo,
          route,
          amount: price.toString(),
          cumulative: confirmedAccepted.toString(),
          timestamp: now().toISOString(),
          ...(options.fundingSource === undefined ? {} : { fundingSource: options.fundingSource }),
          ...(depositAmount === undefined ? {} : { deposit: depositAmount.toString() }),
          ...(depositSignature === undefined ? {} : { depositSignature }),
        });
        log(`paid ${channel.channelId} ${response.status}`);
        return response;
      }
      // Not paid, so nothing was charged. A deposit just made stays pending and is resent next time.
      if (response.status !== 402) return response;

      const again = parsePaymentRequired(response.headers.get(PAYMENT_REQUIRED_HEADER));
      const code = again?.error;
      log(`refused ${channel.channelId} ${code ?? "no code"}`);

      if (code === SCHEME_ERROR_CODES.duplicateSettlement && channel.pendingDeposit !== undefined) {
        // Credited by an earlier settle whose answer was lost. Count it and pay with a voucher.
        balance += BigInt(channel.pendingDeposit.amount);
        const { pendingDeposit: _credited, ...rest } = channel;
        void _credited;
        channel = { ...rest, deposit: balance.toString(), updatedAt: now().toISOString() };
        store.put(channel);
        await discard(response);
        continue;
      }

      if (code === SCHEME_ERROR_CODES.shieldedTermsQuoted && !termsAdopted) {
        // This buyer's terms differ from the entry it paid against (task 12.1T): pay once more
        // against the quoted entry, after the policy has seen the quoted price. A deposit just
        // made stays pending and is resent with the new voucher.
        const quoted = again?.accepts.find((entry) => entry.payTo === accept.payTo && entry.asset === accept.asset && entry.extra.binding === theRail.id && entry.extra.termsReceipt !== undefined);
        if (quoted === undefined || (theRail.teeValidator !== undefined && quoted.extra.teeValidator !== theRail.teeValidator)) return response;
        termsAdopted = true;
        accept = quoted;
        echo = quoted;
        price = BigInt(quoted.amount);
        charge = chargeOf(price, quoted.extra.privacyFeeBps);
        await policy();
        log(`terms quoted for channel ${channel.channelId}`);
        await discard(response);
        continue;
      }

      const corrective = again?.accepts.find((entry) => entry.payTo === accept.payTo && entry.asset === accept.asset && entry.extra.channelState !== undefined);
      if (corrective !== undefined && (code === SCHEME_ERROR_CODES.cumulativeExceedsDeposit || code === SCHEME_ERROR_CODES.cumulativeAmountMismatch)) {
        const synced = resync(channel.channelId, corrective.extra.channelState as ChannelState, corrective.extra.voucherState);
        if (synced === undefined) return response;
        accepted = synced.accepted;
        balance = synced.balance;
        channel = { ...channel, deposit: balance.toString(), accepted: accepted.toString(), updatedAt: now().toISOString() };
        store.put(channel);
        echo = corrective;
        await discard(response);
        continue;
      }
      return response;
    }
    // Out of attempts: the last refusal is the answer.
    return last as Response;
  }

  async function paid(input: string | URL | Request, init?: RequestInit): Promise<Response> {
    const base = new Request(input, init);
    const first = await fetchImpl(base.clone());
    if (first.status !== 402) return first;
    const required = parsePaymentRequired(first.headers.get(PAYMENT_REQUIRED_HEADER));
    if (required === undefined) return first;
    const offered = required.accepts.filter((entry) => entry.network === network);
    const [head] = offered;
    if (head === undefined) return first;
    await discard(first);
    return mutex.run(`${head.payTo}:${head.asset}`, () => payUnderLock(base, offered));
  }

  return Object.assign(paid, {
    getTrajectory: () => store.trajectory(),
    getChannels: () => store.channels(buyerAddress),
    buyer: buyerAddress,
    close: (channelId: string) => mutex.run(`close:${channelId}`, () => closeChannel({ fetchImpl, facilitatorUrl: options.facilitatorUrl, buyer, buyerAddress, store, rail, now, log }, channelId)),
  });
}
