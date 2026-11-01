import bs58 from "bs58";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  decodeVoucherMessage,
  isSchemeErrorCode,
  parseBatchVoucher,
  parseUnsignedVoucher,
  tryEncodeVoucherMessage,
  verifyVoucher,
} from "../src/index.js";

const anyJson = fc.jsonValue();
const anyBytes = fc.uint8Array({ minLength: 0, maxLength: 128 });
const fiftyBytes = fc.uint8Array({ minLength: 50, maxLength: 50 });

function expectTypedError(result: { ok: boolean; code?: string; message?: string }) {
  if (!result.ok) {
    expect(isSchemeErrorCode(result.code)).toBe(true);
    expect(typeof result.message).toBe("string");
    // Never echo a long input in the message.
    expect((result.message as string).length).toBeLessThan(120);
  }
}

describe("voucher parsers", () => {
  it("voucher parser never throws on arbitrary bytes", () => {
    // Raw message bytes of any length.
    fc.assert(
      fc.property(anyBytes, bytes => {
        const result = decodeVoucherMessage(bytes);
        expectTypedError(result);
        if (bytes.length !== 50) expect(result.ok).toBe(false);
      }),
    );
    // Exactly 50 bytes: decode, and whatever decodes re-encodes to the same bytes.
    fc.assert(
      fc.property(fiftyBytes, bytes => {
        const result = decodeVoucherMessage(bytes);
        expectTypedError(result);
        if (result.ok) {
          const back = tryEncodeVoucherMessage(result.value);
          expect(back.ok).toBe(true);
          if (back.ok) expect([...back.value]).toEqual([...bytes]);
        }
      }),
    );
    // Arbitrary JSON as a wire voucher.
    fc.assert(
      fc.property(anyJson, anyJson, (value, pubkey) => {
        expectTypedError(parseUnsignedVoucher(value));
        expectTypedError(parseBatchVoucher(value));
        expectTypedError(tryEncodeVoucherMessage(value));
        // The key is passed as it comes: `String(pubkey)` would itself throw on `{toString: null}`.
        expect(verifyVoucher(pubkey as never, value as never)).toBe(false);
      }),
    );
    // Well-shaped objects with arbitrary field contents.
    const shaped = fc.record({
      channelId: fc.oneof(fc.string(), anyBytes.map(b => bs58.encode(b))),
      maxClaimableAmount: fc.oneof(fc.string(), fc.bigInt().map(String), fc.integer()),
      expiresAt: fc.oneof(fc.constant(0), fc.integer(), fc.string()),
      signature: fc.oneof(fc.string(), anyBytes.map(b => bs58.encode(b))),
    });
    fc.assert(
      fc.property(shaped, fc.oneof(fc.string(), anyBytes), (voucher, pubkey) => {
        expectTypedError(parseBatchVoucher(voucher));
        expect(typeof verifyVoucher(pubkey, voucher as never)).toBe("boolean");
      }),
    );
  });
});
