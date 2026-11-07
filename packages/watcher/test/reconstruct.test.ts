import { type Address } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { compare, decodeOpen, decodeVouchers, reconstruct, renderComparison, renderTrajectory, trajectoryToJson, type Trajectory } from "../src/reconstruct.js";
import { BUYER, PUBLIC_PAYER, PUBLIC_PAYTO, PUBLIC_SIGNATURES, VAULT_OWNER, VENDORS, WAKELESS_SIGNATURES, exactRaw, parsed, publicRaw, wakelessRaw } from "./fixtures/index.js";

/** The hand-written block of docs/public-rail-log.md, "What an observer rebuilds". */
const HAND_WRITTEN: Trajectory = {
  payer: PUBLIC_PAYER,
  vendors: [PUBLIC_PAYTO],
  firstContactOrder: [PUBLIC_PAYTO],
  spendPerVendor: { [PUBLIC_PAYTO]: 100000n },
  settlementTimes: [1793487579],
};

/** The owner's view of the 6 Nov e2e run (`~/.wakeless/e2e-2026-11-06T22-38-00-687Z.json`): three channels, cumulative accepted per vendor. */
const WAKELESS_ACTUAL: Trajectory = {
  payer: BUYER,
  vendors: VENDORS,
  firstContactOrder: VENDORS,
  spendPerVendor: { [VENDORS[0]!]: 10010n, [VENDORS[1]!]: 20020n, [VENDORS[2]!]: 30030n },
  settlementTimes: [],
};

describe("reconstruct", () => {
  it("public-rail fixture recovers every vendor, all spend and the first-contact order", () => {
    const { edges, ...trajectory } = reconstruct(parsed(publicRaw));
    expect(trajectory).toEqual(HAND_WRITTEN);
    expect(edges).toEqual([]);
    expect(compare(trajectory, HAND_WRITTEN)).toEqual({ vendorsRecovered: 1, vendorsActual: 1, spendRecoveredBps: 10000, orderRecovered: true });
  });

  it("the open alone already names the payer and the vendor; the settle alone gives the amount but no vendor", () => {
    const open = reconstruct(parsed({ [PUBLIC_SIGNATURES.open]: publicRaw[PUBLIC_SIGNATURES.open] }));
    expect(open).toMatchObject({ payer: PUBLIC_PAYER, vendors: [PUBLIC_PAYTO], spendPerVendor: { [PUBLIC_PAYTO]: 0n }, settlementTimes: [] });
    const settle = reconstruct(parsed({ [PUBLIC_SIGNATURES.settle]: publicRaw[PUBLIC_SIGNATURES.settle] }));
    expect(settle).toMatchObject({ vendors: [], settlementTimes: [1793487579] });
    expect(settle.payer).toBeUndefined();
    // The distribute alone recovers the payer, the vendor and the payout.
    const distribute = reconstruct(parsed({ [PUBLIC_SIGNATURES.distribute]: publicRaw[PUBLIC_SIGNATURES.distribute] }));
    expect(distribute).toMatchObject({ payer: PUBLIC_PAYER, vendors: [PUBLIC_PAYTO], spendPerVendor: { [PUBLIC_PAYTO]: 100000n } });
  });

  it("exact-rail fixture recovers the vendor, the spend and every call's time", () => {
    const t = reconstruct(parsed(exactRaw));
    expect(t.payer).toBe(PUBLIC_PAYER);
    expect(t.vendors).toEqual([PUBLIC_PAYTO]);
    expect(t.spendPerVendor).toEqual({ [PUBLIC_PAYTO]: 50000n });
    expect(t.settlementTimes).toHaveLength(5);
    expect(t.edges).toEqual([]);
  });

  it("Wakeless fixture recovers no vendor and no spend", () => {
    // A recovering fixture is a failing test, not a tunable.
    const t = reconstruct(parsed(wakelessRaw));
    expect(t.payer).toBeUndefined();
    expect(t.vendors).toEqual([]);
    expect(t.firstContactOrder).toEqual([]);
    expect(t.spendPerVendor).toEqual({});
    expect(t.settlementTimes).toEqual([]);
    for (const vendor of VENDORS) {
      expect(t.vendors).not.toContain(vendor);
      expect(t.spendPerVendor[vendor]).toBeUndefined();
    }
    // What remains readable, exactly: the two vault edges, unlinked to each other and to any payer.
    expect(t.edges).toEqual([
      { signature: WAKELESS_SIGNATURES.vaultDeposit, blockTime: 1793462596, program: "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2", from: BUYER, to: VAULT_OWNER, amount: 2000000n, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
      { signature: WAKELESS_SIGNATURES.vendorWithdraw, blockTime: 1793464081, program: "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh", from: VAULT_OWNER, to: VENDORS[0], amount: 250000n, mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
    ]);
    expect(compare(t, WAKELESS_ACTUAL)).toEqual({ vendorsRecovered: 0, vendorsActual: 3, spendRecoveredBps: 0, orderRecovered: false });
  });

  it("compare reports vendorsRecovered, spendRecoveredBps and orderRecovered", () => {
    const [v1, v2, v3] = VENDORS as [Address, Address, Address];
    // Two of three vendors, half the spend, wrong order.
    const partial: Trajectory = { payer: BUYER, vendors: [v2, v1], firstContactOrder: [v2, v1], spendPerVendor: { [v2]: 20020n, [v1]: 10010n }, settlementTimes: [1] };
    expect(compare(partial, WAKELESS_ACTUAL)).toEqual({ vendorsRecovered: 2, vendorsActual: 3, spendRecoveredBps: 5000, orderRecovered: false });
    // Over-recovery is capped at the actual spend; a vendor the owner never paid does not count.
    const over: Trajectory = { vendors: [v1, v2, v3, PUBLIC_PAYTO], firstContactOrder: [v1, v2, v3, PUBLIC_PAYTO], spendPerVendor: { [v1]: 99999n, [v2]: 20020n, [v3]: 30030n, [PUBLIC_PAYTO]: 5n }, settlementTimes: [] };
    expect(compare(over, WAKELESS_ACTUAL)).toEqual({ vendorsRecovered: 3, vendorsActual: 3, spendRecoveredBps: 10000, orderRecovered: false });
    // Full recovery is the identity.
    expect(compare(WAKELESS_ACTUAL, WAKELESS_ACTUAL)).toEqual({ vendorsRecovered: 3, vendorsActual: 3, spendRecoveredBps: 10000, orderRecovered: true });
    expect(renderComparison(compare(partial, WAKELESS_ACTUAL))).toContain("| Vendors recovered / actual | 2 / 3 |");
    expect(renderComparison(compare(partial, WAKELESS_ACTUAL))).toContain("| Spend recovered | 50.00% |");
  });

  it("the order of the signatures does not change the result", () => {
    const transactions = [...parsed(publicRaw), ...parsed(exactRaw), ...parsed(wakelessRaw)];
    const expected = trajectoryToJson(reconstruct(transactions));
    fc.assert(
      fc.property(fc.shuffledSubarray(transactions, { minLength: transactions.length }), (shuffled) => {
        expect(trajectoryToJson(reconstruct(shuffled))).toBe(expected);
      }),
      { numRuns: 50 },
    );
  });

  it("decoders refuse what is not theirs and never throw", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 300 }), (bytes) => {
        decodeOpen(bytes);
        decodeVouchers(bytes);
      }),
      { numRuns: 300 },
    );
    expect(decodeOpen(null)).toBeNull();
    expect(decodeOpen(new Uint8Array([1, 2, 3]))).toBeNull();
    expect(decodeVouchers(new Uint8Array([1]))).toEqual([]);
    // The public-rail open, decoded as docs/public-rail-log.md reads it.
    const open = parsed({ [PUBLIC_SIGNATURES.open]: publicRaw[PUBLIC_SIGNATURES.open] })[0]!.instructions.find((ix) => ix.programId === "CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX" && !ix.inner)!;
    expect(decodeOpen(open.data)).toEqual({ salt: 0n, deposit: 100000n, gracePeriod: 900, openSlot: 517292432n, recipients: [{ recipient: PUBLIC_PAYTO, bps: 10000 }] });
    const ed25519 = parsed({ [PUBLIC_SIGNATURES.settle]: publicRaw[PUBLIC_SIGNATURES.settle] })[0]!.instructions.find((ix) => ix.programId === "Ed25519SigVerify111111111111111111111111111")!;
    expect(decodeVouchers(ed25519.data)).toEqual([{ channelId: "B3vHFnqZTLHXcvczbzhTv2enAsg6CjmvmtjqvyPiukSQ", cumulativeAmount: 100000n, expiresAt: 0n, signer: PUBLIC_PAYER }]);
  });

  it("renders the block in the shape of the hand-written one", () => {
    const text = renderTrajectory(reconstruct(parsed(publicRaw)));
    expect(text).toContain(`- **Payer:** \`${PUBLIC_PAYER}\``);
    expect(text).toContain(`- **Vendor set:** \`${PUBLIC_PAYTO}\``);
    expect(text).toContain(`- **Cumulative spend per vendor:** \`${PUBLIC_PAYTO}\`: 100000`);
    expect(text).toContain("- **Settlement times:** 1793487579 (2026-10-31T22:59:39Z)");
    const empty = renderTrajectory(reconstruct(parsed(wakelessRaw)));
    expect(empty).toContain("- **Vendor set:** none recovered");
    expect(empty).toContain("- **Edges, unlinked to any payer:** 2000000");
  });
});
