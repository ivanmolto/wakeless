import type { Address } from "@solana/kit";

declare const brand: unique symbol;

/**
 * The reference a private transfer carries in the Private Payments API's `clientRefId`:
 * a decimal u64, digits only, encrypted inside the rollup and returned by no read endpoint
 * (spike, 31 Oct 2026). Never a memo.
 */
export type ClientRefId = string & { readonly [brand]: "ClientRefId" };

const U64_MAX = (1n << 64n) - 1n;

/** Validates digits-only and u64 range. Throws on anything else; never echoes a long input. */
export function clientRefId(value: string | bigint | number): ClientRefId {
  const text = typeof value === "string" ? value : value.toString();
  if (!/^(0|[1-9][0-9]*)$/.test(text) || BigInt(text) > U64_MAX) {
    throw new RangeError(`clientRefId must be a decimal u64 with no leading zeros (got ${text.length} chars)`);
  }
  return text as ClientRefId;
}

/**
 * `channelId = sha256(buyer, escrow, mint, salt)`, 32 bytes as lowercase hex, as the
 * binding's `Receipt` carries it. The wire form is base58 (`@wakeless/scheme`
 * `deriveChannelId`); the two name the same bytes.
 */
export type ChannelId = string & { readonly [brand]: "ChannelId" };

export function channelId(hex: string): ChannelId {
  if (!/^[0-9a-f]{64}$/.test(hex)) throw new RangeError("channelId must be 64 lowercase hex chars");
  return hex as ChannelId;
}

// A channel's `clientRefId` is derived by `@wakeless/scheme` (`clientRefOf`: the first
// eight bytes of the base58 id read as a little-endian u64, `docs/SCHEME.md` §4.3) and
// handed to a binding as a `ClientRefId`. The binding derives nothing from a channel id.

/** What every binding call is told about the transfer it must find or make. */
export interface ClientRef {
  readonly id: ClientRefId;
}

/**
 * What the facilitator knows about a deposit it is asked to confirm. The enclave returns
 * neither sender, amount nor `clientRefId` for an ephemeral transaction, so the buyer and the
 * amount come from the client's signed transaction (the x402 `deposit` payload carries it)
 * and the binding verifies them locally before it checks the escrow's private balance.
 */
export interface DepositRef extends ClientRef {
  readonly buyer: Address;
  readonly amount: bigint;
  /** The client-signed transfer, base64 wire format, exactly as submitted. */
  readonly transaction: string;
}

/** A redemption: `id` is the period reference; the rest fills the receipt. */
export interface SettleRef extends ClientRef {
  readonly channelId: ChannelId;
  readonly period: number;
  /** The channel's cumulative settled amount after this redemption. */
  readonly cumulative: bigint;
}
