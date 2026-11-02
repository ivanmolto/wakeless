import type { Address, Signature } from "@solana/kit";
import type { ChannelId, ClientRef, ClientRefId, DepositRef, SettleRef } from "./refs.js";

/** CAIP-2 network id: `solana:<first 32 chars of the genesis hash>`. */
export type Caip2 = `solana:${string}`;

export const DEVNET_CAIP2: Caip2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";
export const MAINNET_CAIP2: Caip2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp";

export type BindingId = "magicblock" | "rings" | "privacycash";

/**
 * What the watcher checks for one signature on the public ledger (`packages/watcher`): no
 * vendor address, no vendor-attributable amount, no Memo instruction, no fee transfer naming
 * the vendor. A signature that executed inside the rollup is not on the base layer at all;
 * `onBaseLayer` is then false and every list is empty.
 */
export interface ObserverView {
  readonly signature: Signature;
  readonly onBaseLayer: boolean;
  /** Every program invoked, outer and inner instructions, in first-seen order. */
  readonly programIds: readonly Address[];
  readonly signers: readonly Address[];
  /** Token amounts readable in plaintext: parsed SPL transfers and token-balance deltas. */
  readonly plaintextAmounts: readonly PlaintextAmount[];
  /** Token accounts credited in plaintext. */
  readonly plaintextRecipients: readonly Address[];
  /** Text of every Memo Program instruction; Wakeless requires this empty. */
  readonly memoText: readonly string[];
  /** System-program lamport transfers, including rent and fee payments. */
  readonly feeTransfers: readonly FeeTransfer[];
}

export interface PlaintextAmount {
  readonly amount: bigint;
  readonly kind: "transfer" | "balanceDelta";
  readonly source?: Address;
  readonly destination?: Address;
  readonly owner?: Address;
  readonly mint?: Address;
}

export interface FeeTransfer {
  readonly from: Address;
  readonly to: Address;
  readonly lamports: bigint;
}

/**
 * The binding's record of one redemption. The facilitator signs it and hands it to the
 * vendor off-chain; with the encrypted `clientRefId` it is the only place receipt data goes.
 * `signature` is the transfer's signature on the layer it executed on.
 */
export interface Receipt {
  readonly channelId: ChannelId;
  readonly period: number;
  readonly cumulative: bigint;
  readonly amount: bigint;
  readonly signature: Signature;
  readonly ref: ClientRefId;
}

/**
 * What a settlement pool must provide (briefing §3, "Binding interface"). Amounts are base
 * units of the pool's mint as bigint. A binding that cannot complete a call privately fails
 * loudly with a `BindingError`; none may fall back to a public transfer, and a rejected
 * private transfer is never retried as a public one.
 */
export interface SettlementBinding {
  readonly id: BindingId;
  network(): Caip2;
  escrowAddress(): Address;
  /**
   * Confirms a buyer's deposit: the signature landed and succeeded, the signed transaction
   * names the buyer and the amount and pays the escrow, and the escrow's private balance
   * grew by the amount. Null when any of that is not (yet) true, or when the signature was
   * already credited.
   */
  readDeposit(sig: Signature, ref: DepositRef): Promise<{ amount: bigint; buyer: Address } | null>;
  /** One private transfer escrow → vendor for one channel and period. */
  settle(to: Address, amount: bigint, ref: SettleRef): Promise<{ sig: Signature; receipt: Receipt }>;
  /** Private transfer of the unspent deposit back to the buyer. */
  refund(to: Address, amount: bigint, ref: ClientRef): Promise<{ sig: Signature }>;
  /** The escrow's private balance in base units. */
  privateBalance(): Promise<bigint>;
  /** What the public ledger shows for a signature; what the watcher checks. */
  observe(sig: Signature): Promise<ObserverView>;
}

/**
 * The vendor's read-only view of a rail (task 7.3): logged in with the vendor's own key,
 * it reads the vendor's private balance and asks whether a private transfer to it landed.
 * It signs nothing but its logins and moves nothing.
 */
export interface PayeeBinding {
  readonly id: BindingId;
  network(): Caip2;
  address(): Address;
  /**
   * The vendor's private balance in base units, and every reference id the rail's read
   * endpoint exposes beside it (`clientRefId`, memo or reference fields); none is expected.
   */
  privateBalance(): Promise<{ balance: bigint; referenceIds: readonly string[] }>;
  /** Whether a transfer signature is readable on the rail with the vendor's own login, and succeeded. */
  transferStatus(sig: Signature): Promise<"landed" | "failed" | "not_found">;
}

/**
 * The buyer's side of a rail: the one private transfer a buyer makes, from its own
 * private balance to the escrow, carrying the channel's `clientRefId`. The client
 * (`@wakeless/client`) reaches the primitive only through this interface. A rail that
 * cannot make the deposit privately fails loudly with a `BindingError`; none falls back
 * to a public transfer.
 */
export interface BuyerBinding {
  readonly id: BindingId;
  /**
   * The TEE validator identity the rail attested at construction, when the rail has a
   * TEE. The client refuses an accept whose `extra.teeValidator` differs.
   */
  readonly teeValidator?: Address;
  network(): Caip2;
  /**
   * Builds, signs and submits the private transfer of `amount` base units to `to` with
   * `ref.id` as the encrypted reference, waits until it is readable, and returns its
   * signature and the signed transaction in base64 wire format, exactly as submitted,
   * for the x402 `deposit` payload.
   */
  deposit(to: Address, amount: bigint, ref: ClientRef): Promise<{ sig: Signature; transaction: string }>;
}
