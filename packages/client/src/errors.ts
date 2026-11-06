/**
 * A failure the wrapper names before or instead of paying. `code` is a scheme
 * error code where one fits (`shielded_attestation_failed`, `unsupported_scheme`,
 * `invalid_network`) or a `shielded_client_*` code for the wrapper's own
 * conditions. Messages never carry an amount, a signature or a key.
 */
export class WakelessClientError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "WakelessClientError";
  }
}

export const CLIENT_ERROR_CODES = {
  /** The local channel file exists but is not this client's format. Nothing is overwritten. */
  storeUnreadable: "shielded_client_store_unreadable",
  /** No rail was given and the MagicBlock connection details are incomplete. */
  railUnconfigured: "shielded_client_rail_unconfigured",
  /** `close()` needs `facilitatorUrl`, and a channel this buyer holds with the accept it paid under. */
  closeUnconfigured: "shielded_client_close_unconfigured",
  /** The facilitator refused the close request, or answered something the client cannot read; the code it gave is in the message. */
  closeRefused: "shielded_client_close_refused",
  /** The rail has no withdrawal, or there is no confirmed refund to withdraw. */
  withdrawUnavailable: "shielded_client_withdraw_unavailable",
} as const;
