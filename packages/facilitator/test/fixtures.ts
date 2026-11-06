// Shared fixtures for the HTTP tests: a binding that answers only what `/supported` and the
// request parser read (nothing is transferred in a unit test), a buyer key, and the
// shielded accept the tests agree on. No MagicBlock code: the binding interface is enough.
import { randomBytes } from "node:crypto";
import type { Address } from "@solana/kit";
import { DEVNET_CAIP2, type SettlementBinding } from "@wakeless/binding";
import {
  SCHEME_ID,
  clientRefOf,
  deriveChannelId,
  encodeBase58,
  publicKeyOf,
  signVoucher,
  type BatchVoucher,
  type ChannelConfig,
  type DepositPayload,
  type PaymentPayload,
  type PaymentRequirements,
  type VoucherKeypair,
  type VoucherPayload,
} from "@wakeless/scheme";
import type { BindingState, ChannelRecord } from "../src/index.js";

export const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";
export const TEE_VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
export const AMOUNT = 10_000n;
/** `amount` plus the 10 bps fee share the client adds, rounded up. */
export const CHARGE = AMOUNT + 10n;
export const DEPOSIT = 1_000_000n;

export function address(): string {
  return encodeBase58(randomBytes(32));
}

export function keypair(): VoucherKeypair {
  return { secretKey: new Uint8Array(randomBytes(32)) };
}

const unused = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));

export function fakeBinding(escrowAddress = address()): SettlementBinding {
  return {
    id: "magicblock",
    network: () => DEVNET_CAIP2,
    escrowAddress: () => escrowAddress as Address,
    readDeposit: unused("readDeposit"),
    settle: unused("settle"),
    refund: unused("refund"),
    privateBalance: unused("privateBalance"),
    transferStatus: unused("transferStatus"),
    observe: unused("observe"),
  };
}

export function ready(binding = fakeBinding()): BindingState {
  return { status: "ready", binding, teeValidator: TEE_VALIDATOR };
}

export interface Scenario {
  readonly buyer: VoucherKeypair;
  readonly buyerAddress: string;
  readonly vendor: string;
  readonly escrow: string;
  readonly requirements: PaymentRequirements;
  readonly channelConfig: ChannelConfig;
  readonly channelId: string;
  readonly record: ChannelRecord;
}

export function scenario(escrow = address(), overrides: Partial<PaymentRequirements> = {}): Scenario {
  const buyer = keypair();
  const buyerAddress = publicKeyOf(buyer);
  const vendor = address();
  const requirements: PaymentRequirements = {
    scheme: SCHEME_ID,
    network: DEVNET_CAIP2,
    amount: AMOUNT.toString(),
    asset: USDC,
    payTo: vendor,
    maxTimeoutSeconds: 60,
    extra: {
      paymentFlow: "authorization",
      voucherSigner: "client",
      withdrawDelay: 900,
      tokenProgram: TOKEN_PROGRAM,
      maxIdleSecs: 604_800,
      escrowAddress: escrow,
      binding: "magicblock",
      teeValidator: TEE_VALIDATOR,
      privacyFeeBps: 10,
    },
    ...overrides,
  };
  const channelConfig: ChannelConfig = { buyer: buyerAddress, vendor, mint: USDC, salt: "7", withdrawDelay: 900 };
  const channelId = deriveChannelId({ buyer: buyerAddress, escrowAddress: escrow, mint: USDC, salt: "7" });
  const record: ChannelRecord = {
    channelId,
    clientRef: clientRefOf(channelId),
    buyer: buyerAddress,
    vendor,
    mint: USDC,
    deposit: DEPOSIT,
    settled: 0n,
    accepted: 0n,
    latestVoucher: null,
    state: "open",
    lastActivityAt: 1_700_000_000,
  };
  return { buyer, buyerAddress, vendor, escrow, requirements, channelConfig, channelId, record };
}

export function voucherOf(s: Scenario, cumulative: bigint, signer: VoucherKeypair = s.buyer): BatchVoucher {
  return signVoucher(signer, { channelId: s.channelId, maxClaimableAmount: cumulative.toString(), expiresAt: 0 });
}

export function voucherPayload(s: Scenario, cumulative: bigint, voucher = voucherOf(s, cumulative)): VoucherPayload {
  return { type: "voucher", channelConfig: s.channelConfig, voucher };
}

/** Stands in for the client-signed wire transaction; the HTTP tests' binding fake never decodes it. */
export function wireTransaction(): string {
  return randomBytes(300).toString("base64");
}

export function depositPayload(s: Scenario, amount: bigint, cumulative: bigint, overrides: Partial<Pick<DepositPayload, "depositSignature" | "channelConfig">> = {}): DepositPayload {
  return {
    type: "deposit",
    channelConfig: s.channelConfig,
    depositSignature: encodeBase58(randomBytes(64)),
    deposit: { amount: amount.toString(), transaction: wireTransaction() },
    voucher: voucherOf(s, cumulative),
    ...overrides,
  };
}

export function envelope(s: Scenario, payload: PaymentPayload["payload"], requirements: PaymentRequirements = s.requirements) {
  const paymentPayload: PaymentPayload = { x402Version: 2, accepted: requirements, payload };
  return { x402Version: 2, paymentPayload, paymentRequirements: requirements };
}
