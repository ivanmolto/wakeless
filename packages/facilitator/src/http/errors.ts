import { SCHEME_ERROR_CODES, type ChannelState, type SchemeErrorCode, type VoucherState } from "@wakeless/scheme";

/**
 * One error body for every refused request: `{error, code, retryable}`. `code`
 * is a scheme error code (`docs/SCHEME.md` §1.5), `error` a short free-form
 * message that never echoes a signature, a token, a key or a channel amount, and
 * `retryable` says whether the same request may be sent again unchanged.
 *
 * A verdict on a payment (`isValid: false`, `success: false`) keeps the spec's
 * own response shape and carries these three fields beside it, so a client can
 * match on `invalidReason`/`errorReason` as the spec says or on `code`.
 */
export interface ErrorBody {
  readonly error: string;
  readonly code: SchemeErrorCode;
  readonly retryable: boolean;
}

/** Codes a client may retry unchanged: the facilitator, not the payload, was the problem. */
const RETRYABLE: ReadonlySet<string> = new Set([
  SCHEME_ERROR_CODES.unexpectedVerifyError,
  SCHEME_ERROR_CODES.unexpectedSettleError,
  SCHEME_ERROR_CODES.settlementPending,
  SCHEME_ERROR_CODES.shieldedRateLimited,
]);

export function isRetryable(code: SchemeErrorCode): boolean {
  return RETRYABLE.has(code);
}

export function errorBody(code: SchemeErrorCode, error: string): ErrorBody {
  return { error, code, retryable: isRetryable(code) };
}

/** A refusal with its HTTP status: 400 for a malformed request, 429 over a rate limit, 500 for a facilitator fault. */
export class HttpError extends Error {
  constructor(
    readonly status: 400 | 404 | 429 | 500 | 503,
    readonly code: SchemeErrorCode,
    message: string,
    /** Response headers beside the body: `Retry-After` on a 429. */
    readonly headers: Readonly<Record<string, string>> = {},
  ) {
    super(message);
    this.name = "HttpError";
  }

  body(): ErrorBody {
    return errorBody(this.code, this.message);
  }
}

/**
 * What a corrective verdict carries so the seller can build the corrective 402
 * (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L1216`-`L1269`):
 * the channel as stored, with the watermark, and the last accepted voucher when
 * there is one. The voucher's signature is the buyer's own, going back to the buyer.
 */
export interface CorrectiveState {
  readonly channelState: ChannelState & { readonly chargedCumulativeAmount: string };
  readonly voucherState?: VoucherState;
}

/**
 * A payment the facilitator judged and refused: the body is a verdict, the status 200.
 * `transaction` is set only for `settlement_pending`, which the spec requires to carry
 * the transaction in question; every other verdict answers `transaction: ""`.
 * `corrective` is set only on `/verify` for the two cumulative codes.
 */
export class Rejection {
  constructor(
    readonly code: SchemeErrorCode,
    readonly message: string,
    readonly payer?: string,
    readonly transaction?: string,
    readonly corrective?: CorrectiveState,
  ) {}
}

export function isRejection(value: unknown): value is Rejection {
  return value instanceof Rejection;
}
