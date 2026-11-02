import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { decodeBase58Exact, encodeBase58 } from "./base58.js";
import { fail, ok, SCHEME_ERROR_CODES, SchemeError, type SchemeResult } from "./errors.js";
import type { SettlementReceipt } from "./types.js";
import { encodeU64Le, parseU64 } from "./u64.js";
import type { VoucherKeypair } from "./voucher.js";

ed.hashes.sha512 = sha512;

/**
 * The facilitator-signed off-chain receipt (`docs/SCHEME.md` §4.4, plan task 7.2).
 *
 * The signed message is 122 bytes, fixed layout, no JSON and no hashing:
 * `0x52 0x01 || channelId (32) || u64(period).le || u64(cumulative).le || u64(amount).le || transferSignature (64)`.
 * The magic bytes are the domain separator: a receipt can never verify as a voucher
 * (`0x56 0x01`) or the other way round. The transfer signature is inside the signed
 * bytes, so a receipt binds the facilitator to one private transfer.
 */
export const RECEIPT_MAGIC: readonly [number, number] = [0x52, 0x01];

/** 2 magic + 32 channelId + 8 period + 8 cumulative + 8 amount + 64 transfer signature. */
export const RECEIPT_MESSAGE_LENGTH = 122;

const OFFSET_CHANNEL_ID = 2;
const OFFSET_PERIOD = 34;
const OFFSET_CUMULATIVE = 42;
const OFFSET_AMOUNT = 50;
const OFFSET_SIGNATURE = 58;

/** The fields the facilitator signs over, before its signature exists. */
export type UnsignedReceipt = Omit<SettlementReceipt, "facilitatorSignature">;

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the unsigned fields from untrusted JSON. Shape only. Never throws. */
export function parseUnsignedReceipt(input: unknown): SchemeResult<UnsignedReceipt> {
  if (!isRecord(input)) return fail(SCHEME_ERROR_CODES.invalidPayload, "receipt must be an object");
  if (!decodeBase58Exact(input.channelId, 32)) return fail(SCHEME_ERROR_CODES.invalidPayload, "receipt.channelId must be 32 bytes of base58");
  const { period } = input;
  if (typeof period !== "number" || !Number.isSafeInteger(period) || period < 1) {
    return fail(SCHEME_ERROR_CODES.invalidPayload, "receipt.period must be a positive integer");
  }
  const cumulative = parseU64(input.cumulative, "receipt.cumulative", SCHEME_ERROR_CODES.invalidPayload);
  if (!cumulative.ok) return cumulative;
  const amount = parseU64(input.amount, "receipt.amount", SCHEME_ERROR_CODES.invalidPayload);
  if (!amount.ok) return amount;
  if (amount.value > cumulative.value) return fail(SCHEME_ERROR_CODES.invalidPayload, "receipt.amount exceeds receipt.cumulative");
  if (!decodeBase58Exact(input.signature, 64)) return fail(SCHEME_ERROR_CODES.invalidPayload, "receipt.signature must be a 64-byte base58 signature");
  return ok({
    channelId: input.channelId as string,
    period,
    cumulative: input.cumulative as string,
    amount: input.amount as string,
    signature: input.signature as string,
  });
}

/** Parse a full receipt from untrusted JSON. Shape only; `verifyReceipt` checks the signature. Never throws. */
export function parseSettlementReceipt(input: unknown): SchemeResult<SettlementReceipt> {
  const unsigned = parseUnsignedReceipt(input);
  if (!unsigned.ok) return unsigned;
  const facilitatorSignature = (input as Record<string, unknown>).facilitatorSignature;
  if (!decodeBase58Exact(facilitatorSignature, 64)) {
    return fail(SCHEME_ERROR_CODES.invalidPayload, "receipt.facilitatorSignature must be a 64-byte base58 signature");
  }
  return ok({ ...unsigned.value, facilitatorSignature: facilitatorSignature as string });
}

/** `encodeReceiptMessage` as a result. Never throws. */
export function tryEncodeReceiptMessage(receipt: unknown): SchemeResult<Uint8Array> {
  const parsed = parseUnsignedReceipt(receipt);
  if (!parsed.ok) return parsed;
  const out = new Uint8Array(RECEIPT_MESSAGE_LENGTH);
  out[0] = RECEIPT_MAGIC[0];
  out[1] = RECEIPT_MAGIC[1];
  out.set(decodeBase58Exact(parsed.value.channelId, 32) as Uint8Array, OFFSET_CHANNEL_ID);
  out.set(encodeU64Le(BigInt(parsed.value.period)), OFFSET_PERIOD);
  out.set(encodeU64Le(BigInt(parsed.value.cumulative)), OFFSET_CUMULATIVE);
  out.set(encodeU64Le(BigInt(parsed.value.amount)), OFFSET_AMOUNT);
  out.set(decodeBase58Exact(parsed.value.signature, 64) as Uint8Array, OFFSET_SIGNATURE);
  return ok(out);
}

/**
 * Encode the 122-byte message a receipt signs.
 *
 * @throws SchemeError when a field is malformed
 */
export function encodeReceiptMessage(receipt: UnsignedReceipt): Uint8Array {
  const result = tryEncodeReceiptMessage(receipt);
  if (!result.ok) throw new SchemeError(result.code, result.message);
  return result.value;
}

function seedOf(keypair: VoucherKeypair): Uint8Array {
  const key = keypair.secretKey;
  if (!(key instanceof Uint8Array) || (key.byteLength !== 32 && key.byteLength !== 64)) {
    throw new SchemeError(SCHEME_ERROR_CODES.invalidPayload, "secretKey must be 32 or 64 bytes");
  }
  return key.subarray(0, 32);
}

/**
 * Sign a receipt with the facilitator's receipt signer: Ed25519 over the raw
 * 122 bytes, signature carried base58.
 *
 * @throws SchemeError when the receipt fields or the key are malformed
 */
export function signReceipt(keypair: VoucherKeypair, receipt: UnsignedReceipt): SettlementReceipt {
  const message = encodeReceiptMessage(receipt);
  const facilitatorSignature = ed.sign(message, seedOf(keypair));
  return {
    channelId: receipt.channelId,
    period: receipt.period,
    cumulative: receipt.cumulative,
    amount: receipt.amount,
    signature: receipt.signature,
    facilitatorSignature: encodeBase58(facilitatorSignature),
  };
}

/**
 * Verify a receipt against the facilitator's receipt signer (base58 or 32 raw
 * bytes, from `/supported` `signers`). Returns false, and never throws, for a
 * malformed receipt, key or signature, or a signature by another key.
 */
export function verifyReceipt(pubkey: string | Uint8Array, receipt: SettlementReceipt): boolean {
  const key = pubkey instanceof Uint8Array ? pubkey : decodeBase58Exact(pubkey, 32);
  if (!key || key.byteLength !== 32) return false;
  const parsed = parseSettlementReceipt(receipt);
  if (!parsed.ok) return false;
  const message = tryEncodeReceiptMessage(parsed.value);
  if (!message.ok) return false;
  const signature = decodeBase58Exact(parsed.value.facilitatorSignature, 64) as Uint8Array;
  try {
    return ed.verify(signature, message.value, key);
  } catch {
    return false;
  }
}
