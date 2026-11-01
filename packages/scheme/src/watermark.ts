import { SCHEME_ERROR_CODES, type SchemeErrorCode } from "./errors.js";
import type { UnsignedVoucher } from "./types.js";
import { isU64, parseU64 } from "./u64.js";

export type WatermarkResult =
  | { readonly ok: true; readonly watermark: bigint }
  | { readonly ok: false; readonly code: SchemeErrorCode };

/**
 * The accepted cumulative after a voucher, or the code that rejects it. Pure.
 * Rules (`docs/SCHEME.md` §1.3; spec `scheme_batch_settlement_svm.md:L71`, `:L1619`-`L1627`):
 *
 * - `expiresAt` must be `0` → `invalid_batch_settlement_svm_voucher_expiry`
 * - `maxClaimableAmount` must be a decimal u64 → `invalid_payload`
 * - must be `> prev` and `>= prev + amount` → `invalid_batch_settlement_svm_cumulative_amount_mismatch`.
 *   `>` is checked even when `amount` is `0`, so a zero-price route cannot be
 *   satisfied by a voucher equal to the watermark; `>=` rather than `==`
 *   because the client adds the `privacyFeeBps` share on top of `amount`.
 * - must be `<= deposit` → `invalid_batch_settlement_svm_cumulative_exceeds_deposit`
 *
 * @param prev - The channel's current watermark (`chargedCumulativeAmount`), u64
 * @param voucher - The voucher's unsigned fields; the signature is checked elsewhere
 * @param amount - `PaymentRequirements.amount` for this request, u64
 * @param deposit - The confirmed private deposit, u64
 */
export function nextWatermark(
  prev: bigint,
  voucher: Pick<UnsignedVoucher, "maxClaimableAmount" | "expiresAt">,
  amount: bigint,
  deposit: bigint,
): WatermarkResult {
  if (!isU64(prev) || !isU64(deposit)) return { ok: false, code: SCHEME_ERROR_CODES.invalidTransactionState };
  if (!isU64(amount)) return { ok: false, code: SCHEME_ERROR_CODES.invalidPaymentRequirements };
  if (voucher.expiresAt !== 0) return { ok: false, code: SCHEME_ERROR_CODES.voucherExpiry };

  const cumulative = parseU64(voucher.maxClaimableAmount, "maxClaimableAmount", SCHEME_ERROR_CODES.invalidPayload);
  if (!cumulative.ok) return { ok: false, code: cumulative.code };
  const next = cumulative.value;

  if (next <= prev || next < prev + amount) {
    return { ok: false, code: SCHEME_ERROR_CODES.cumulativeAmountMismatch };
  }
  if (next > deposit) return { ok: false, code: SCHEME_ERROR_CODES.cumulativeExceedsDeposit };
  return { ok: true, watermark: next };
}
