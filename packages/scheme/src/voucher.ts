import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";
import { decodeBase58Exact, encodeBase58 } from "./base58.js";
import { fail, ok, SCHEME_ERROR_CODES, SchemeError, type SchemeResult } from "./errors.js";
import type { BatchVoucher, UnsignedVoucher } from "./types.js";
import { decodeI64Le, decodeU64Le, encodeU64Le, parseU64 } from "./u64.js";

// noble-ed25519 ships no hash; the synchronous API needs one wired in once.
ed.hashes.sha512 = sha512;

/**
 * The two magic bytes that open every signed voucher message. They are the
 * domain separator (there is no textual prefix) and appear only in the signed
 * bytes, never in wire JSON (`docs/SCHEME.md` §2).
 */
export const VOUCHER_MAGIC: readonly [number, number] = [0x56, 0x01];

/** Length of the signed message: 2 magic + 32 channelId + 8 u64 + 8 i64. */
export const VOUCHER_MESSAGE_LENGTH = 50;

const OFFSET_CHANNEL_ID = 2;
const OFFSET_AMOUNT = 34;
const OFFSET_EXPIRES_AT = 42;

/**
 * Encode the 50-byte message a voucher signs, byte for byte the SVM scheme's
 * `encodeVoucherMessageBytes`: `0x56 0x01 || channelId || u64(maxClaimableAmount).le || i64(expiresAt).le`.
 *
 * @throws SchemeError when `channelId` is not 32 bytes of base58, `maxClaimableAmount`
 * is not a decimal u64, or `expiresAt` is not `0`
 */
export function encodeVoucherMessage(voucher: UnsignedVoucher): Uint8Array {
  const result = tryEncodeVoucherMessage(voucher);
  if (!result.ok) throw new SchemeError(result.code, result.message);
  return result.value;
}

/** `encodeVoucherMessage` as a result. Never throws. */
export function tryEncodeVoucherMessage(voucher: unknown): SchemeResult<Uint8Array> {
  const parsed = parseUnsignedVoucher(voucher);
  if (!parsed.ok) return parsed;
  const channel = decodeBase58Exact(parsed.value.channelId, 32) as Uint8Array;
  const amount = parseU64(parsed.value.maxClaimableAmount, "maxClaimableAmount", SCHEME_ERROR_CODES.invalidPayload);
  if (!amount.ok) return amount;

  const out = new Uint8Array(VOUCHER_MESSAGE_LENGTH);
  out[0] = VOUCHER_MAGIC[0];
  out[1] = VOUCHER_MAGIC[1];
  out.set(channel, OFFSET_CHANNEL_ID);
  out.set(encodeU64Le(amount.value), OFFSET_AMOUNT);
  // expiresAt is fixed at 0: the eight bytes at offset 42 stay zero.
  return ok(out);
}

/**
 * Decode a 50-byte voucher message back to its fields. Never throws: a wrong
 * length or magic is `invalid_payload`, a nonzero `expiresAt` is
 * `invalid_batch_settlement_svm_voucher_expiry`.
 */
export function decodeVoucherMessage(bytes: Uint8Array): SchemeResult<UnsignedVoucher> {
  if (!(bytes instanceof Uint8Array) || bytes.byteLength !== VOUCHER_MESSAGE_LENGTH) {
    return fail(SCHEME_ERROR_CODES.invalidPayload, `voucher message must be ${VOUCHER_MESSAGE_LENGTH} bytes`);
  }
  if (bytes[0] !== VOUCHER_MAGIC[0] || bytes[1] !== VOUCHER_MAGIC[1]) {
    return fail(SCHEME_ERROR_CODES.invalidPayload, "voucher message magic mismatch");
  }
  const expiresAt = decodeI64Le(bytes, OFFSET_EXPIRES_AT);
  if (expiresAt !== 0n) {
    return fail(SCHEME_ERROR_CODES.voucherExpiry, "expiresAt must be 0");
  }
  return ok({
    channelId: encodeBase58(bytes.subarray(OFFSET_CHANNEL_ID, OFFSET_AMOUNT)),
    maxClaimableAmount: decodeU64Le(bytes, OFFSET_AMOUNT).toString(),
    expiresAt: 0,
  });
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** Parse the unsigned fields of a voucher from untrusted JSON. Never throws. */
export function parseUnsignedVoucher(input: unknown): SchemeResult<UnsignedVoucher> {
  if (!isRecord(input)) return fail(SCHEME_ERROR_CODES.invalidPayload, "voucher must be an object");
  if (!decodeBase58Exact(input.channelId, 32)) {
    return fail(SCHEME_ERROR_CODES.invalidPayload, "voucher.channelId must be a 32-byte base58 id");
  }
  const amount = parseU64(input.maxClaimableAmount, "voucher.maxClaimableAmount", SCHEME_ERROR_CODES.invalidPayload);
  if (!amount.ok) return amount;
  if (input.expiresAt !== 0) {
    return fail(SCHEME_ERROR_CODES.voucherExpiry, "voucher.expiresAt must be 0");
  }
  return ok({
    channelId: input.channelId as string,
    maxClaimableAmount: input.maxClaimableAmount as string,
    expiresAt: 0,
  });
}

/**
 * Parse a full `BatchVoucher` from untrusted JSON: the unsigned fields plus a
 * base58 signature of 64 bytes. Checks shape only; `verifyVoucher` checks the
 * signature. Never throws.
 */
export function parseBatchVoucher(input: unknown): SchemeResult<BatchVoucher> {
  const unsigned = parseUnsignedVoucher(input);
  if (!unsigned.ok) return unsigned;
  const signature = (input as Record<string, unknown>).signature;
  if (!decodeBase58Exact(signature, 64)) {
    return fail(SCHEME_ERROR_CODES.voucherSignature, "voucher.signature must be a 64-byte base58 signature");
  }
  return ok({ ...unsigned.value, signature: signature as string });
}

/**
 * A signer: the 32-byte Ed25519 seed, or a 64-byte Solana keypair (seed then
 * public key) as `solana-keygen` writes it. Only the seed is used.
 */
export interface VoucherKeypair {
  readonly secretKey: Uint8Array;
}

function seedOf(keypair: VoucherKeypair): Uint8Array {
  const key = keypair.secretKey;
  if (!(key instanceof Uint8Array) || (key.byteLength !== 32 && key.byteLength !== 64)) {
    throw new SchemeError(SCHEME_ERROR_CODES.voucherSignature, "secretKey must be 32 or 64 bytes");
  }
  return key.subarray(0, 32);
}

/** The base58 public key of a `VoucherKeypair`. */
export function publicKeyOf(keypair: VoucherKeypair): string {
  return encodeBase58(ed.getPublicKey(seedOf(keypair)));
}

/**
 * Sign a voucher: Ed25519 over the raw 50 bytes, no hashing, signature carried
 * base58. Pure apart from the key.
 *
 * @throws SchemeError when the voucher fields or the key are malformed
 */
export function signVoucher(keypair: VoucherKeypair, voucher: UnsignedVoucher): BatchVoucher {
  const message = encodeVoucherMessage(voucher);
  const signature = ed.sign(message, seedOf(keypair));
  return {
    channelId: voucher.channelId,
    maxClaimableAmount: voucher.maxClaimableAmount,
    expiresAt: 0,
    signature: encodeBase58(signature),
  };
}

/**
 * Verify a voucher against the buyer's public key (base58 or 32 raw bytes).
 * Returns false, and never throws, for a malformed voucher, a malformed key,
 * a malformed signature or a signature by another key.
 */
export function verifyVoucher(pubkey: string | Uint8Array, voucher: BatchVoucher): boolean {
  const key = pubkey instanceof Uint8Array ? pubkey : decodeBase58Exact(pubkey, 32);
  if (!key || key.byteLength !== 32) return false;
  const parsed = parseBatchVoucher(voucher);
  if (!parsed.ok) return false;
  const message = tryEncodeVoucherMessage(parsed.value);
  if (!message.ok) return false;
  const signature = decodeBase58Exact(parsed.value.signature, 64) as Uint8Array;
  try {
    return ed.verify(signature, message.value, key);
  } catch {
    return false;
  }
}
