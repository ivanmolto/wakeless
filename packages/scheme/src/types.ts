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

/** Opens a channel or tops it up and authorizes the current request. */
export interface DepositPayload {
  readonly type: "deposit";
  readonly channelConfig: ChannelConfig;
  /** Signature of the buyer's private transfer to `extra.escrowAddress` carrying the `clientRefId`. */
  readonly depositSignature: string;
  readonly deposit: { readonly amount: string };
  /** The first (or next) cumulative voucher. */
  readonly voucher: BatchVoucher;
}

/** The steady-state paid request: no transaction. */
export interface VoucherPayload {
  readonly type: "voucher";
  readonly channelConfig: ChannelConfig;
  readonly voucher: BatchVoucher;
}

export type ShieldedPayload = DepositPayload | VoucherPayload;

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

export interface VoucherState {
  readonly channelId: string;
  readonly maxClaimableAmount: string;
}

/**
 * The facilitator-signed off-chain receipt (briefing §3). With `clientRefId`
 * it is the only other place receipt data goes; never a Memo.
 */
export interface SettlementReceipt {
  readonly channelId: string;
  readonly cumulative: string;
  readonly period: number;
  /** Base58 Ed25519 signature by the facilitator's receipt signer (`/supported` `signers`). */
  readonly signature: string;
}

export interface SettlementExtra {
  /** Non-empty on voucher acceptance, `<channelId>:<watermark>`. */
  readonly commitmentId: string;
  readonly chargedAmount: string;
  readonly channelState?: ChannelState;
  /** The key fixed by task 3.1 for the off-chain receipt. */
  readonly receipt?: SettlementReceipt;
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
  readonly extra?: {
    readonly channelId: string;
    readonly balance: string;
    readonly totalClaimed: string;
    readonly withdrawRequestedAt: number | null;
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
