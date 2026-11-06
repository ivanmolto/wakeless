/**
 * Error codes of the `batch-settlement-shielded` scheme (`docs/SCHEME.md` §1.5).
 *
 * Clients match on the code, never on message text. Core codes and the
 * `invalid_batch_settlement_svm_*` scheme codes are reused verbatim from the
 * x402 V2 spec and its SVM binding; the prefix stays `svm` because the binding
 * is still SVM and a client that already maps these codes keeps working.
 * Codes that exist only for the shielded scheme take the `shielded_` prefix.
 */

const SVM = "invalid_batch_settlement_svm_";

export const SCHEME_ERROR_CODES = {
  // Core x402 V2 codes (`specs/x402-specification-v2.md:L597`-`L612`).
  insufficientFunds: "insufficient_funds",
  invalidNetwork: "invalid_network",
  invalidPayload: "invalid_payload",
  invalidPaymentRequirements: "invalid_payment_requirements",
  invalidScheme: "invalid_scheme",
  unsupportedScheme: "unsupported_scheme",
  invalidX402Version: "invalid_x402_version",
  invalidTransactionState: "invalid_transaction_state",
  unexpectedVerifyError: "unexpected_verify_error",
  unexpectedSettleError: "unexpected_settle_error",
  /** Non-terminal; a response carrying it must carry a non-empty `transaction`. */
  settlementPending: "settlement_pending",

  // SVM batch-settlement codes whose condition exists in the shielded flow.
  payloadType: `${SVM}payload_type`,
  paymentFlow: `${SVM}payment_flow`,
  tokenProgram: `${SVM}token_program`,
  voucherSignature: `${SVM}voucher_signature`,
  channelIdMismatch: `${SVM}channel_id_mismatch`,
  withdrawDelayMismatch: `${SVM}withdraw_delay_mismatch`,
  withdrawDelayOutOfRange: `${SVM}withdraw_delay_out_of_range`,
  cumulativeAmountMismatch: `${SVM}cumulative_amount_mismatch`,
  cumulativeExceedsDeposit: `${SVM}cumulative_exceeds_deposit`,
  voucherExpiry: `${SVM}voucher_expiry`,
  depositBelowMinDeposit: `${SVM}deposit_below_min_deposit`,
  channelState: `${SVM}channel_state`,
  channelClosing: `${SVM}channel_closing`,
  /** A `refund` payload whose close signature is not the buyer's over the channel id and the latest voucher's cumulative. */
  closeAuthorization: `${SVM}close_authorization`,
  /** Same deposit signature or payload settled twice. */
  duplicateSettlement: "duplicate_settlement",

  // Shielded-only codes.
  /** A private call was refused; it is never retried, and never retried publicly. */
  shieldedBindingRejected: "shielded_binding_rejected",
  /** The binding could not verify the TEE; it does not start and `/supported` is empty. */
  shieldedAttestationFailed: "shielded_attestation_failed",
  /** `/settle` of a voucher with no valid `/verify` of the same payload within `maxTimeoutSeconds`. */
  shieldedVerifyRequired: "shielded_verify_required",
  /** HTTP 429: the caller's address or the channel is over the facilitator's rate limit. Retryable after `Retry-After`. */
  shieldedRateLimited: "shielded_rate_limited",
  /** HTTP 401 or 403: a token-protected facilitator route (`/receipts`, `/admin/*`) refused the caller. Not retryable unchanged. */
  shieldedUnauthorized: "shielded_unauthorized",

  /** Seller side: the facilitator did not answer, so the request fails closed with a 402. */
  facilitatorUnavailable: "shielded_facilitator_unavailable",
} as const;

export type SchemeErrorCode = (typeof SCHEME_ERROR_CODES)[keyof typeof SCHEME_ERROR_CODES];

const ALL_CODES: ReadonlySet<string> = new Set(Object.values(SCHEME_ERROR_CODES));

export function isSchemeErrorCode(value: unknown): value is SchemeErrorCode {
  return typeof value === "string" && ALL_CODES.has(value);
}

/** A failure a scheme function can name. The message never echoes a long input. */
export class SchemeError extends Error {
  constructor(
    readonly code: SchemeErrorCode,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "SchemeError";
  }
}

/** The return shape of every parser: a value, or a code the caller can forward as `errorReason`. */
export type SchemeResult<T> =
  | { readonly ok: true; readonly value: T }
  | { readonly ok: false; readonly code: SchemeErrorCode; readonly message: string };

export function ok<T>(value: T): SchemeResult<T> {
  return { ok: true, value };
}

export function fail<T = never>(code: SchemeErrorCode, message: string): SchemeResult<T> {
  return { ok: false, code, message };
}
