import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aggregate, medianOf, medianOfBig, pickSamplePayer, signaturesOfPayer, weekOf } from "../../src/leak/aggregate.js";
import { address } from "./fixtures.js";
import { EXPECTED, syntheticEvents } from "./synthetic.js";

describe("leak aggregate", () => {
  it("aggregates a synthetic channel set to known counts", () => {
    const agg = aggregate(syntheticEvents());
    expect(agg.channels).toHaveLength(EXPECTED.channels);
    expect(agg.channelsOpened).toBe(EXPECTED.channelsOpened);
    expect(agg.channelsWithoutOpen).toBe(EXPECTED.channelsWithoutOpen);
    expect(agg.payers).toHaveLength(EXPECTED.payers);
    expect(agg.payTo).toHaveLength(EXPECTED.payTo);
    expect(agg.relationships).toBe(EXPECTED.relationships);
    expect(agg.payersWithTwoOrMorePayTo).toBe(EXPECTED.payersWithTwoOrMorePayTo);
    expect(agg.payersWithThreeOrMorePayTo).toEqual([address("payer-1")]);
    expect(agg.channelsPerPayer).toEqual(EXPECTED.channelsPerPayer);
    expect(agg.payToDegree[0]).toEqual({ payTo: address("vendor-1"), ...EXPECTED.vendor1 });
    expect(agg.payToDegree.slice(1).map((d) => d.payers)).toEqual([1, 1]);

    const sorted = [...EXPECTED.settledValues].sort((a, b) => (a < b ? -1 : 1));
    expect(agg.settled.mint).toBe(address("usdc"));
    expect(agg.settled.channelsWithSettlement).toBe(sorted.length);
    expect(agg.settled.channelsWithoutSettlement).toBe(1);
    expect(agg.settled.total).toBe(sorted.reduce((a, b) => a + b, 0n));
    expect(agg.settled.median).toBe(sorted[2]);
    expect(agg.settled.max).toBe(300_000n);
    expect(agg.settled.channelsInOtherMints).toBe(0);
    expect(agg.settled.channelsWithUnknownMint).toBe(1);
    expect(agg.payeeSeats).toBe(1);
    expect(agg.channelsPerWeek).toEqual(EXPECTED.weeks);
    expect(agg.instructions).toEqual({ open: 6, settle: 11, topUp: 0, settleAndSeal: 0, requestClose: 0, seal: 1, distribute: 5, withdrawPayer: 1, reclaim: 0 });
    expect(agg.channelsWithFeeRecipient).toBe(1);
    expect(agg.mints.get(address("usdc"))).toBe(6);

    // Per channel: the settle's max cumulative wins over the payout, the refund is read from the transfer.
    const channel1 = agg.channels.find((c) => c.channel === address("channel-1"))!;
    expect(channel1).toMatchObject({ payer: address("payer-1"), payTo: address("vendor-1"), payee: address("facilitator-seat"), settled: 300_000n, paidOut: 300_000n, refunded: 700_000n, sealed: true, deposit: 1_000_000n });
    // The payee seat is never the payTo, and the fee recipient (100 bps) never outranks the vendor (9900).
    expect(agg.payTo).not.toContain(address("facilitator-seat"));
    expect(agg.payTo).not.toContain(address("facilitator-fee"));
    // channel-6 was opened with the layout before openSlot; it still has its payer, payTo and mint.
    expect(agg.channels.find((c) => c.channel === address("channel-6"))).toMatchObject({ payer: address("payer-3"), payTo: address("vendor-1"), mint: address("usdc"), settled: 20_000n });
    expect(channel1.recipients).toEqual([address("vendor-1"), address("facilitator-fee")].sort());
    // The channel without an open has no payer and no payTo; it still counts as a channel with a settlement.
    const channel7 = agg.channels.find((c) => c.channel === address("channel-7"))!;
    expect(channel7).toMatchObject({ payer: null, payTo: null, payee: null, mint: null, openedAt: null, settled: 5_000n });
  });

  it("picks the payer with three or more payTo and lists its signatures", () => {
    const agg = aggregate(syntheticEvents());
    expect(pickSamplePayer(agg)).toBe(address("payer-1"));
    // channel-1: open, 2 settles, distribute, seal, refund; channel-2: open, 2 settles, distribute; channel-3: open.
    expect(signaturesOfPayer(agg, address("payer-1"))).toHaveLength(11);
    expect(pickSamplePayer(aggregate([]))).toBeNull();
  });

  it("the order of events does not change the aggregate", () => {
    const events = syntheticEvents();
    const expected = JSON.stringify(aggregate(events), (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? [...v] : v));
    fc.assert(
      fc.property(fc.shuffledSubarray(events, { minLength: events.length }), (shuffled) => {
        expect(JSON.stringify(aggregate(shuffled), (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v instanceof Map ? [...v] : v))).toBe(expected);
      }),
      { numRuns: 30 },
    );
  });

  it("medians and weeks", () => {
    expect(medianOf([])).toBe(0);
    expect(medianOf([3])).toBe(3);
    expect(medianOf([1, 3, 2])).toBe(2);
    expect(medianOf([1, 4])).toBe(2);
    expect(medianOfBig([])).toBe(0n);
    expect(medianOfBig([5n, 1n, 3n])).toBe(3n);
    expect(medianOfBig([1n, 4n])).toBe(2n);
    expect(weekOf(Date.UTC(2026, 10, 7) / 1000)).toBe("2026-11-02"); // a Saturday → its Monday
    expect(weekOf(Date.UTC(2026, 10, 2) / 1000)).toBe("2026-11-02"); // a Monday → itself
    expect(weekOf(Date.UTC(2026, 10, 8, 23, 59) / 1000)).toBe("2026-11-02"); // a Sunday → the Monday before
  });
});
