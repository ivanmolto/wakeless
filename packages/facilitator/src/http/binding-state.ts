import type { SettlementBinding } from "@wakeless/binding";

/**
 * What the HTTP layer knows about the binding. A binding that failed
 * attestation never exists (`MagicBlockBinding.create` rejects), so the server
 * records that outcome and runs with an empty `/supported` instead of starting
 * without the primitive or faking one.
 */
export type BindingState =
  | {
      readonly status: "ready";
      readonly binding: SettlementBinding;
      /** The TEE validator identity the binding attested, base58; advertised in `/supported`. */
      readonly teeValidator: string;
    }
  | {
      readonly status: "attestation_failed";
      /** The verifier's message; never a token or key. */
      readonly error: string;
    };
