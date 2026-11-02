import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import bs58 from "bs58";
import { describe, expect, it } from "vitest";
import {
  RECEIPT_MAGIC,
  RECEIPT_MESSAGE_LENGTH,
  SCHEME_ERROR_CODES,
  VOUCHER_MAGIC,
  deriveChannelId,
  encodeReceiptMessage,
  parseSettlementReceipt,
  publicKeyOf,
  signReceipt,
  tryEncodeReceiptMessage,
  verifyReceipt,
  verifyVoucher,
  type SettlementReceipt,
  type UnsignedReceipt,
} from "../src/index.js";

ed.hashes.sha512 = sha512;

const USDC_DEVNET = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const ESCROW = "EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6";

function keypair() {
  const { secretKey, publicKey } = ed.keygen();
  return { secretKey, publicKey, address: bs58.encode(publicKey) };
}

const buyer = keypair();
const channelId = deriveChannelId({ buyer: buyer.address, escrowAddress: ESCROW, mint: USDC_DEVNET, salt: "7" });
const transferSignature = bs58.encode(crypto.getRandomValues(new Uint8Array(64)));
const unsigned: UnsignedReceipt = { channelId, period: 3, cumulative: "20020", amount: "20000", signature: transferSignature };

describe("receipt message", () => {
  it("is 122 bytes with its own magic, little-endian fields and the transfer signature", () => {
    const bytes = encodeReceiptMessage(unsigned);
    expect(bytes.byteLength).toBe(RECEIPT_MESSAGE_LENGTH);
    expect([bytes[0], bytes[1]]).toEqual([...RECEIPT_MAGIC]);
    expect(RECEIPT_MAGIC).not.toEqual(VOUCHER_MAGIC);
    expect(bs58.encode(bytes.subarray(2, 34))).toBe(channelId);
    expect(new DataView(bytes.buffer, bytes.byteOffset + 34, 8).getBigUint64(0, true)).toBe(3n);
    expect(new DataView(bytes.buffer, bytes.byteOffset + 42, 8).getBigUint64(0, true)).toBe(20_020n);
    expect(new DataView(bytes.buffer, bytes.byteOffset + 50, 8).getBigUint64(0, true)).toBe(20_000n);
    expect(bs58.encode(bytes.subarray(58))).toBe(transferSignature);
  });

  it("refuses malformed fields without throwing from the try form", () => {
    const bad: unknown[] = [
      null,
      { ...unsigned, channelId: "abc" },
      { ...unsigned, period: 0 },
      { ...unsigned, period: 1.5 },
      { ...unsigned, cumulative: "-1" },
      { ...unsigned, amount: "01" },
      { ...unsigned, amount: "20021" },
      { ...unsigned, signature: "short" },
    ];
    for (const input of bad) {
      const result = tryEncodeReceiptMessage(input);
      expect(result.ok).toBe(false);
      if (!result.ok) expect(result.code).toBe(SCHEME_ERROR_CODES.invalidPayload);
    }
    expect(() => encodeReceiptMessage({ ...unsigned, period: 0 })).toThrow();
  });
});

describe("signReceipt / verifyReceipt", () => {
  it("a signed receipt verifies against the signer and against nobody else", () => {
    const facilitator = keypair();
    const receipt = signReceipt({ secretKey: facilitator.secretKey }, unsigned);
    expect(receipt).toMatchObject(unsigned);
    expect(bs58.decode(receipt.facilitatorSignature)).toHaveLength(64);
    expect(verifyReceipt(facilitator.address, receipt)).toBe(true);
    expect(verifyReceipt(facilitator.publicKey, receipt)).toBe(true);
    expect(verifyReceipt(publicKeyOf({ secretKey: facilitator.secretKey }), receipt)).toBe(true);
    expect(verifyReceipt(keypair().address, receipt)).toBe(false);
    expect(verifyReceipt("not-a-key", receipt)).toBe(false);
  });

  it("an altered field fails verification", () => {
    const facilitator = keypair();
    const receipt = signReceipt({ secretKey: facilitator.secretKey }, unsigned);
    const altered: SettlementReceipt[] = [
      { ...receipt, amount: "20001" },
      { ...receipt, cumulative: "20019" },
      { ...receipt, period: 4 },
      { ...receipt, signature: bs58.encode(crypto.getRandomValues(new Uint8Array(64))) },
      { ...receipt, channelId: deriveChannelId({ buyer: buyer.address, escrowAddress: ESCROW, mint: USDC_DEVNET, salt: "8" }) },
      { ...receipt, facilitatorSignature: bs58.encode(crypto.getRandomValues(new Uint8Array(64))) },
      { ...receipt, facilitatorSignature: "short" },
    ];
    for (const r of altered) expect(verifyReceipt(facilitator.address, r)).toBe(false);
  });

  it("a receipt never verifies as a voucher", () => {
    const facilitator = keypair();
    const receipt = signReceipt({ secretKey: facilitator.secretKey }, unsigned);
    expect(verifyVoucher(facilitator.address, { channelId, maxClaimableAmount: "20020", expiresAt: 0, signature: receipt.facilitatorSignature })).toBe(false);
  });

  it("parseSettlementReceipt checks shape only", () => {
    const facilitator = keypair();
    const receipt = signReceipt({ secretKey: facilitator.secretKey }, unsigned);
    expect(parseSettlementReceipt(JSON.parse(JSON.stringify(receipt)))).toEqual({ ok: true, value: receipt });
    const forged = { ...receipt, facilitatorSignature: bs58.encode(crypto.getRandomValues(new Uint8Array(64))) };
    expect(parseSettlementReceipt(forged).ok).toBe(true);
    expect(verifyReceipt(facilitator.address, forged)).toBe(false);
    expect(parseSettlementReceipt({ ...receipt, facilitatorSignature: 1 }).ok).toBe(false);
    expect(parseSettlementReceipt("receipt").ok).toBe(false);
  });
});
