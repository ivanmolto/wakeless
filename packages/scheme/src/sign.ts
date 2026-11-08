import { decodeBase58Exact, encodeBase58 } from "./base58.js";
import * as ed from "./ed25519.js";
import { SCHEME_ERROR_CODES, SchemeError } from "./errors.js";
import type { VoucherKeypair } from "./voucher.js";

/**
 * Detached Ed25519 over caller-framed bytes, for messages the scheme does not lay out
 * itself (task 12.1T: the vendor-signed terms receipt). The caller owns the domain
 * separator: the first two bytes of `message` must never be a voucher's (`0x56 0x01`),
 * a close request's (`0x56 0x02`) or a receipt's (`0x52 0x01`) magic, so a key that
 * signs one kind of message can never be made to sign another.
 */
const RESERVED_MAGIC: ReadonlySet<string> = new Set(["56:01", "56:02", "52:01"]);

function seedOf(keypair: VoucherKeypair): Uint8Array {
  const key = keypair.secretKey;
  if (!(key instanceof Uint8Array) || (key.byteLength !== 32 && key.byteLength !== 64)) {
    throw new SchemeError(SCHEME_ERROR_CODES.invalidPayload, "secretKey must be 32 or 64 bytes");
  }
  return key.subarray(0, 32);
}

function assertFramed(message: Uint8Array): void {
  if (message.byteLength < 3) throw new SchemeError(SCHEME_ERROR_CODES.invalidPayload, "message must carry a two-byte domain separator and a body");
  if (RESERVED_MAGIC.has(`${message[0]!.toString(16).padStart(2, "0")}:${message[1]!.toString(16).padStart(2, "0")}`)) {
    throw new SchemeError(SCHEME_ERROR_CODES.invalidPayload, "message starts with a magic the scheme reserves for its own messages");
  }
}

/**
 * Sign `message` with the keypair; the signature is returned base58.
 *
 * @throws SchemeError when the key is malformed or the message starts with a reserved magic
 */
export function signMessage(keypair: VoucherKeypair, message: Uint8Array): string {
  assertFramed(message);
  return encodeBase58(ed.sign(message, seedOf(keypair)));
}

/**
 * Verify a base58 signature over `message` against a base58 or raw 32-byte public key.
 * Returns false, and never throws, for a malformed key, signature or message.
 */
export function verifyMessage(pubkey: string | Uint8Array, message: Uint8Array, signature: string): boolean {
  const key = pubkey instanceof Uint8Array ? pubkey : decodeBase58Exact(pubkey, 32);
  if (!key || key.byteLength !== 32) return false;
  const sig = decodeBase58Exact(signature, 64);
  if (!sig) return false;
  try {
    assertFramed(message);
    return ed.verify(sig, message, key);
  } catch {
    return false;
  }
}
