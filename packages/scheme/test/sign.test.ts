import { randomBytes } from "node:crypto";
import { describe, expect, it } from "vitest";
import { CLOSE_MAGIC, RECEIPT_MAGIC, SchemeError, VOUCHER_MAGIC, publicKeyOf, signMessage, verifyMessage, verifyVoucher } from "../src/index.js";

describe("signMessage / verifyMessage", () => {
  it("signs caller-framed bytes and verifies them against the public key, 32- or 64-byte secret", () => {
    const seed = new Uint8Array(randomBytes(32));
    const keypair = { secretKey: seed };
    const message = new Uint8Array([0x54, 0x01, ...randomBytes(32)]);
    const signature = signMessage(keypair, message);
    expect(signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{86,88}$/);
    const pubkey = publicKeyOf(keypair);
    expect(verifyMessage(pubkey, message, signature)).toBe(true);
    const full = new Uint8Array(64);
    full.set(seed, 0);
    expect(signMessage({ secretKey: full }, message)).toBe(signature);
    // Another key, another message, a damaged signature, a malformed key: all false, none throws.
    expect(verifyMessage(publicKeyOf({ secretKey: new Uint8Array(randomBytes(32)) }), message, signature)).toBe(false);
    expect(verifyMessage(pubkey, new Uint8Array([0x54, 0x01, ...randomBytes(32)]), signature)).toBe(false);
    expect(verifyMessage(pubkey, message, signature.slice(0, -1) + (signature.endsWith("1") ? "2" : "1"))).toBe(false);
    expect(verifyMessage("nope", message, signature)).toBe(false);
    expect(verifyMessage(pubkey, message, "nope")).toBe(false);
  });

  it("refuses the scheme's own magic bytes, so a key cannot be made to sign a voucher through it", () => {
    const keypair = { secretKey: new Uint8Array(randomBytes(32)) };
    for (const magic of [VOUCHER_MAGIC, CLOSE_MAGIC, RECEIPT_MAGIC]) {
      const message = new Uint8Array([magic[0], magic[1], ...randomBytes(48)]);
      expect(() => signMessage(keypair, message)).toThrow(SchemeError);
      expect(verifyMessage(publicKeyOf(keypair), message, signMessage(keypair, new Uint8Array([0x54, 0x01, 0x00])))).toBe(false);
    }
    expect(() => signMessage(keypair, new Uint8Array([0x54, 0x01]))).toThrow(/domain separator/);
    expect(() => signMessage({ secretKey: new Uint8Array(31) }, new Uint8Array([0x54, 0x01, 0x00]))).toThrow(/secretKey/);
    // A terms-framed signature is not a voucher signature.
    const channelId = publicKeyOf({ secretKey: new Uint8Array(randomBytes(32)) });
    expect(verifyVoucher(publicKeyOf(keypair), { channelId, maxClaimableAmount: "1", expiresAt: 0, signature: signMessage(keypair, new Uint8Array([0x54, 0x01, 0x00])) })).toBe(false);
  });
});
