// The relationship-terms layer (task 12.1T, briefing §3c), behind `RELATIONSHIP_TERMS`.
// Seller-side only: nothing here is imported by the facilitator or the client.
import type { VoucherKeypair } from "@wakeless/scheme";
import type { TermsHistoryStore } from "./history.js";

export { formatUnits, renderTermsCard, sideBySide, termsCardLines, type CardOptions } from "./card.js";
export { WORKED_ROWS, WORKED_STANDARD_PRICE, renderTermsDoc, renderWorkedTable, type WorkedRow } from "./doc.js";
export {
  FileTermsHistory,
  HISTORY_VERSION,
  MemoryTermsHistory,
  REPEATED_EXCEEDS_THRESHOLD,
  activeIncidents,
  capitalBpsOf,
  parseHistoryFile,
  readHistoryFile,
  shortId,
  type BuyerHistory,
  type ClosedChannel,
  type HistoryFile,
  type OpenPeriod,
  type RedeemedPeriod,
  type TermsHistoryStore,
} from "./history.js";
export {
  CAPITAL_CAP,
  CAPITAL_PER_CLEAN_PERIOD,
  FUNDING_CALLS,
  POLICY_ID,
  PREMIUM_BPS,
  capitalOf,
  standardTerms,
  terms,
  type Incident,
  type IncidentKind,
  type Terms,
} from "./policy.js";
export {
  LABELS,
  TERMS_MAGIC,
  canonicalJson,
  inputsDigestOf,
  parseTermsReceipt,
  quoteFor,
  signTermsReceipt,
  termsMessage,
  verifyTermsReceipt,
  type Adjustment,
  type Quote,
  type TermsReceipt,
  type UnsignedTermsReceipt,
} from "./receipt.js";

/** What `x402Shielded` needs to quote terms: the vendor's own key (its `payTo`) and its private history. */
export interface TermsOptions {
  /** Signs the terms receipt. Its public key must be the middleware's `payTo`. */
  readonly signer: VoucherKeypair;
  readonly history: TermsHistoryStore;
  /** Decimals of the asset, for the card the vendor may print. Default 6. */
  readonly decimals?: number;
}

export const RELATIONSHIP_TERMS_FLAG = "RELATIONSHIP_TERMS";

/** `true` only when the flag is exactly the string `true`. Anything else, including unset, is off. */
export function relationshipTermsEnabled(env: Readonly<Record<string, string | undefined>> = process.env): boolean {
  return env[RELATIONSHIP_TERMS_FLAG] === "true";
}

/**
 * The gate: `terms` when the flag is on, `undefined` otherwise, so a caller can always
 * write `x402Shielded({ ..., terms: termsIfEnabled(env, () => ({ signer, history })) })`
 * and the middleware with the flag off is exactly the middleware without the option.
 */
export function termsIfEnabled(env: Readonly<Record<string, string | undefined>>, build: () => TermsOptions): TermsOptions | undefined {
  return relationshipTermsEnabled(env) ? build() : undefined;
}
