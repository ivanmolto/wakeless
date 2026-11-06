// The buyer's close request (task 8.1): a second signature over the channel id and the
// latest voucher's cumulative, distinct from the voucher signature in magic and length.
import { randomBytes } from "node:crypto";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  CLOSE_MAGIC,
  CLOSE_MESSAGE_LENGTH,
  VOUCHER_MAGIC,
  encodeBase58,
  encodeCloseMessage,
  parseCloseSignature,
  publicKeyOf,
  signCloseRequest,
  signVoucher,
  tryEncodeCloseMessage,
  verifyCloseRequest,
  verifyVoucher,
} from "../src/index.js";

const keypair = () => ({ secretKey: new Uint8Array(randomBytes(32)) });
const channelId = () => encodeBase58(randomBytes(32));

describe("close request", () => {
  it("signs and verifies over the channel id and the latest cumulative", () => {
    const buyer = keypair();
    const voucher = signVoucher(buyer, { channelId: channelId(), maxClaimableAmount: "500500", expiresAt: 0 });
    const closeSignature = signCloseRequest(buyer, voucher);
    expect(parseCloseSignature(closeSignature).ok).toBe(true);
    expect(verifyCloseRequest(publicKeyOf(buyer), voucher, closeSignature)).toBe(true);

    const message = encodeCloseMessage(voucher);
    expect(message.byteLength).toBe(CLOSE_MESSAGE_LENGTH);
    expect([message[0], message[1]]).toEqual([...CLOSE_MAGIC]);
    expect(CLOSE_MAGIC[1]).not.toBe(VOUCHER_MAGIC[1]);

    // Another key, another cumulative, another channel, a malformed signature: none verifies.
    expect(verifyCloseRequest(publicKeyOf(keypair()), voucher, closeSignature)).toBe(false);
    expect(verifyCloseRequest(publicKeyOf(buyer), { ...voucher, maxClaimableAmount: "500501" }, closeSignature)).toBe(false);
    expect(verifyCloseRequest(publicKeyOf(buyer), { ...voucher, channelId: channelId() }, closeSignature)).toBe(false);
    expect(verifyCloseRequest(publicKeyOf(buyer), voucher, "not-base58!")).toBe(false);
    expect(verifyCloseRequest("short", voucher, closeSignature)).toBe(false);
    expect(parseCloseSignature(encodeBase58(randomBytes(63))).ok).toBe(false);
    expect(parseCloseSignature(42).ok).toBe(false);
  });

  it("a voucher signature is not a close signature and the reverse", () => {
    const buyer = keypair();
    const voucher = signVoucher(buyer, { channelId: channelId(), maxClaimableAmount: "7", expiresAt: 0 });
    const closeSignature = signCloseRequest(buyer, voucher);
    expect(verifyCloseRequest(publicKeyOf(buyer), voucher, voucher.signature)).toBe(false);
    expect(verifyVoucher(publicKeyOf(buyer), { ...voucher, signature: closeSignature })).toBe(false);
  });

  it("the message encoder never throws on arbitrary input", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        const result = tryEncodeCloseMessage(input);
        expect(typeof result.ok).toBe("boolean");
      }),
    );
    fc.assert(
      fc.property(fc.bigInt(0n, 2n ** 64n - 1n), (amount) => {
        const voucher = { channelId: channelId(), maxClaimableAmount: amount.toString(), expiresAt: 0 as const };
        const buyer = keypair();
        expect(verifyCloseRequest(publicKeyOf(buyer), voucher, signCloseRequest(buyer, voucher))).toBe(true);
      }),
      { numRuns: 20 },
    );
  });
});
