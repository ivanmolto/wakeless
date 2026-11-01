// The two header parsers against arbitrary input: they never throw, a well-formed 402
// round-trips with its shielded entries kept as the objects they came as, and a
// corrupted field drops the entry rather than repairing it.
import { randomBytes } from "node:crypto";
import { DEVNET_CAIP2, SCHEME_ID, encodeBase58, type PaymentRequirements } from "@wakeless/scheme";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { encodeHeader, parsePaymentRequired, parsePaymentResponse, parseShieldedAccept } from "../src/parse.js";

const address = () => encodeBase58(randomBytes(32));

function accept(overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: SCHEME_ID,
    network: DEVNET_CAIP2,
    amount: "1000",
    asset: address(),
    payTo: address(),
    maxTimeoutSeconds: 60,
    extra: { paymentFlow: "authorization", voucherSigner: "client", withdrawDelay: 3600, tokenProgram: address(), minDeposit: "100000", maxIdleSecs: 604_800, escrowAddress: address(), binding: "magicblock", teeValidator: address(), privacyFeeBps: 10 },
    ...overrides,
  };
}

const u64 = fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }).map((n) => n.toString());

describe("402 header parsers", () => {
  it("never throw on arbitrary header strings or JSON", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.string().map((s) => Buffer.from(s).toString("base64")), fc.json().map((j) => Buffer.from(j).toString("base64")), fc.constant(null), fc.constant(undefined)), (header) => {
        const required = parsePaymentRequired(header);
        if (required !== undefined) expect(Array.isArray(required.accepts)).toBe(true);
        const response = parsePaymentResponse(header);
        if (response !== undefined) expect(typeof response.success).toBe("boolean");
      }),
      { numRuns: 300 },
    );
    fc.assert(
      fc.property(fc.anything(), (entry) => {
        expect(() => parseShieldedAccept(entry)).not.toThrow();
      }),
      { numRuns: 300 },
    );
  });

  it("a well-formed 402 round-trips and keeps each entry as the object it came as", () => {
    fc.assert(
      fc.property(u64, u64, fc.integer({ min: 900, max: 2_592_000 }), fc.integer({ min: 0, max: 10_000 }), fc.option(fc.string(), { nil: undefined }), (amount, minDeposit, withdrawDelay, bps, error) => {
        const entry = accept({ amount, extra: { ...accept().extra, minDeposit, withdrawDelay, privacyFeeBps: bps, unknownKey: "kept" } as PaymentRequirements["extra"] });
        const other = { scheme: "exact", network: DEVNET_CAIP2, amount: "1", asset: address(), payTo: address(), maxTimeoutSeconds: 60, extra: {} };
        const header = encodeHeader({ x402Version: 2, ...(error === undefined ? {} : { error }), resource: { url: "http://v.test/x" }, accepts: [other, entry] });
        const parsed = parsePaymentRequired(header);
        expect(parsed).toBeDefined();
        expect(parsed!.error).toBe(error);
        expect(parsed!.accepts).toHaveLength(1);
        expect(parsed!.accepts[0]).toEqual(entry);
      }),
      { numRuns: 100 },
    );
  });

  it("a corrupted field drops the entry", () => {
    const base = accept();
    const corruptions: [string, unknown][] = [
      ["scheme", { ...base, scheme: "batch-settlement" }],
      ["network", { ...base, network: "eip155:1" }],
      ["amount", { ...base, amount: "01" }],
      ["amount", { ...base, amount: 1000 }],
      ["payTo", { ...base, payTo: "vendor" }],
      ["maxTimeoutSeconds", { ...base, maxTimeoutSeconds: 0 }],
      ["withdrawDelay", { ...base, extra: { ...base.extra, withdrawDelay: 899 } }],
      ["binding", { ...base, extra: { ...base.extra, binding: "public" } }],
      ["teeValidator", { ...base, extra: { ...base.extra, teeValidator: "" } }],
      ["privacyFeeBps", { ...base, extra: { ...base.extra, privacyFeeBps: 10_001 } }],
      ["privacyFeeBps", { ...base, extra: { ...base.extra, privacyFeeBps: "10" } }],
      ["minDeposit", { ...base, extra: { ...base.extra, minDeposit: 100000 } }],
      ["paymentFlow", { ...base, extra: { ...base.extra, paymentFlow: "settlement" } }],
      ["voucherSigner", { ...base, extra: { ...base.extra, voucherSigner: "server" } }],
      ["channelState", { ...base, extra: { ...base.extra, channelState: { channelId: address(), balance: "x", totalClaimed: "0", withdrawRequestedAt: null } } }],
      ["voucherState", { ...base, extra: { ...base.extra, voucherState: { signedMaxClaimable: "1", expiresAt: 0, signature: "short" } } }],
    ];
    for (const [name, entry] of corruptions) expect(parseShieldedAccept(entry), name).toBeUndefined();
    expect(parseShieldedAccept(base)).toBe(base);
    const header = encodeHeader({ x402Version: 2, accepts: corruptions.map(([, e]) => e) });
    expect(parsePaymentRequired(header)?.accepts).toEqual([]);
    expect(parsePaymentRequired(encodeHeader({ x402Version: 1, accepts: [base] }))).toBeUndefined();
    expect(parsePaymentRequired(encodeHeader({ x402Version: 2, accepts: "none" }))).toBeUndefined();
  });

  it("a payment response yields success and the channel snapshot when well-formed", () => {
    const state = { channelId: address(), balance: "100000", totalClaimed: "0", withdrawRequestedAt: null, chargedCumulativeAmount: "1001" };
    expect(parsePaymentResponse(encodeHeader({ success: true, transaction: "", network: DEVNET_CAIP2, extra: { commitmentId: "x:1001", chargedAmount: "1001", channelState: state } }))).toEqual({ success: true, channelState: state });
    expect(parsePaymentResponse(encodeHeader({ success: false, errorReason: "duplicate_settlement", transaction: "", network: DEVNET_CAIP2 }))).toEqual({ success: false, errorReason: "duplicate_settlement" });
    expect(parsePaymentResponse(encodeHeader({ success: true, extra: { channelState: { ...state, balance: -1 } } }))).toEqual({ success: true });
    expect(parsePaymentResponse(encodeHeader({ success: "yes" }))).toBeUndefined();
  });
});
