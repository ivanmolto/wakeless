// Parsers of what a vendor sends: the `PAYMENT-REQUIRED` and `PAYMENT-RESPONSE`
// headers. Both are untrusted input. Neither parser throws, and an accept that is
// not a well-formed shielded entry is dropped rather than repaired. The accept the
// buyer acts on is kept as the object it came as, so echoing it as `accepted` is
// byte-for-byte what the vendor offered (the vendor matches on the terms).
import {
  SCHEME_ID,
  WITHDRAW_DELAY_MAX,
  WITHDRAW_DELAY_MIN,
  X402_VERSION,
  decodeBase58Exact,
  parseU64,
  SCHEME_ERROR_CODES,
  type ChannelState,
  type PaymentPayload,
  type PaymentRequirements,
  type VoucherState,
} from "@wakeless/scheme";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** The largest header decoded, characters. A 402 with a handful of accepts is well under 8 KiB. */
export const MAX_HEADER_LENGTH = 65_536;

const BINDINGS: ReadonlySet<string> = new Set(["magicblock", "rings", "privacycash"]);
const CAIP2 = /^solana:[1-9A-HJ-NP-Za-km-z]{32}$/;

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  return decodeBase58Exact(value, 32) !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isU64String(value: unknown): value is string {
  return parseU64(value, "u64", SCHEME_ERROR_CODES.invalidPayload).ok;
}

/** Base64 of JSON, or `undefined` for anything that is not. */
function decodeJsonHeader(header: unknown): unknown {
  if (typeof header !== "string" || header.length === 0 || header.length > MAX_HEADER_LENGTH) return undefined;
  if (header.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) return undefined;
  try {
    return JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(header, "base64"))) as unknown;
  } catch {
    return undefined;
  }
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

/** The `PAYMENT-SIGNATURE` value for a payload against the accept the buyer acted on. */
export function encodePaymentSignature(envelope: PaymentPayload): string {
  return encodeHeader(envelope);
}

export function parseChannelState(value: unknown): ChannelState | undefined {
  if (!isObject(value)) return undefined;
  const { channelId, balance, totalClaimed, withdrawRequestedAt, chargedCumulativeAmount } = value;
  if (!isAddress(channelId) || !isU64String(balance) || !isU64String(totalClaimed)) return undefined;
  if (withdrawRequestedAt !== null && !isCount(withdrawRequestedAt)) return undefined;
  if (chargedCumulativeAmount !== undefined && !isU64String(chargedCumulativeAmount)) return undefined;
  return value as unknown as ChannelState;
}

export function parseVoucherState(value: unknown): VoucherState | undefined {
  if (!isObject(value)) return undefined;
  const { signedMaxClaimable, expiresAt, signature } = value;
  if (!isU64String(signedMaxClaimable) || !isCount(expiresAt) || decodeBase58Exact(signature, 64) === null) return undefined;
  return value as unknown as VoucherState;
}

/**
 * One `accepts[]` entry as a well-formed `batch-settlement-shielded` accept, or
 * `undefined`. Checks every field the buyer reads (`docs/SCHEME.md` §4.2); keys it
 * does not know are left in place. Never throws.
 */
export function parseShieldedAccept(entry: unknown): PaymentRequirements | undefined {
  if (!isObject(entry) || entry.scheme !== SCHEME_ID) return undefined;
  const { network, amount, asset, payTo, maxTimeoutSeconds, extra } = entry;
  if (typeof network !== "string" || !CAIP2.test(network)) return undefined;
  if (!isU64String(amount) || !isAddress(asset) || !isAddress(payTo)) return undefined;
  if (!isCount(maxTimeoutSeconds) || maxTimeoutSeconds === 0) return undefined;
  if (!isObject(extra)) return undefined;

  const { paymentFlow, voucherSigner, withdrawDelay, tokenProgram, minDeposit, maxIdleSecs, escrowAddress, binding, teeValidator, privacyFeeBps, channelState, voucherState } = extra;
  if (paymentFlow !== undefined && paymentFlow !== "authorization") return undefined;
  if (voucherSigner !== undefined && voucherSigner !== "client") return undefined;
  if (!isCount(withdrawDelay) || withdrawDelay < WITHDRAW_DELAY_MIN || withdrawDelay > WITHDRAW_DELAY_MAX) return undefined;
  if (!isAddress(tokenProgram) || !isAddress(escrowAddress) || !isAddress(teeValidator)) return undefined;
  if (minDeposit !== undefined && !isU64String(minDeposit)) return undefined;
  if (maxIdleSecs !== undefined && !isCount(maxIdleSecs)) return undefined;
  if (typeof binding !== "string" || !BINDINGS.has(binding)) return undefined;
  if (!isCount(privacyFeeBps) || privacyFeeBps > 10_000) return undefined;
  if (channelState !== undefined && parseChannelState(channelState) === undefined) return undefined;
  if (voucherState !== undefined && parseVoucherState(voucherState) === undefined) return undefined;
  return entry as unknown as PaymentRequirements;
}

export interface ParsedPaymentRequired {
  /** `PaymentRequired.error`: the refusal code on a 402 that answers a payment. */
  readonly error?: string;
  /** The well-formed shielded entries, in the vendor's order. Other schemes are not listed. */
  readonly accepts: readonly PaymentRequirements[];
}

/**
 * The `PAYMENT-REQUIRED` header of a 402 (`specs/transports-v2/http.md`). Returns
 * `undefined` for a missing or malformed header or a wrong `x402Version`; a
 * well-formed envelope with no shielded entry parses with `accepts: []`. Never throws.
 */
export function parsePaymentRequired(header: unknown): ParsedPaymentRequired | undefined {
  const decoded = decodeJsonHeader(header);
  if (!isObject(decoded) || decoded.x402Version !== X402_VERSION || !Array.isArray(decoded.accepts)) return undefined;
  const accepts = decoded.accepts.map(parseShieldedAccept).filter((a): a is PaymentRequirements => a !== undefined);
  return { ...(typeof decoded.error === "string" ? { error: decoded.error } : {}), accepts };
}

export interface ParsedPaymentResponse {
  readonly success: boolean;
  readonly errorReason?: string;
  readonly channelState?: ChannelState;
}

/**
 * The `PAYMENT-RESPONSE` header of a paid response, as far as the buyer reads it:
 * whether it settled and the channel as the facilitator now holds it. Never throws.
 */
export function parsePaymentResponse(header: unknown): ParsedPaymentResponse | undefined {
  const decoded = decodeJsonHeader(header);
  if (!isObject(decoded) || typeof decoded.success !== "boolean") return undefined;
  const extra = isObject(decoded.extra) ? decoded.extra : undefined;
  const channelState = extra === undefined ? undefined : parseChannelState(extra.channelState);
  return {
    success: decoded.success,
    ...(typeof decoded.errorReason === "string" ? { errorReason: decoded.errorReason } : {}),
    ...(channelState === undefined ? {} : { channelState }),
  };
}
