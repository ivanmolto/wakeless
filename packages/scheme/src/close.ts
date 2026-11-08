import { decodeBase58Exact, encodeBase58 } from "./base58.js";
import * as ed from "./ed25519.js";
import { fail, ok, SCHEME_ERROR_CODES, SchemeError, type SchemeResult } from "./errors.js";
import type { UnsignedVoucher } from "./types.js";
import { encodeU64Le, parseU64 } from "./u64.js";
import { parseUnsignedVoucher, type VoucherKeypair } from "./voucher.js";

/**
 * The buyer's close request (task 8.1): a second signature by the buyer key over the
 * channel id and the cumulative of its latest voucher, so a voucher alone (which the
 * buyer hands the vendor on every request) can never be replayed as a close. The
 * message is `0x56 0x02 || channelId || u64(maxClaimableAmount).le`, 42 bytes; the
 * magic differs from the voucher's in its second byte and the message in its length,
 * so neither signature verifies as the other.
 *
 * The SVM scheme's `CloseAuthorization` digest commits to the payment-channels program
 * id (`docs/SCHEME.md` §3, S10); there is no program here, so this message replaces it.
 */
export const CLOSE_MAGIC: readonly [number, number] = [0x56, 0x02];
export const CLOSE_MESSAGE_LENGTH = 42;

const OFFSET_CHANNEL_ID = 2;
const OFFSET_AMOUNT = 34;

/** The 42-byte close message over the latest voucher's channel id and cumulative. Never throws. */
export function tryEncodeCloseMessage(voucher: unknown): SchemeResult<Uint8Array> {
  const parsed = parseUnsignedVoucher(voucher);
  if (!parsed.ok) return parsed;
  const channel = decodeBase58Exact(parsed.value.channelId, 32) as Uint8Array;
  const amount = parseU64(parsed.value.maxClaimableAmount, "maxClaimableAmount", SCHEME_ERROR_CODES.invalidPayload);
  if (!amount.ok) return amount;
  const out = new Uint8Array(CLOSE_MESSAGE_LENGTH);
  out[0] = CLOSE_MAGIC[0];
  out[1] = CLOSE_MAGIC[1];
  out.set(channel, OFFSET_CHANNEL_ID);
  out.set(encodeU64Le(amount.value), OFFSET_AMOUNT);
  return ok(out);
}

/** @throws SchemeError when the voucher fields are malformed */
export function encodeCloseMessage(voucher: UnsignedVoucher): Uint8Array {
  const result = tryEncodeCloseMessage(voucher);
  if (!result.ok) throw new SchemeError(result.code, result.message);
  return result.value;
}

function seedOf(keypair: VoucherKeypair): Uint8Array {
  const key = keypair.secretKey;
  if (!(key instanceof Uint8Array) || (key.byteLength !== 32 && key.byteLength !== 64)) {
    throw new SchemeError(SCHEME_ERROR_CODES.voucherSignature, "secretKey must be 32 or 64 bytes");
  }
  return key.subarray(0, 32);
}

/** The buyer's close signature, base58, over the close message of `voucher`. */
export function signCloseRequest(keypair: VoucherKeypair, voucher: UnsignedVoucher): string {
  return encodeBase58(ed.sign(encodeCloseMessage(voucher), seedOf(keypair)));
}

/** Shape check of a close signature: 64 bytes of base58. Never throws. */
export function parseCloseSignature(input: unknown): SchemeResult<string> {
  if (decodeBase58Exact(input, 64) === null) return fail(SCHEME_ERROR_CODES.closeAuthorization, "closeSignature must be a 64-byte base58 signature");
  return ok(input as string);
}

/** Verifies a close signature against the buyer's key. Returns false, never throws, on any malformed input or another key. */
export function verifyCloseRequest(pubkey: string | Uint8Array, voucher: UnsignedVoucher, closeSignature: string): boolean {
  const key = pubkey instanceof Uint8Array ? pubkey : decodeBase58Exact(pubkey, 32);
  if (!key || key.byteLength !== 32) return false;
  const message = tryEncodeCloseMessage(voucher);
  if (!message.ok) return false;
  const signature = decodeBase58Exact(closeSignature, 64);
  if (signature === null) return false;
  try {
    return ed.verify(signature, message.value, key);
  } catch {
    return false;
  }
}
