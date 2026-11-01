import { describe, expect, it } from "vitest";
import { SCHEME_ERROR_CODES, nextWatermark } from "../src/index.js";

const v = (maxClaimableAmount: string, expiresAt = 0) => ({ maxClaimableAmount, expiresAt: expiresAt as 0 });

describe("nextWatermark", () => {
  it("nextWatermark: equal to prev is rejected", () => {
    expect(nextWatermark(5000n, v("5000"), 1000n, 100_000n)).toEqual({
      ok: false,
      code: SCHEME_ERROR_CODES.cumulativeAmountMismatch,
    });
  });

  it("nextWatermark: less than prev is rejected", () => {
    expect(nextWatermark(5000n, v("4999"), 1000n, 100_000n)).toEqual({
      ok: false,
      code: SCHEME_ERROR_CODES.cumulativeAmountMismatch,
    });
    expect(nextWatermark(5000n, v("0"), 0n, 100_000n)).toEqual({
      ok: false,
      code: SCHEME_ERROR_CODES.cumulativeAmountMismatch,
    });
    // Above prev but below prev + amount is the same code.
    expect(nextWatermark(5000n, v("5999"), 1000n, 100_000n)).toEqual({
      ok: false,
      code: SCHEME_ERROR_CODES.cumulativeAmountMismatch,
    });
  });

  it("nextWatermark: exactly prev plus amount is accepted", () => {
    expect(nextWatermark(5000n, v("6000"), 1000n, 100_000n)).toEqual({ ok: true, watermark: 6000n });
    // More than prev + amount is accepted too: the client adds the privacy fee share.
    expect(nextWatermark(5000n, v("6001"), 1000n, 100_000n)).toEqual({ ok: true, watermark: 6001n });
    // The first voucher of a channel.
    expect(nextWatermark(0n, v("1000"), 1000n, 100_000n)).toEqual({ ok: true, watermark: 1000n });
    // Spending the whole deposit is allowed.
    expect(nextWatermark(99_000n, v("100000"), 1000n, 100_000n)).toEqual({ ok: true, watermark: 100_000n });
  });

  it("nextWatermark: over deposit is rejected with cumulative_exceeds_deposit", () => {
    const result = nextWatermark(99_500n, v("100500"), 1000n, 100_000n);
    expect(result).toEqual({ ok: false, code: "invalid_batch_settlement_svm_cumulative_exceeds_deposit" });
    expect(result).toEqual({ ok: false, code: SCHEME_ERROR_CODES.cumulativeExceedsDeposit });
    expect(nextWatermark(0n, v("18446744073709551615"), 1n, 100_000n)).toEqual({
      ok: false,
      code: SCHEME_ERROR_CODES.cumulativeExceedsDeposit,
    });
  });

  it("nextWatermark: zero-price route is accepted", () => {
    // A zero-price route still needs a voucher above the watermark (spec L71), so
    // equal is rejected and prev + 1 is accepted.
    expect(nextWatermark(5000n, v("5000"), 0n, 100_000n)).toEqual({
      ok: false,
      code: SCHEME_ERROR_CODES.cumulativeAmountMismatch,
    });
    expect(nextWatermark(5000n, v("5001"), 0n, 100_000n)).toEqual({ ok: true, watermark: 5001n });
    expect(nextWatermark(0n, v("1"), 0n, 100_000n)).toEqual({ ok: true, watermark: 1n });
  });

  it("rejects a nonzero expiresAt, a malformed amount and out-of-range inputs with their codes", () => {
    expect(nextWatermark(0n, v("1000", 1), 1000n, 100_000n)).toEqual({ ok: false, code: SCHEME_ERROR_CODES.voucherExpiry });
    for (const bad of ["", "01", "-1", "1.5", "1e3", "abc", "18446744073709551616", " 1"]) {
      expect(nextWatermark(0n, v(bad), 1000n, 100_000n), bad).toEqual({ ok: false, code: SCHEME_ERROR_CODES.invalidPayload });
    }
    expect(nextWatermark(0n, v("1000"), -1n, 100_000n)).toEqual({
      ok: false,
      code: SCHEME_ERROR_CODES.invalidPaymentRequirements,
    });
    expect(nextWatermark(-1n, v("1000"), 1000n, 100_000n)).toEqual({
      ok: false,
      code: SCHEME_ERROR_CODES.invalidTransactionState,
    });
    expect(nextWatermark(0n, v("1000"), 1000n, 1n << 64n)).toEqual({
      ok: false,
      code: SCHEME_ERROR_CODES.invalidTransactionState,
    });
  });
});
