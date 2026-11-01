import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { existsSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  SCHEME_ERROR_CODES,
  VOUCHER_MAGIC,
  decodeVoucherMessage,
  deriveChannelId,
  encodeVoucherMessage,
  parseBatchVoucher,
  publicKeyOf,
  signVoucher,
  verifyVoucher,
  type BatchVoucher,
  type UnsignedVoucher,
} from "../src/index.js";

ed.hashes.sha512 = sha512;

const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ESCROW = "EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6";

function keypair() {
  const { secretKey, publicKey } = ed.keygen();
  return { secretKey, publicKey, address: bs58.encode(publicKey) };
}

function unsigned(buyer: string, amount = "1000"): UnsignedVoucher {
  return {
    channelId: deriveChannelId({ buyer, escrowAddress: ESCROW, mint: USDC_DEVNET, salt: "7" }),
    maxClaimableAmount: amount,
    expiresAt: 0,
  };
}

describe("BatchVoucher", () => {
  it("sign then verify round-trips", () => {
    const buyer = keypair();
    const voucher = signVoucher(buyer, unsigned(buyer.address));
    expect(publicKeyOf(buyer)).toBe(buyer.address);
    expect(bs58.decode(voucher.signature)).toHaveLength(64);
    expect(verifyVoucher(buyer.address, voucher)).toBe(true);
    expect(verifyVoucher(buyer.publicKey, voucher)).toBe(true);
    // Another key, and a 64-byte Solana-style keypair for the same seed.
    expect(verifyVoucher(keypair().address, voucher)).toBe(false);
    const solanaKeypair = new Uint8Array([...buyer.secretKey, ...buyer.publicKey]);
    expect(signVoucher({ secretKey: solanaKeypair }, unsigned(buyer.address))).toEqual(voucher);
    expect(parseBatchVoucher(voucher)).toEqual({ ok: true, value: voucher });
  });

  it("a tampered byte fails verification", () => {
    const buyer = keypair();
    const voucher = signVoucher(buyer, unsigned(buyer.address, "123456789"));
    const message = encodeVoucherMessage(voucher);
    expect(message).toHaveLength(50);
    const signature = bs58.decode(voucher.signature);
    expect(ed.verify(signature, message, buyer.publicKey)).toBe(true);

    for (let i = 0; i < 50; i++) {
      const flipped = Uint8Array.from(message);
      flipped[i] = (flipped[i] as number) ^ 0x01;
      // The raw signature no longer covers the flipped bytes.
      expect(ed.verify(signature, flipped, buyer.publicKey), `byte ${i}`).toBe(false);
      // And whatever the flipped bytes decode to, as a wire voucher with the old signature, fails.
      const decoded = decodeVoucherMessage(flipped);
      if (decoded.ok) {
        const tampered: BatchVoucher = { ...decoded.value, signature: voucher.signature };
        expect(verifyVoucher(buyer.address, tampered), `byte ${i}`).toBe(false);
      } else {
        // Bytes 0-1 (magic) and 42-49 (expiresAt) cannot be expressed as a valid wire voucher at all.
        expect([0, 1, 42, 43, 44, 45, 46, 47, 48, 49], `byte ${i}`).toContain(i);
      }
    }
    // A tampered signature byte fails too.
    for (let i = 0; i < 64; i++) {
      const sig = Uint8Array.from(signature);
      sig[i] = (sig[i] as number) ^ 0x01;
      expect(verifyVoucher(buyer.address, { ...voucher, signature: bs58.encode(sig) }), `sig byte ${i}`).toBe(false);
    }
  });

  it("signed message is 50 bytes with expiresAt 0", () => {
    const buyer = keypair();
    const v = unsigned(buyer.address, "18446744073709551615");
    const bytes = encodeVoucherMessage(v);
    expect(bytes).toHaveLength(50);
    // docs/SCHEME.md §2: offset 0, 2 bytes magic 0x56 0x01
    expect([...bytes.slice(0, 2)]).toEqual([0x56, 0x01]);
    expect([...VOUCHER_MAGIC]).toEqual([0x56, 0x01]);
    // offset 2, 32 bytes channelId base58-decoded
    expect([...bytes.slice(2, 34)]).toEqual([...bs58.decode(v.channelId)]);
    // offset 34, 8 bytes u64 LE maxClaimableAmount
    expect([...bytes.slice(34, 42)]).toEqual(new Array(8).fill(0xff));
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    expect(view.getBigUint64(34, true)).toBe(18446744073709551615n);
    // offset 42, 8 bytes i64 LE expiresAt, fixed 0
    expect([...bytes.slice(42, 50)]).toEqual(new Array(8).fill(0));
    expect(view.getBigInt64(42, true)).toBe(0n);

    const small = encodeVoucherMessage({ ...v, maxClaimableAmount: "1000000" });
    expect([...small.slice(34, 42)]).toEqual([0x40, 0x42, 0x0f, 0, 0, 0, 0, 0]);
    expect(decodeVoucherMessage(small)).toEqual({ ok: true, value: { ...v, maxClaimableAmount: "1000000" } });

    // A nonzero expiresAt never gets signed and is the spec's expiry code.
    expect(() => encodeVoucherMessage({ ...v, expiresAt: 1 as unknown as 0 })).toThrow(SCHEME_ERROR_CODES.voucherExpiry);
    expect(() => signVoucher(buyer, { ...v, expiresAt: 1 as unknown as 0 })).toThrow(SCHEME_ERROR_CODES.voucherExpiry);
    expect(() => encodeVoucherMessage({ ...v, maxClaimableAmount: "18446744073709551616" })).toThrow(
      SCHEME_ERROR_CODES.invalidPayload,
    );
    expect(() => encodeVoucherMessage({ ...v, channelId: "short" })).toThrow(SCHEME_ERROR_CODES.invalidPayload);
  });

  it("matches the spec test vector", (ctx) => {
    // vendor/x402 at e208bd3 (docs/SCHEME.md sources) ships no fixed voucher
    // vector: its unit tests derive keypairs at runtime and assert the layout,
    // which the test above does byte for byte. Looked for a JSON or vector file
    // under the scheme's spec and test directories.
    const root = join(import.meta.dirname, "..", "..", "..", "vendor", "x402");
    const candidates = [
      join(root, "specs", "schemes", "batch-settlement"),
      join(root, "typescript", "packages", "mechanisms", "svm", "test", "fixtures"),
      join(root, "typescript", "packages", "mechanisms", "svm", "test", "vectors"),
    ];
    const vectors = candidates
      .filter(existsSync)
      .flatMap(dir => readdirSync(dir).map(name => join(dir, name)))
      .filter(path => /vector|\.json$/i.test(path));
    if (vectors.length === 0) {
      const reason = existsSync(root)
        ? "vendor/x402 ships no voucher test vector (layout asserted byte for byte above)"
        : "vendor/x402 is not cloned here (gitignored)";
      console.log(`skipped: matches the spec test vector: ${reason}`);
      ctx.skip(reason);
      return;
    }
    // If a vector ever lands, wire it here: fail loudly rather than pass by accident.
    throw new Error(`a spec test vector appeared; wire it into this test: ${vectors.join(", ")}`);
  });
});
