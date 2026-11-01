import {
  SCHEME_ERROR_CODES,
  SCHEME_ID,
  WITHDRAW_DELAY_MAX,
  WITHDRAW_DELAY_MIN,
  X402_VERSION,
  decodeBase58Exact,
  parseBatchVoucher,
  parseU64,
  type PaymentPayload,
  type PaymentRequirements,
  type SchemeErrorCode,
  type ShieldedExtra,
  type ShieldedPayload,
} from "@wakeless/scheme";
import { HttpError, Rejection } from "./errors.js";
import { canonicalJson, payloadHash } from "./hash.js";

/**
 * The facilitator request envelope (`specs/x402-specification-v2.md:L307`-`L399`;
 * `scheme_batch_settlement_svm.md:L728`-`L738`): `{x402Version, paymentPayload,
 * paymentRequirements}`, with `paymentPayload.accepted` equal to
 * `paymentRequirements`. The envelope and the requirements are checked here and
 * refused with 400; the inner `payload` is checked by `parsePayload` and refused
 * as a verdict, since it is the payment itself that is wrong.
 */
export interface FacilitatorRequest {
  readonly paymentPayload: PaymentPayload;
  readonly paymentRequirements: PaymentRequirements;
  /** sha256 of the canonical request; keys the verified set and the settled results. */
  readonly hash: string;
}

export interface ExpectedRequirements {
  readonly network: string;
  readonly escrowAddress: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  return decodeBase58Exact(value, 32) !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function bad(code: SchemeErrorCode, message: string): HttpError {
  return new HttpError(400, code, message);
}

export function parseRequest(body: unknown, expected: ExpectedRequirements): FacilitatorRequest {
  if (!isObject(body)) throw bad(SCHEME_ERROR_CODES.invalidPayload, "request body must be a JSON object");
  if (body.x402Version !== X402_VERSION) throw bad(SCHEME_ERROR_CODES.invalidX402Version, "x402Version must be 2");
  const { paymentPayload, paymentRequirements } = body;
  if (!isObject(paymentPayload)) throw bad(SCHEME_ERROR_CODES.invalidPayload, "paymentPayload must be an object");
  if (paymentPayload.x402Version !== X402_VERSION) throw bad(SCHEME_ERROR_CODES.invalidX402Version, "paymentPayload.x402Version must be 2");
  const requirements = parseRequirements(paymentRequirements, expected);
  if (canonicalJson(paymentPayload.accepted) !== canonicalJson(requirements)) {
    throw bad(SCHEME_ERROR_CODES.invalidPaymentRequirements, "paymentPayload.accepted must equal paymentRequirements");
  }
  if (!isObject(paymentPayload.payload)) throw bad(SCHEME_ERROR_CODES.invalidPayload, "paymentPayload.payload must be an object");
  return {
    paymentPayload: paymentPayload as unknown as PaymentPayload,
    paymentRequirements: requirements,
    hash: payloadHash(paymentPayload, paymentRequirements),
  };
}

/** `PaymentRequirements` with the shielded `extra` (`docs/SCHEME.md` §4.2). Throws `HttpError` 400. */
export function parseRequirements(input: unknown, expected: ExpectedRequirements): PaymentRequirements {
  const code = SCHEME_ERROR_CODES.invalidPaymentRequirements;
  if (!isObject(input)) throw bad(code, "paymentRequirements must be an object");
  if (input.scheme !== SCHEME_ID) {
    throw bad(typeof input.scheme === "string" ? SCHEME_ERROR_CODES.unsupportedScheme : SCHEME_ERROR_CODES.invalidScheme, `scheme must be ${SCHEME_ID}`);
  }
  if (input.network !== expected.network) throw bad(SCHEME_ERROR_CODES.invalidNetwork, `network must be ${expected.network}`);
  const amount = parseU64(input.amount, "amount", code);
  if (!amount.ok) throw bad(code, amount.message);
  if (!isAddress(input.asset)) throw bad(code, "asset must be a 32-byte base58 mint");
  if (!isAddress(input.payTo)) throw bad(code, "payTo must be a 32-byte base58 address");
  if (!isCount(input.maxTimeoutSeconds) || input.maxTimeoutSeconds === 0) throw bad(code, "maxTimeoutSeconds must be a positive integer");

  const extra = input.extra;
  if (!isObject(extra)) throw bad(code, "extra is required");
  if (extra.paymentFlow !== undefined && extra.paymentFlow !== "authorization") {
    throw bad(SCHEME_ERROR_CODES.paymentFlow, "extra.paymentFlow must be authorization when present");
  }
  if (extra.voucherSigner !== undefined && extra.voucherSigner !== "client") {
    throw bad(SCHEME_ERROR_CODES.payloadType, "extra.voucherSigner must be client; there is no server mode");
  }
  const delay = extra.withdrawDelay;
  if (!isCount(delay) || delay < WITHDRAW_DELAY_MIN || delay > WITHDRAW_DELAY_MAX || delay < input.maxTimeoutSeconds) {
    throw bad(SCHEME_ERROR_CODES.withdrawDelayOutOfRange, `extra.withdrawDelay must be ${WITHDRAW_DELAY_MIN}..=${WITHDRAW_DELAY_MAX} and >= maxTimeoutSeconds`);
  }
  if (!isAddress(extra.tokenProgram)) throw bad(SCHEME_ERROR_CODES.tokenProgram, "extra.tokenProgram must be a 32-byte base58 program id");
  if (extra.escrowAddress !== expected.escrowAddress) throw bad(code, "extra.escrowAddress is not this facilitator's escrow");
  if (extra.binding !== "magicblock") throw bad(code, "extra.binding must be magicblock");
  if (!isAddress(extra.teeValidator)) throw bad(code, "extra.teeValidator must be a 32-byte base58 identity");
  if (!isCount(extra.privacyFeeBps)) throw bad(code, "extra.privacyFeeBps must be a non-negative integer");
  if (extra.minDeposit !== undefined) {
    const min = parseU64(extra.minDeposit, "extra.minDeposit", code);
    if (!min.ok) throw bad(code, min.message);
  }
  if (extra.maxIdleSecs !== undefined && !isCount(extra.maxIdleSecs)) throw bad(code, "extra.maxIdleSecs must be a non-negative integer");

  // Rebuilt field by field: nothing a client appended travels further.
  const shielded: ShieldedExtra = {
    ...(extra.paymentFlow !== undefined ? { paymentFlow: "authorization" } : {}),
    ...(extra.voucherSigner !== undefined ? { voucherSigner: "client" } : {}),
    withdrawDelay: delay,
    tokenProgram: extra.tokenProgram,
    ...(extra.minDeposit !== undefined ? { minDeposit: extra.minDeposit as string } : {}),
    ...(extra.maxIdleSecs !== undefined ? { maxIdleSecs: extra.maxIdleSecs } : {}),
    escrowAddress: extra.escrowAddress,
    binding: "magicblock",
    teeValidator: extra.teeValidator,
    privacyFeeBps: extra.privacyFeeBps,
  };
  return {
    scheme: SCHEME_ID,
    network: input.network as string,
    amount: input.amount as string,
    asset: input.asset,
    payTo: input.payTo,
    maxTimeoutSeconds: input.maxTimeoutSeconds,
    extra: { ...(input.extra as object), ...shielded } as ShieldedExtra,
  };
}

/**
 * The inner `payload`: `deposit` or `voucher` (`docs/SCHEME.md` §4.3). A problem
 * here is a verdict on the payment, not a malformed request, so it returns a
 * `Rejection` rather than throwing. Checks shape and the voucher's own fields;
 * the signature and the channel are `validate.ts`.
 */
export function parsePayload(input: unknown, requirements: PaymentRequirements): ShieldedPayload | Rejection {
  if (!isObject(input)) return new Rejection(SCHEME_ERROR_CODES.invalidPayload, "payload must be an object");
  if (input.type !== "deposit" && input.type !== "voucher") {
    return new Rejection(SCHEME_ERROR_CODES.payloadType, "payload.type must be deposit or voucher");
  }
  const config = input.channelConfig;
  if (!isObject(config)) return new Rejection(SCHEME_ERROR_CODES.invalidPayload, "payload.channelConfig must be an object");
  if (!isAddress(config.buyer)) return new Rejection(SCHEME_ERROR_CODES.invalidPayload, "channelConfig.buyer must be a 32-byte base58 address");
  const buyer = config.buyer;
  const reject = (code: SchemeErrorCode, message: string) => new Rejection(code, message, buyer);
  if (!isAddress(config.vendor)) return reject(SCHEME_ERROR_CODES.invalidPayload, "channelConfig.vendor must be a 32-byte base58 address");
  if (!isAddress(config.mint)) return reject(SCHEME_ERROR_CODES.invalidPayload, "channelConfig.mint must be a 32-byte base58 address");
  if (config.vendor !== requirements.payTo) return reject(SCHEME_ERROR_CODES.invalidPayload, "channelConfig.vendor must equal payTo");
  if (config.mint !== requirements.asset) return reject(SCHEME_ERROR_CODES.invalidPayload, "channelConfig.mint must equal asset");
  const salt = parseU64(config.salt, "channelConfig.salt", SCHEME_ERROR_CODES.invalidPayload);
  if (!salt.ok) return reject(salt.code, salt.message);
  if (config.withdrawDelay !== requirements.extra.withdrawDelay) {
    return reject(SCHEME_ERROR_CODES.withdrawDelayMismatch, "channelConfig.withdrawDelay must equal extra.withdrawDelay");
  }
  const voucher = parseBatchVoucher(input.voucher);
  if (!voucher.ok) return reject(voucher.code, voucher.message);

  const channelConfig = { buyer, vendor: config.vendor, mint: config.mint, salt: config.salt as string, withdrawDelay: config.withdrawDelay };
  if (input.type === "voucher") return { type: "voucher", channelConfig, voucher: voucher.value };

  if (decodeBase58Exact(input.depositSignature, 64) === null) {
    return reject(SCHEME_ERROR_CODES.invalidPayload, "depositSignature must be a 64-byte base58 signature");
  }
  if (!isObject(input.deposit)) return reject(SCHEME_ERROR_CODES.invalidPayload, "deposit must be an object");
  const amount = parseU64(input.deposit.amount, "deposit.amount", SCHEME_ERROR_CODES.invalidPayload);
  if (!amount.ok) return reject(amount.code, amount.message);
  if (amount.value === 0n) return reject(SCHEME_ERROR_CODES.invalidPayload, "deposit.amount must be positive");
  return {
    type: "deposit",
    channelConfig,
    depositSignature: input.depositSignature as string,
    deposit: { amount: input.deposit.amount as string },
    voucher: voucher.value,
  };
}
