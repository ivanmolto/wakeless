/**
 * The privacy fee share the buyer adds to each voucher step so the vendor nets the
 * route's price (`docs/SCHEME.md` §4.2, `privacyFeeBps`). Rounded up: a share that
 * rounded down would leave the vendor short by a base unit, and the facilitator only
 * checks `cumulative >= prev + amount` (`nextWatermark`).
 */
export function feeShare(amount: bigint, privacyFeeBps: number): bigint {
  if (amount < 0n) throw new RangeError("amount must not be negative");
  if (!Number.isSafeInteger(privacyFeeBps) || privacyFeeBps < 0 || privacyFeeBps > 10_000) {
    throw new RangeError("privacyFeeBps must be an integer in 0..=10000");
  }
  return (amount * BigInt(privacyFeeBps) + 9_999n) / 10_000n;
}

/** What one request moves the cumulative by: the price plus the fee share. */
export function chargeOf(amount: bigint, privacyFeeBps: number): bigint {
  return amount + feeShare(amount, privacyFeeBps);
}
