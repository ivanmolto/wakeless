import { sha256 } from "@noble/hashes/sha2.js";
import { decodeBase58Exact, encodeBase58 } from "./base58.js";
import { SCHEME_ERROR_CODES, SchemeError } from "./errors.js";
import { decodeU64Le, encodeU64Le, parseU64 } from "./u64.js";

/**
 * Inputs of the channel id. This derivation replaces the payment-channels PDA
 * seeds `("channel", payer, feePayer, token, payerAuthorizer, salt, openSlot)`
 * (`docs/SCHEME.md` §3.2 S8, §4.3): there is no program and no `feePayer`,
 * `buyer` is both payer and authorizer, the escrow stands where the program
 * stood, and `openSlot` had no meaning beyond being a seed.
 */
export interface ChannelIdInputs {
  /** The voucher signer, base58. */
  readonly buyer: string;
  /** `extra.escrowAddress`, base58. */
  readonly escrowAddress: string;
  /** `asset`, base58. */
  readonly mint: string;
  /** Decimal u64 string. */
  readonly salt: string;
}

/**
 * `channelId = base58(sha256(buyer || escrowAddress || mint || u64(salt).le))`.
 * 32 bytes, so it fits the voucher message at offset 2 unchanged. Pure; the
 * facilitator recomputes it on every request, and a payload whose `channelId`
 * differs is `invalid_batch_settlement_svm_channel_id_mismatch`.
 *
 * @throws SchemeError (`invalid_payload`) when an address is not 32 bytes of base58 or `salt` is not a u64
 */
export function deriveChannelId(inputs: ChannelIdInputs): string {
  const buyer = decodeBase58Exact(inputs.buyer, 32);
  if (!buyer) throw new SchemeError(SCHEME_ERROR_CODES.invalidPayload, "buyer must be a 32-byte base58 address");
  const escrow = decodeBase58Exact(inputs.escrowAddress, 32);
  if (!escrow) throw new SchemeError(SCHEME_ERROR_CODES.invalidPayload, "escrowAddress must be a 32-byte base58 address");
  const mint = decodeBase58Exact(inputs.mint, 32);
  if (!mint) throw new SchemeError(SCHEME_ERROR_CODES.invalidPayload, "mint must be a 32-byte base58 address");
  const salt = parseU64(inputs.salt, "salt", SCHEME_ERROR_CODES.invalidPayload);
  if (!salt.ok) throw new SchemeError(salt.code, salt.message);

  const preimage = new Uint8Array(32 * 3 + 8);
  preimage.set(buyer, 0);
  preimage.set(escrow, 32);
  preimage.set(mint, 64);
  preimage.set(encodeU64Le(salt.value), 96);
  return encodeBase58(sha256(preimage));
}

/** True when `channelId` is base58 and decodes to exactly 32 bytes. */
export function isChannelId(channelId: unknown): channelId is string {
  return decodeBase58Exact(channelId, 32) !== null;
}

/**
 * `clientRefId`: the decimal string of the channel id's first 8 bytes read as a
 * little-endian u64. It is the encrypted reference field of the binding's
 * private transfers and never a Memo. Digits only, no leading zeros, fits u64.
 *
 * @throws SchemeError (`invalid_payload`) when `channelId` is not a 32-byte base58 id
 */
export function clientRefOf(channelId: string): string {
  const bytes = decodeBase58Exact(channelId, 32);
  if (!bytes) throw new SchemeError(SCHEME_ERROR_CODES.invalidPayload, "channelId must be a 32-byte base58 id");
  return decodeU64Le(bytes, 0).toString();
}
