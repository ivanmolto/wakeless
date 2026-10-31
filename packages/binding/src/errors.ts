/**
 * Error codes a binding may raise. The x402 spec's codes are reused verbatim elsewhere;
 * codes that exist only for the shielded scheme take the `shielded_` prefix (briefing §3,
 * "Failed payments").
 */
export const BINDING_ERROR_CODES = {
  /** TEE attestation (`verifyTeeRpcIntegrity`) failed: the binding refuses to start. */
  attestationFailed: "shielded_attestation_failed",
  /**
   * The private transfer was refused: `UNSUPPORTED_TRANSFER_ROUTE`, an ingress rejection
   * (screening) or a builder that would route onto the public base layer. Non-retryable;
   * the amount stays owed; never retried as a public transfer.
   */
  bindingRejected: "shielded_binding_rejected",
} as const;

export type BindingErrorCode = (typeof BINDING_ERROR_CODES)[keyof typeof BINDING_ERROR_CODES];

/**
 * A failure the binding can name. `retryable` is always false for the two codes above:
 * the caller must not retry the same transfer, and must never retry it publicly.
 * Messages carry the API's own error code and message; never a token, key or amount.
 */
export class BindingError extends Error {
  readonly retryable = false as const;

  constructor(
    readonly code: BindingErrorCode,
    message: string,
    options?: { cause?: unknown; apiCode?: string },
  ) {
    super(`${code}: ${message}`, options?.cause === undefined ? undefined : { cause: options.cause });
    this.name = "BindingError";
    this.apiCode = options?.apiCode;
  }

  /** The upstream error code (for example `UNSUPPORTED_TRANSFER_ROUTE`) when one was given. */
  readonly apiCode: string | undefined;
}

export function isBindingError(error: unknown, code?: BindingErrorCode): error is BindingError {
  return error instanceof BindingError && (code === undefined || error.code === code);
}
