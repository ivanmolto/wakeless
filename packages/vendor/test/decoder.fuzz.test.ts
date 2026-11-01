import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { MAX_PAYMENT_SIGNATURE_LENGTH, decodePaymentSignature, parseSupported } from "../src/index.js";

const encode = (value: unknown) => Buffer.from(JSON.stringify(value) ?? "").toString("base64");

describe("decoders", () => {
  it("PAYMENT-SIGNATURE decoder never throws on arbitrary input", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.string(),
          fc.base64String(),
          fc.uint8Array({ maxLength: 512 }).map((bytes) => Buffer.from(bytes).toString("base64")),
          fc.jsonValue().map(encode),
          fc.record({ x402Version: fc.anything(), accepted: fc.anything(), payload: fc.anything() }).map(encode),
        ),
        (input) => {
          const result = decodePaymentSignature(input);
          if (result.ok) {
            expect(result.value.x402Version).toBe(2);
            expect(typeof result.value.accepted).toBe("object");
            expect(typeof result.value.payload).toBe("object");
          } else {
            expect(typeof result.code).toBe("string");
            expect(typeof result.message).toBe("string");
          }
        },
      ),
      { numRuns: 2000 },
    );
  });

  it("the decoder round-trips any well-formed envelope and refuses an oversized one", () => {
    fc.assert(
      fc.property(fc.dictionary(fc.string(), fc.jsonValue()), fc.dictionary(fc.string(), fc.jsonValue()), (accepted, payload) => {
        const result = decodePaymentSignature(encode({ x402Version: 2, accepted, payload }));
        expect(result.ok).toBe(true);
      }),
    );
    const result = decodePaymentSignature("A".repeat(MAX_PAYMENT_SIGNATURE_LENGTH + 4));
    expect(result.ok).toBe(false);
  });

  it("/supported parser never throws on arbitrary input", () => {
    fc.assert(
      fc.property(
        fc.oneof(
          fc.anything(),
          fc.record({ kinds: fc.anything(), extra: fc.anything() }),
          fc.record({ kinds: fc.array(fc.record({ x402Version: fc.constant(2), scheme: fc.constant("batch-settlement-shielded"), network: fc.string(), extra: fc.anything() })) }),
        ),
        (input) => {
          const result = parseSupported(input);
          expect(typeof result).toBe("object");
        },
      ),
      { numRuns: 1000 },
    );
  });
});
