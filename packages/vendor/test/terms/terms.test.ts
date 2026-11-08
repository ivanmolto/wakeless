import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { CAPITAL_CAP, FUNDING_CALLS, POLICY_ID, capitalOf, standardTerms, terms, type Incident } from "../../src/index.js";

const P = 10_000n; // 0.01 USDC
const at = "2026-11-08T00:00:00.000Z";
const closeWithUnpaid: Incident = { kind: "close_with_unpaid", evidence: "channel abcd…wxyz closed owing 1000 after the grace period", at };
const repeated: Incident = { kind: "repeated_exceeds_deposit", evidence: "3 corrective 402s in one period of channel abcd…wxyz", at };

describe("terms@1", () => {
  it("unknown buyer gets standard price and 20 funding calls", () => {
    const t = terms(P, [], 0);
    expect(t).toEqual({ price: P, minDeposit: P * 20n, fundingCalls: 20, premiumBps: 0, capitalBps: 0, policy: POLICY_ID });
    expect(standardTerms(P)).toEqual(t);
    expect(POLICY_ID).toBe("terms@1");
  });

  it("one, three and seven clean periods lower price and funding calls monotonically", () => {
    // The briefing's worked numbers at 0.01 USDC: seven clean periods → 0.00825, 6 calls, 0.0495.
    const rows = [1, 3, 7].map((n) => terms(P, [], capitalOf(n)));
    expect(rows.map((t) => [t.capitalBps, t.price, t.fundingCalls, t.minDeposit])).toEqual([
      [250, 9_750n, 18, 175_500n],
      [750, 9_250n, 14, 129_500n],
      [1750, 8_250n, 6, 49_500n],
    ]);
    for (let i = 1; i < rows.length; i++) {
      expect(rows[i]!.price).toBeLessThan(rows[i - 1]!.price);
      expect(rows[i]!.fundingCalls).toBeLessThan(rows[i - 1]!.fundingCalls);
      expect(rows[i]!.minDeposit).toBeLessThan(rows[i - 1]!.minDeposit);
    }
    expect(rows[0]!.price).toBeLessThan(standardTerms(P).price);
  });

  it("close_with_unpaid adds 2000 bps and 50 funding calls", () => {
    const t = terms(P, [closeWithUnpaid], 0);
    expect(t).toMatchObject({ price: 12_000n, fundingCalls: 50, minDeposit: 600_000n, premiumBps: 2000 });
    // Capital does not buy the incident off: seven clean periods and one close still cost more than standard.
    const withCapital = terms(P, [closeWithUnpaid], capitalOf(7));
    expect(withCapital.price).toBe(10_250n);
    expect(withCapital.fundingCalls).toBe(50);
  });

  it("repeated_exceeds_deposit adds 1000 bps", () => {
    expect(terms(P, [repeated], 0)).toMatchObject({ price: 11_000n, fundingCalls: 50, premiumBps: 1000 });
    expect(terms(P, [closeWithUnpaid, repeated], 0)).toMatchObject({ price: 13_000n, premiumBps: 3000, fundingCalls: 50 });
  });

  it("capital caps at 2500 bps and funding floors at 5 calls", () => {
    expect(capitalOf(10)).toBe(CAPITAL_CAP);
    expect(capitalOf(1000)).toBe(CAPITAL_CAP);
    const capped = terms(P, [], CAPITAL_CAP);
    expect(capped.price).toBe(7_500n);
    expect(capped.fundingCalls).toBe(FUNDING_CALLS.floor);
    expect(capped.minDeposit).toBe(37_500n);
    expect(() => terms(P, [], CAPITAL_CAP + 1)).toThrow(RangeError);
    expect(() => terms(0n, [], 0)).toThrow(RangeError);
    expect(() => capitalOf(-1)).toThrow(RangeError);
  });

  it("an unknown buyer is never better than standard", () => {
    // Over every history: a buyer with no incident pays at most the standard price and funds at most
    // the standard calls, so a rotated address (an unknown buyer) can never buy a discount.
    const incidentArb = fc.constantFrom<Incident>(closeWithUnpaid, repeated);
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: (1n << 64n) - 1n }), fc.nat({ max: 10_000 }), fc.array(incidentArb, { maxLength: 4 }), (standardPrice, cleanPeriods, incidents) => {
        const unknown = standardTerms(standardPrice);
        const known = terms(standardPrice, incidents, capitalOf(cleanPeriods));
        if (incidents.length === 0) {
          expect(known.price <= unknown.price).toBe(true);
          expect(known.fundingCalls).toBeLessThanOrEqual(unknown.fundingCalls);
          expect(known.minDeposit <= unknown.minDeposit).toBe(true);
        } else {
          expect(known.fundingCalls).toBe(FUNDING_CALLS.incident);
        }
        expect(known.price > 0n || standardPrice < 4n).toBe(true);
        expect(known.policy).toBe(POLICY_ID);
      }),
      { numRuns: 300 },
    );
  });
});
