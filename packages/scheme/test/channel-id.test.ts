import { sha256 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { SCHEME_ERROR_CODES, SchemeError, clientRefOf, deriveChannelId, isChannelId } from "../src/index.js";

const U64_MAX = (1n << 64n) - 1n;
const address = fc.uint8Array({ minLength: 32, maxLength: 32 }).map(bytes => bs58.encode(bytes));
const salt = fc.bigInt({ min: 0n, max: U64_MAX }).map(n => n.toString());

const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ESCROW = "EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6";
const BUYER = "GsbwXfJraMomNxBcjYLcG3mxkBUiyWXAB32fGbSMQRdW";

describe("channelId", () => {
  it("is base58(sha256(buyer || escrow || mint || u64le(salt))), 32 bytes, and replaces the PDA seeds", () => {
    const id = deriveChannelId({ buyer: BUYER, escrowAddress: ESCROW, mint: USDC_DEVNET, salt: "2001" });
    const preimage = new Uint8Array(104);
    preimage.set(bs58.decode(BUYER), 0);
    preimage.set(bs58.decode(ESCROW), 32);
    preimage.set(bs58.decode(USDC_DEVNET), 64);
    preimage.set([0xd1, 0x07, 0, 0, 0, 0, 0, 0], 96); // 2001 as u64 LE
    expect(id).toBe(bs58.encode(sha256(preimage)));
    expect(bs58.decode(id)).toHaveLength(32);
    expect(isChannelId(id)).toBe(true);
    // Deterministic, and every input moves it.
    expect(deriveChannelId({ buyer: BUYER, escrowAddress: ESCROW, mint: USDC_DEVNET, salt: "2001" })).toBe(id);
    expect(deriveChannelId({ buyer: BUYER, escrowAddress: ESCROW, mint: USDC_DEVNET, salt: "2002" })).not.toBe(id);
    expect(deriveChannelId({ buyer: ESCROW, escrowAddress: BUYER, mint: USDC_DEVNET, salt: "2001" })).not.toBe(id);
    // Malformed inputs are a typed error, never a hash of garbage.
    for (const bad of [
      { buyer: "short", escrowAddress: ESCROW, mint: USDC_DEVNET, salt: "1" },
      { buyer: BUYER, escrowAddress: ESCROW, mint: USDC_DEVNET, salt: "01" },
      { buyer: BUYER, escrowAddress: ESCROW, mint: USDC_DEVNET, salt: "18446744073709551616" },
      { buyer: BUYER, escrowAddress: "0OIl", mint: USDC_DEVNET, salt: "1" },
    ]) {
      expect(() => deriveChannelId(bad)).toThrow(SchemeError);
      expect(() => deriveChannelId(bad)).toThrow(SCHEME_ERROR_CODES.invalidPayload);
    }
  });

  it("clientRefOf is digits only, stable and fits u64", () => {
    // Known value: first 8 bytes little-endian.
    const idBytes = new Uint8Array(32).fill(0xab);
    idBytes.set([0xd1, 0x07, 0, 0, 0, 0, 0, 0], 0);
    expect(clientRefOf(bs58.encode(idBytes))).toBe("2001");
    expect(clientRefOf(bs58.encode(new Uint8Array(32).fill(0xff)))).toBe("18446744073709551615");
    expect(clientRefOf(bs58.encode(new Uint8Array(32)))).toBe("0");

    fc.assert(
      fc.property(address, address, address, salt, (buyer, escrowAddress, mint, s) => {
        const id = deriveChannelId({ buyer, escrowAddress, mint, salt: s });
        const ref = clientRefOf(id);
        expect(ref).toMatch(/^(0|[1-9][0-9]*)$/);
        expect(BigInt(ref) <= U64_MAX).toBe(true);
        expect(clientRefOf(id)).toBe(ref);
        expect(clientRefOf(deriveChannelId({ buyer, escrowAddress, mint, salt: s }))).toBe(ref);
        const expected = new DataView(bs58.decode(id).buffer).getBigUint64(0, true).toString();
        expect(ref).toBe(expected);
      }),
    );

    fc.assert(
      fc.property(fc.string(), text => {
        if (isChannelId(text)) {
          expect(clientRefOf(text)).toMatch(/^(0|[1-9][0-9]*)$/);
        } else {
          expect(() => clientRefOf(text)).toThrow(SchemeError);
        }
      }),
    );
  });
});
