// The parser of external input is fuzzed: arbitrary JSON either parses or throws the typed
// WatcherParseError, never anything else. The real fixtures parse to what the spike and the
// public-rail log recorded by hand.
import { signature as asSignature } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { observerViewOf, parseBaseTransaction, WatcherParseError } from "../src/parse.js";
import { BUYER, PUBLIC_FACILITATOR, PUBLIC_PAYER, PUBLIC_SIGNATURES, VAULT_OWNER, VENDOR1_ATA, WAKELESS_SIGNATURES, publicRaw, wakelessRaw } from "./fixtures/index.js";

const SIG = asSignature("5XKE2bt32CvgwRSNc4iaESJUd397WQLut7xHSudQK18YnGXACvEMLAsMU7AVAmy4BL66PpGxxPsx2ntc2Lz319bp");

describe("parseBaseTransaction", () => {
  it("reads the vault → vendor1 release as the spike log recorded it", () => {
    const tx = parseBaseTransaction(WAKELESS_SIGNATURES.vendorWithdraw, wakelessRaw[WAKELESS_SIGNATURES.vendorWithdraw]);
    expect(tx.onBaseLayer).toBe(true);
    expect(tx.slot).toBe(517194528);
    expect(tx.blockTime).toBe(1793464081);
    expect(tx.signers).toEqual(["MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"]);
    expect(tx.memoText).toEqual([]);
    expect(tx.feeTransfers).toHaveLength(2);
    expect(tx.feeTransfers.every((f) => f.lamports === 391040n)).toBe(true);
    expect(tx.transfers).toEqual([expect.objectContaining({ amount: 250000n, destination: VENDOR1_ATA, authority: VAULT_OWNER, inner: true, outerIndex: 2 })]);
    expect(tx.plaintextRecipients).toEqual([VENDOR1_ATA]);
    expect(tx.tokenOwners.get(VENDOR1_ATA)).toBe("ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm");
    expect(tx.accountKeys).toHaveLength(23);
    // The raw instructions keep their data for reconstruct().
    expect(tx.instructions.filter((ix) => !ix.inner)).toHaveLength(4);
    expect(tx.instructions[0]?.data).toBeInstanceOf(Uint8Array);
  });

  it("reads the public-rail open as docs/public-rail-log.md recorded it", () => {
    const tx = parseBaseTransaction(PUBLIC_SIGNATURES.open, publicRaw[PUBLIC_SIGNATURES.open]);
    expect(tx.signers).toEqual([PUBLIC_FACILITATOR, PUBLIC_PAYER]);
    expect(tx.memoText).toEqual(["2e605fad87e25cba41109890f2c25008", "x402:batch-settlement:svm:rcvauth:v1:BgNduYkRLcfyScrbKpd5FVd9o9heJ5uUbizrhmDdGAWM"]);
    expect(tx.feeTransfers).toEqual([{ from: PUBLIC_FACILITATOR, to: "B3vHFnqZTLHXcvczbzhTv2enAsg6CjmvmtjqvyPiukSQ", lamports: 1950720n }]);
    expect(tx.transfers.map((t) => t.amount)).toEqual([100000n]);
    expect(tx.plaintextAmounts.filter((a) => a.kind === "balanceDelta").map((a) => [a.owner, a.amount])).toEqual([
      ["B3vHFnqZTLHXcvczbzhTv2enAsg6CjmvmtjqvyPiukSQ", 100000n],
      [PUBLIC_PAYER, 100000n],
    ]);
  });

  it("a null response is not on the base layer and reads empty", () => {
    const tx = parseBaseTransaction(SIG, null);
    expect(tx.onBaseLayer).toBe(false);
    expect(observerViewOf(tx)).toEqual({ signature: SIG, onBaseLayer: false, programIds: [], signers: [], plaintextAmounts: [], plaintextRecipients: [], memoText: [], feeTransfers: [] });
  });

  it("the vault deposit names the buyer and the vault, not a vendor", () => {
    const tx = parseBaseTransaction(WAKELESS_SIGNATURES.vaultDeposit, wakelessRaw[WAKELESS_SIGNATURES.vaultDeposit]);
    expect(tx.signers).toEqual([BUYER]);
    expect(tx.transfers).toEqual([expect.objectContaining({ amount: 2000000n, authority: BUYER, inner: true })]);
    expect(tx.tokenOwners.get(tx.transfers[0]!.destination)).toBe(VAULT_OWNER);
    expect(tx.memoText).toEqual([]);
  });

  it("arbitrary JSON parses or throws WatcherParseError", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        try {
          parseBaseTransaction(SIG, json);
        } catch (error) {
          expect(error, JSON.stringify(json)?.slice(0, 200)).toBeInstanceOf(WatcherParseError);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("near misses of the real shape throw WatcherParseError", () => {
    const real = wakelessRaw[WAKELESS_SIGNATURES.vendorWithdraw] as Record<string, unknown>;
    const mutate = (patch: (copy: Record<string, unknown>) => void): unknown => {
      const copy = structuredClone(real);
      patch(copy);
      return copy;
    };
    const bad = [
      mutate((c) => ((c.transaction as Record<string, unknown>).message = 1)),
      mutate((c) => (((c.transaction as Record<string, unknown>).message as Record<string, unknown>).accountKeys = [{ pubkey: "not-an-address", signer: true }])),
      mutate((c) => (((c.transaction as Record<string, unknown>).message as Record<string, unknown>).instructions = [{ programId: "x" }])),
      mutate((c) => (((c.transaction as Record<string, unknown>).message as Record<string, unknown>).instructions = [{ programId: "11111111111111111111111111111111", data: "0OIl" }])),
      mutate((c) => ((c.meta as Record<string, unknown>).postTokenBalances = [{ accountIndex: 99, uiTokenAmount: { amount: "1" } }])),
      mutate((c) => ((c.meta as Record<string, unknown>).postTokenBalances = [{ accountIndex: 1, uiTokenAmount: { amount: "-1" } }])),
      mutate((c) => (c.slot = "x")),
    ];
    for (const json of bad) expect(() => parseBaseTransaction(SIG, json)).toThrow(WatcherParseError);
  });
});
