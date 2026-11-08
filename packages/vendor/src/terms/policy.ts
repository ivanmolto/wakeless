/**
 * Policy `terms@1` (briefing §3c): a pure function from the standard price, the buyer's
 * active incidents and its relationship capital to a price and a funding requirement.
 * No model touches a number; every number here is a constant of the policy.
 */

export const POLICY_ID = "terms@1" as const;

/** Relationship capital earned per clean period, basis points off the standard price. */
export const CAPITAL_PER_CLEAN_PERIOD = 250;
/** Relationship capital never exceeds this. */
export const CAPITAL_CAP = 2500;

export type IncidentKind = "close_with_unpaid" | "repeated_exceeds_deposit";

/** Risk premium per active incident, basis points on the standard price. */
export const PREMIUM_BPS: Readonly<Record<IncidentKind, number>> = {
  close_with_unpaid: 2000,
  repeated_exceeds_deposit: 1000,
};

/** The funding requirement in calls' worth of the price. */
export const FUNDING_CALLS = { standard: 20, floor: 5, incident: 50 } as const;

export interface Incident {
  readonly kind: IncidentKind;
  /** What the vendor saw: channel, period and what was owed. Private to the vendor; it goes on the receipt the buyer gets and nowhere else. */
  readonly evidence: string;
  /** ISO 8601, when the vendor recorded it. */
  readonly at: string;
}

export interface Terms {
  /** Atomic units. */
  readonly price: bigint;
  /** `price * fundingCalls`, atomic units. */
  readonly minDeposit: bigint;
  readonly fundingCalls: number;
  readonly premiumBps: number;
  readonly capitalBps: number;
  readonly policy: typeof POLICY_ID;
}

/**
 * The policy, exactly as briefing §3c writes it. `capitalBps` is the buyer's relationship
 * capital in basis points, `0..=CAPITAL_CAP`; `active` the incidents still counting.
 *
 * @throws RangeError on a non-positive standard price or a capital outside its range
 */
export function terms(standardPrice: bigint, active: readonly Incident[], capitalBps: number): Terms {
  if (standardPrice <= 0n) throw new RangeError("standardPrice must be positive");
  if (!Number.isSafeInteger(capitalBps) || capitalBps < 0 || capitalBps > CAPITAL_CAP) throw new RangeError(`capitalBps must be 0..=${CAPITAL_CAP}`);
  const premiumBps = active.reduce((a, i) => a + PREMIUM_BPS[i.kind], 0);
  const price = standardPrice + (standardPrice * BigInt(premiumBps)) / 10000n - (standardPrice * BigInt(capitalBps)) / 10000n;
  const fundingCalls = active.length ? FUNDING_CALLS.incident : Math.max(FUNDING_CALLS.floor, FUNDING_CALLS.standard - Math.floor(capitalBps / 125));
  return { price, minDeposit: price * BigInt(fundingCalls), fundingCalls, premiumBps, capitalBps, policy: POLICY_ID };
}

/** Relationship capital for a number of clean periods: `CAPITAL_PER_CLEAN_PERIOD` each, capped. */
export function capitalOf(cleanPeriods: number): number {
  if (!Number.isSafeInteger(cleanPeriods) || cleanPeriods < 0) throw new RangeError("cleanPeriods must be a non-negative integer");
  return Math.min(CAPITAL_CAP, cleanPeriods * CAPITAL_PER_CLEAN_PERIOD);
}

/** An unknown buyer's terms: no capital, no incidents. Nothing may make another buyer's terms worse than these without an incident. */
export function standardTerms(standardPrice: bigint): Terms {
  return terms(standardPrice, [], 0);
}
