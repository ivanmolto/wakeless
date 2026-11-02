// Every parser of external input is fuzzed: arbitrary JSON either parses or throws the
// typed MalformedResponseError, never anything else. Plus the pure policy functions.
import { signature as asSignature } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MalformedResponseError, parseBuiltTransaction, parseChallenge, parseLoginToken, parsePrivateBalance, parseTeeTransaction, referenceIdsIn } from "../src/api.js";
import { decodeSignedTransaction, UndecodableTransactionError } from "../src/deposit.js";
import { parseObserverView } from "../src/observe.js";
import { DEFAULT_DELAY_WINDOW_MS, pickDelay, splitFor, USDC_BASE_UNITS } from "../src/policy.js";
import { BASE_WITHDRAWAL } from "./fixtures/base-withdrawal.js";

const SIG = asSignature("5XKE2bt32CvgwRSNc4iaESJUd397WQLut7xHSudQK18YnGXACvEMLAsMU7AVAmy4BL66PpGxxPsx2ntc2Lz319bp");

function onlyMalformed(parse: (json: unknown) => unknown) {
  return (json: unknown) => {
    try {
      parse(json);
    } catch (error) {
      expect(error, JSON.stringify(json)?.slice(0, 200)).toBeInstanceOf(MalformedResponseError);
    }
  };
}

describe("Payments API parsers", () => {
  it("accept the shapes the spike recorded", () => {
    expect(parsePrivateBalance({ address: "a", mint: "m", ata: "t", location: "ephemeral", balance: "510000", delegation: { status: "delegated", validator: "v", endpoint: "e" } })).toEqual({
      address: "a", mint: "m", ata: "t", location: "ephemeral", balance: 510_000n, delegation: { status: "delegated", validator: "v", endpoint: "e" },
    });
    expect(parseBuiltTransaction({ kind: "spl.transfer", version: "v0", transactionBase64: "AQID", sendTo: "ephemeral", sendRpcEndpoint: "https://devnet-tee.magicblock.app", recentBlockhash: "b", lastValidBlockHeight: 1, instructionCount: 1, requiredSigners: ["s"], validator: "v", fees: { lamports: "0", tokens: "0" } })).toMatchObject({ sendTo: "ephemeral", requiredSigners: ["s"], instructionCount: 1 });
    expect(parseTeeTransaction(null)).toBeNull();
    expect(parseTeeTransaction({ slot: 1, meta: { err: null }, blockTime: 2 })).toEqual({ err: null, slot: 1, blockTime: 2 });
    expect(parseTeeTransaction({ meta: { err: { InstructionError: [0, "x"] } } })).toEqual({ err: { InstructionError: [0, "x"] }, slot: null, blockTime: null });
    expect(parseChallenge({ challenge: "c" })).toBe("c");
    expect(parseLoginToken({ token: "t" })).toBe("t");
  });

  it("reject near misses", () => {
    expect(() => parsePrivateBalance({ address: "a", mint: "m", ata: "t", location: "ephemeral", balance: "-1" })).toThrow(MalformedResponseError);
    expect(() => parsePrivateBalance({ address: "a", mint: "m", ata: "t", location: "ephemeral", balance: 510000 })).toThrow(MalformedResponseError);
    expect(() => parseBuiltTransaction({ kind: "k", version: "v1", transactionBase64: "AQID", sendTo: "ephemeral", recentBlockhash: "b", lastValidBlockHeight: 1, requiredSigners: [] })).toThrow(MalformedResponseError);
    expect(() => parseBuiltTransaction({ kind: "k", version: "v0", transactionBase64: "not base64!", sendTo: "ephemeral", recentBlockhash: "b", lastValidBlockHeight: 1, requiredSigners: [] })).toThrow(MalformedResponseError);
    expect(() => parseBuiltTransaction({ kind: "k", version: "v0", transactionBase64: "AQID", sendTo: "elsewhere", recentBlockhash: "b", lastValidBlockHeight: 1, requiredSigners: [] })).toThrow(MalformedResponseError);
    expect(() => parseLoginToken({ token: "" })).toThrow(MalformedResponseError);
  });

  it("throw only MalformedResponseError on arbitrary JSON (fuzz)", () => {
    const json = fc.jsonValue();
    for (const parse of [parsePrivateBalance, parseBuiltTransaction, parseTeeTransaction, parseChallenge, parseLoginToken, (j: unknown) => parseObserverView(SIG, j)]) {
      fc.assert(fc.property(json, onlyMalformed(parse)), { numRuns: 300 });
    }
    // Near-miss records: the right keys with random values.
    const record = fc.record({ address: fc.jsonValue(), mint: fc.jsonValue(), ata: fc.jsonValue(), location: fc.jsonValue(), balance: fc.jsonValue(), delegation: fc.jsonValue() }, { requiredKeys: [] });
    fc.assert(fc.property(record, onlyMalformed(parsePrivateBalance)), { numRuns: 300 });
    const built = fc.record({ kind: fc.jsonValue(), version: fc.jsonValue(), transactionBase64: fc.jsonValue(), sendTo: fc.jsonValue(), sendRpcEndpoint: fc.jsonValue(), recentBlockhash: fc.jsonValue(), lastValidBlockHeight: fc.jsonValue(), requiredSigners: fc.jsonValue() }, { requiredKeys: [] });
    fc.assert(fc.property(built, onlyMalformed(parseBuiltTransaction)), { numRuns: 300 });
  });
});

describe("reference ids in a response", () => {
  it("finds reference-like fields at any depth, none in the spike's private-balance answer, and never throws (fuzz)", () => {
    const spike = { address: "a", mint: "m", ata: "t", location: "ephemeral", balance: "760000", delegation: { status: "delegated", validator: "v", endpoint: "e" }, onboarding: "already delegated" };
    expect(referenceIdsIn(spike)).toEqual([]);
    expect(referenceIdsIn({ ...spike, clientRefId: "2001", history: [{ memo: "x" }, { reference: 7 }], nested: { referenceIds: ["1", "2"] } })).toEqual(["2001", "x", "7", "1", "2"]);
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        const out = referenceIdsIn(json);
        expect(out.every((v) => typeof v === "string")).toBe(true);
      }),
      { numRuns: 500 },
    );
  });
});

describe("observer view parser", () => {
  it("reads the validator-signed withdrawal fixture", () => {
    const view = parseObserverView(SIG, BASE_WITHDRAWAL);
    expect(view.onBaseLayer).toBe(true);
    expect(view.programIds).toEqual([
      "DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh",
      "noopb9bkMVfRPU8AsbpTUg8AQkHtKwMYZiFUjNRtMmV",
      "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2",
      "11111111111111111111111111111111",
      "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    ]);
    expect(view.plaintextAmounts.filter((a) => a.kind === "balanceDelta")).toEqual([
      { amount: 250_000n, kind: "balanceDelta", destination: "TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r", owner: "EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
      { amount: 250_000n, kind: "balanceDelta", destination: "CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf", owner: "ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm", mint: "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" },
    ]);
  });

  it("captures memo text and ignores unknown fields", () => {
    const tx = {
      transaction: { message: { accountKeys: [{ pubkey: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo", signer: true }], instructions: [{ programId: "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", parsed: "channel 2001", extra: 1 }] } },
      meta: { err: null, somethingNew: true },
    };
    expect(parseObserverView(SIG, tx).memoText).toEqual(["channel 2001"]);
    expect(() => parseObserverView(SIG, { transaction: { message: { accountKeys: [{ pubkey: "not-an-address", signer: true }], instructions: [] } } })).toThrow(MalformedResponseError);
  });
});

describe("decodeSignedTransaction", () => {
  it("throws only UndecodableTransactionError on arbitrary input (fuzz)", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.base64String(), fc.uint8Array().map((b) => Buffer.from(b).toString("base64"))), (input) => {
        try {
          decodeSignedTransaction(input);
        } catch (error) {
          expect(error).toBeInstanceOf(UndecodableTransactionError);
        }
      }),
      { numRuns: 500 },
    );
  });
});

describe("policy", () => {
  it("pickDelay stays inside any window for any random draw (fuzz)", () => {
    fc.assert(
      fc.property(fc.nat(600_000), fc.nat(600_000), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), fc.double({ min: 0, max: 1, maxExcluded: true, noNaN: true }), (a, b, r1, r2) => {
        const window = { min: Math.min(a, b), max: Math.max(a, b) };
        const draws = [r1, r2];
        const d = pickDelay(window, () => draws.shift() ?? 0);
        expect(d.minDelayMs).toBeGreaterThanOrEqual(window.min);
        expect(d.maxDelayMs).toBeLessThanOrEqual(window.max);
        expect(d.minDelayMs).toBeLessThanOrEqual(d.maxDelayMs);
      }),
    );
    // Hostile randoms are clamped, never escape the window.
    for (const r of [-1, 1, 2, Number.NaN, Number.POSITIVE_INFINITY]) {
      const d = pickDelay(DEFAULT_DELAY_WINDOW_MS, () => r);
      expect(d.minDelayMs).toBeGreaterThanOrEqual(30_000);
      expect(d.maxDelayMs).toBeLessThanOrEqual(300_000);
    }
    expect(() => pickDelay({ min: 10, max: 5 })).toThrow(RangeError);
    expect(() => pickDelay({ min: 0.5, max: 5 })).toThrow(RangeError);
  });

  it("splitFor is 1 under 2 USDC, one per whole USDC above, capped at 5", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000n * USDC_BASE_UNITS }), (amount) => {
        const split = splitFor(amount);
        if (amount < 2n * USDC_BASE_UNITS) expect(split).toBe(1);
        else expect(BigInt(split)).toBe(amount / USDC_BASE_UNITS > 5n ? 5n : amount / USDC_BASE_UNITS);
        expect(BigInt(split)).toBeLessThanOrEqual(amount);
      }),
    );
    expect(() => splitFor(0n)).toThrow(RangeError);
  });
});
