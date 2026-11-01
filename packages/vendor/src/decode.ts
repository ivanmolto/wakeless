import { SCHEME_ERROR_CODES, X402_VERSION, type SchemeResult } from "@wakeless/scheme";

/** The largest `PAYMENT-SIGNATURE` accepted, characters. A deposit, the largest payload, is under 4 KiB of base64. */
export const MAX_PAYMENT_SIGNATURE_LENGTH = 16_384;

/**
 * The `PAYMENT-SIGNATURE` envelope as far as a seller reads it. `accepted` is
 * compared with what this route offers and `payload` goes to the facilitator
 * untouched, which is the party that checks its fields.
 */
export interface DecodedPayment extends Record<string, unknown> {
  readonly x402Version: typeof X402_VERSION;
  readonly accepted: Readonly<Record<string, unknown>>;
  readonly payload: Readonly<Record<string, unknown>>;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function invalid(message: string): SchemeResult<DecodedPayment> {
  return { ok: false, code: SCHEME_ERROR_CODES.invalidPayload, message };
}

/** Base64 of a JSON `PaymentPayload` (`specs/transports-v2/http.md`). Never throws, whatever it is given. */
export function decodePaymentSignature(header: unknown): SchemeResult<DecodedPayment> {
  if (typeof header !== "string" || header.length === 0) return invalid("PAYMENT-SIGNATURE must be a non-empty string");
  if (header.length > MAX_PAYMENT_SIGNATURE_LENGTH) return invalid("PAYMENT-SIGNATURE is too long");
  if (header.length % 4 !== 0 || !/^[A-Za-z0-9+/]+={0,2}$/.test(header)) return invalid("PAYMENT-SIGNATURE must be base64");

  let decoded: unknown;
  try {
    decoded = JSON.parse(new TextDecoder("utf-8", { fatal: true }).decode(Buffer.from(header, "base64")));
  } catch {
    return invalid("PAYMENT-SIGNATURE must decode to JSON");
  }
  if (!isObject(decoded)) return invalid("PAYMENT-SIGNATURE must decode to an object");
  if (decoded.x402Version !== X402_VERSION) {
    return { ok: false, code: SCHEME_ERROR_CODES.invalidX402Version, message: "x402Version must be 2" };
  }
  if (!isObject(decoded.accepted)) return invalid("accepted must be an object");
  if (!isObject(decoded.payload)) return invalid("payload must be an object");
  return { ok: true, value: decoded as DecodedPayment };
}
