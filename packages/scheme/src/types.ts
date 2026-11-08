/**
 * Wire types of the `batch-settlement-shielded` scheme. Shapes follow
 * `docs/SCHEME.md`: the x402 V2 envelope and the SVM `batch-settlement`
 * payloads unchanged where they can be, reduced where the payment-channels
 * program gave a field its only meaning.
 */

export const SCHEME_ID = "batch-settlement-shielded" as const;
export type SchemeId = typeof SCHEME_ID;

export const X402_VERSION = 2 as const;

/** CAIP-2 network ids. Development and tests run on devnet. */
export const DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1" as const;
export const MAINNET_CAIP2 = "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" as const;

/** The private-transfer rail a channel is built on. v1 implements `magicblock`. */
export type BindingId = "magicblock" | "rings" | "privacycash";

/** `extra.withdrawDelay` range from the SVM scheme, seconds. */
export const WITHDRAW_DELAY_MIN = 900;
export const WITHDRAW_DELAY_MAX = 2_592_000;

/** `extra` of a shielded accept (`docs/SCHEME.md` §4.2). */
export interface ShieldedExtra {
  /** When present, must be `"authorization"`. */
  readonly paymentFlow?: "authorization";
  /** Always `"client"`; there is no server mode. */
  readonly voucherSigner?: "client";
  /** Seconds, `900..=2592000`, `>= maxTimeoutSeconds`. */
  readonly withdrawDelay: number;
  /** Token program that owns `asset`, base58. */
  readonly tokenProgram: string;
  /** Deposit target in atomic units, `>= amount`. Decimal u64 string. */
  readonly minDeposit?: string;
  /** Copied from `/supported`. */
  readonly maxIdleSecs?: number;
  /** The escrow keypair's public key, base58. One of the `channelId` inputs. */
  readonly escrowAddress: string;
  readonly binding: BindingId;
  /** TEE validator identity, base58; the client attests it before its first deposit. */
  readonly teeValidator: string;
  /** Facilitator fee in basis points; the client adds the fee share to `maxClaimableAmount`. */
  readonly privacyFeeBps: number;
  /** Corrective 402 only. */
  readonly channelState?: ChannelState;
  readonly voucherState?: VoucherState;
  /**
   * Relationship terms (vendor middleware behind `RELATIONSHIP_TERMS`, task 12.1T): the
   * vendor-signed account of this entry's `amount` and `minDeposit`. Opaque here; the
   * vendor package defines and verifies it. Never forwarded to the facilitator.
   */
  readonly termsReceipt?: Readonly<Record<string, unknown>>;
}

/** One `accepts[]` entry (`specs/x402-specification-v2.md:L122`-`L130` with the shielded `extra`). */
export interface PaymentRequirements {
  readonly scheme: SchemeId;
  /** CAIP-2, `solana:*`. */
  readonly network: string;
  /** Per-request amount, atomic units, decimal u64 string. */
  readonly amount: string;
  /** SPL or Token-2022 mint, base58. */
  readonly asset: string;
  /** Vendor, base58. */
  readonly payTo: string;
  readonly maxTimeoutSeconds: number;
  readonly extra: ShieldedExtra;
}

export interface ResourceInfo {
  readonly url: string;
  readonly description?: string;
  readonly mimeType?: string;
  readonly serviceName?: string;
  readonly tags?: readonly string[];
  readonly iconUrl?: string;
}

export interface PaymentRequired {
  readonly x402Version: typeof X402_VERSION;
  readonly error?: string;
  readonly resource: ResourceInfo;
  readonly accepts: readonly PaymentRequirements[];
  readonly extensions?: Readonly<Record<string, unknown>>;
}

/**
 * The reduced channel configuration (`docs/SCHEME.md` §4.3). `buyer` is the
 * voucher signer; it replaces both `payer` and `payerAuthorizer`. `openSlot`
 * is gone: it existed only as a PDA seed.
 */
export interface ChannelConfig {
  readonly buyer: string;
  /** Must equal `payTo`. */
  readonly vendor: string;
  /** Must equal `asset`. */
  readonly mint: string;
  /** Decimal u64 string. */
  readonly salt: string;
  /** Must equal `extra.withdrawDelay`. */
  readonly withdrawDelay: number;
}

/** The fields a voucher signs over, before the signature exists. */
export interface UnsignedVoucher {
  /** Base58, decodes to 32 bytes (`deriveChannelId`). */
  readonly channelId: string;
  /** Cumulative claimable amount, decimal u64 string. Not a delta. */
  readonly maxClaimableAmount: string;
  /** Always `0`; a nonzero value is `invalid_batch_settlement_svm_voucher_expiry`. */
  readonly expiresAt: 0;
}

/** `BatchVoucher` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L395`-`L400`). */
export interface BatchVoucher extends UnsignedVoucher {
  /** Base58 Ed25519 signature by `channelConfig.buyer` over the 50-byte message. */
  readonly signature: string;
}

/**
 * Opens a channel or tops it up and authorizes the current request. The buyer
 * has already made the private transfer (visibility `private`, `toBalance`
 * `ephemeral`, `clientRefId = clientRefOf(channelId)`) from its own private
 * balance to `extra.escrowAddress`; the facilitator confirms it through
 * `binding.readDeposit` and records `deposit += amount`.
 */
export interface DepositPayload {
  readonly type: "deposit";
  readonly channelConfig: ChannelConfig;
  /** Base58 signature of the buyer's private transfer to `extra.escrowAddress` carrying the `clientRefId`. */
  readonly depositSignature: string;
  readonly deposit: {
    /** Atomic units, decimal u64 string. */
    readonly amount: string;
    /**
     * The client-signed private transfer, base64 wire format, exactly as
     * submitted to the rollup. The enclave returns neither sender, amount nor
     * reference for an ephemeral signature, so the binding verifies the buyer
     * and the amount from these bytes before it checks the escrow's balance.
     */
    readonly transaction: string;
  };
  /** The first (or next) cumulative voucher. */
  readonly voucher: BatchVoucher;
}

/** The steady-state paid request: no transaction. */
export interface VoucherPayload {
  readonly type: "voucher";
  readonly channelConfig: ChannelConfig;
  readonly voucher: BatchVoucher;
}

/**
 * The buyer's close request (task 8.1), sent by the buyer straight to the facilitator's
 * `/settle`. `voucher` is the buyer's latest voucher (its own signature over the
 * cumulative it last committed to); `closeSignature` is a second buyer signature over
 * the 42-byte close message built from that voucher (`encodeCloseMessage`). The
 * facilitator moves the channel to `closing`; the vendor may still present its latest
 * voucher for `withdrawDelay` seconds; then the worker pays the vendor what is owed and
 * refunds `deposit − settled` to the buyer's private balance. Repeating the request on a
 * closing or closed channel answers its current `extra.closeState` and changes nothing.
 */
export interface RefundPayload {
  readonly type: "refund";
  readonly channelConfig: ChannelConfig;
  readonly voucher: BatchVoucher;
  /** Base58 Ed25519 by `channelConfig.buyer` over the close message. */
  readonly closeSignature: string;
}

export type ShieldedPayload = DepositPayload | VoucherPayload | RefundPayload;

/** The close of a channel as `/settle` reports it on a `refund` payload. Unix seconds; amounts decimal u64 strings. */
export interface CloseState {
  readonly state: "closing" | "closed";
  /** When the close was requested (the buyer's request, or the idle close). */
  readonly requestedAt: number;
  /** `requestedAt + withdrawDelay`: the vendor's latest voucher is accepted until then; the refund is sent after. */
  readonly refundAfter: number;
  readonly deposit: string;
  /** Cumulative redeemed to the vendor so far. */
  readonly settled: string;
  /** The refund once it has been sent: `deposit − settled` at that moment, and the private transfer's signature (null when the facilitator reconciled it at startup without one). */
  readonly refund: { readonly amount: string; readonly signature: string | null } | null;
}

/** The `PAYMENT-SIGNATURE` envelope (`specs/x402-specification-v2.md:L197`-`L205`). */
export interface PaymentPayload {
  readonly x402Version: typeof X402_VERSION;
  readonly resource?: ResourceInfo;
  /** A copy of the chosen `PaymentRequirements`. */
  readonly accepted: PaymentRequirements;
  readonly payload: ShieldedPayload;
  readonly extensions?: Readonly<Record<string, unknown>>;
}

export interface ChannelState {
  readonly channelId: string;
  /** Confirmed private deposit, decimal u64 string. */
  readonly balance: string;
  /** Cumulative already redeemed to the vendor, decimal u64 string. */
  readonly totalClaimed: string;
  readonly withdrawRequestedAt: number | null;
  /** Server-authored watermark. */
  readonly chargedCumulativeAmount?: string;
}

/**
 * The server's last accepted voucher, on a corrective 402 only
 * (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L1216`-`L1269`).
 * The buyer verifies `signature` as its own over the 50-byte message rebuilt
 * from the derived channel id, `signedMaxClaimable` and `expiresAt` before
 * adopting `channelState.chargedCumulativeAmount`.
 */
export interface VoucherState {
  readonly signedMaxClaimable: string;
  readonly expiresAt: number;
  /** Base58 Ed25519, the buyer's own. */
  readonly signature: string;
}

/**
 * The facilitator-signed off-chain receipt (briefing §3; plan task 7.2). With
 * `clientRefId` it is the only other place receipt data goes; never a Memo.
 * One per redeemed period of a channel, handed to the vendor by
 * `GET /receipts/:channelId`. `cumulative` is the channel's settled watermark
 * after the period, gross of the privacy fee; `amount` is what the vendor's
 * private balance received for the period, the owed amount net of the fee.
 */
export interface SettlementReceipt {
  /** Base58, decodes to 32 bytes (`deriveChannelId`). */
  readonly channelId: string;
  /** 1-based; one private transfer per channel per period. */
  readonly period: number;
  /** Decimal u64 string. */
  readonly cumulative: string;
  /** Decimal u64 string. */
  readonly amount: string;
  /** Base58 signature of the private transfer escrow → vendor on the layer it executed on. */
  readonly signature: string;
  /** Base58 Ed25519 signature by the facilitator's receipt signer (`/supported` `signers`) over the 122-byte receipt message. */
  readonly facilitatorSignature: string;
}

export interface SettlementExtra {
  /** Non-empty on voucher acceptance, `<channelId>:<watermark>`. */
  readonly commitmentId: string;
  readonly chargedAmount: string;
  readonly channelState?: ChannelState;
  /** The key fixed by task 3.1 for the off-chain receipt. */
  readonly receipt?: SettlementReceipt;
  /** `true` when `/settle` answered a repeated identical payload with its stored result. */
  readonly replayed?: boolean;
  /** On a `refund` payload: where the close stands. */
  readonly closeState?: CloseState;
}

/** `PAYMENT-RESPONSE` (`specs/x402-specification-v2.md:L244`-`L253`; SVM fields under `extra`). */
export interface SettlementResponse {
  readonly success: boolean;
  readonly errorReason?: string;
  /** Emitted per the core spec although the SVM table omits it (`docs/DEVIATIONS.md`). */
  readonly errorMessage?: string;
  readonly payer?: string;
  /** `""` for a voucher; the deposit signature for a deposit. */
  readonly transaction: string;
  readonly network: string;
  readonly amount?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
  readonly extra?: SettlementExtra;
}

export interface VerifyResponse {
  readonly isValid: boolean;
  readonly invalidReason?: string;
  readonly invalidMessage?: string;
  readonly payer?: string;
  readonly extensions?: Readonly<Record<string, unknown>>;
  /**
   * The channel as stored. On a valid voucher the four spec fields; on a
   * corrective verdict (`invalid_batch_settlement_svm_cumulative_amount_mismatch`,
   * `invalid_batch_settlement_svm_cumulative_exceeds_deposit`) also
   * `chargedCumulativeAmount` and, when a voucher was ever accepted, `voucherState`,
   * for the seller to copy onto the corrective 402's `accepts[].extra`.
   */
  readonly extra?: ChannelState & {
    readonly voucherState?: VoucherState;
  };
}

export interface SupportedKind {
  readonly x402Version: typeof X402_VERSION;
  readonly scheme: SchemeId;
  readonly network: string;
  readonly extra?: Pick<ShieldedExtra, "escrowAddress" | "binding" | "teeValidator" | "privacyFeeBps" | "maxIdleSecs"> & {
    readonly error?: string;
  };
}

export interface SupportedResponse {
  readonly kinds: readonly SupportedKind[];
  readonly extensions: readonly string[];
  readonly signers: Readonly<Record<string, readonly string[]>>;
}
