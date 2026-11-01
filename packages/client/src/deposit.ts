import type { Address } from "@solana/kit";
import { clientRefId, type BuyerBinding } from "@wakeless/binding";
import {
  SCHEME_ERROR_CODES,
  SCHEME_ID,
  SchemeError,
  clientRefOf,
  deriveChannelId,
  parseU64,
  publicKeyOf,
  signVoucher,
  type DepositPayload,
  type PaymentRequirements,
  type VoucherKeypair,
} from "@wakeless/scheme";

/**
 * The buyer side of a deposit (task 4.1). Given the vendor's shielded accept, the
 * buyer's voucher key, a salt and the amounts, it derives the channel id and its
 * `clientRefId`, makes the private transfer to the escrow through the rail, signs
 * the first (or next) cumulative voucher, and returns the `deposit` payload the
 * client puts in `PAYMENT-SIGNATURE`. A top-up is the same call with the
 * channel's salt and the next cumulative.
 *
 * The buyer key signs here and nowhere else: only the voucher signature and the
 * public key reach the rail or the wire.
 */
export interface DepositInput {
  /** The rail that makes the private transfer (`MagicBlockBuyer` in v1). */
  readonly rail: BuyerBinding;
  /** The chosen `accepts[]` entry. */
  readonly requirements: PaymentRequirements;
  /** The buyer: signs the voucher; its public key is `channelConfig.buyer`. 32-byte seed or 64-byte Solana keypair. */
  readonly buyer: VoucherKeypair;
  /** Decimal u64. Fresh for a new channel; the channel's own for a top-up. */
  readonly salt: string;
  /** The deposit, atomic units. At least `extra.minDeposit` when the accept names one. */
  readonly amount: bigint;
  /** The voucher's cumulative claimable amount after this request: `amount` plus the fee share for a new channel, the previous accepted plus that for a top-up. */
  readonly cumulative: bigint;
}

export interface DepositResult {
  readonly payload: DepositPayload;
  readonly channelId: string;
  readonly clientRef: string;
  /** The private transfer's signature; also `payload.depositSignature`. */
  readonly signature: string;
}

/** The accept cannot be deposited to by this rail or with these inputs. Nothing was sent. */
export class DepositRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "DepositRefusedError";
  }
}

export async function deposit(input: DepositInput): Promise<DepositResult> {
  const { rail, requirements, buyer, salt, amount, cumulative } = input;
  const { extra } = requirements;
  if (requirements.scheme !== SCHEME_ID) throw new DepositRefusedError(SCHEME_ERROR_CODES.unsupportedScheme, `the accept is not ${SCHEME_ID}`);
  if (extra.binding !== rail.id) throw new DepositRefusedError(SCHEME_ERROR_CODES.invalidPaymentRequirements, `the accept wants binding ${extra.binding}; this rail is ${rail.id}`);
  if (requirements.network !== rail.network()) throw new DepositRefusedError(SCHEME_ERROR_CODES.invalidNetwork, "the accept's network is not the rail's");
  if (rail.teeValidator !== undefined && extra.teeValidator !== rail.teeValidator) {
    throw new DepositRefusedError(SCHEME_ERROR_CODES.shieldedAttestationFailed, "the accept's teeValidator is not the identity this rail attested");
  }
  if (amount <= 0n) throw new DepositRefusedError(SCHEME_ERROR_CODES.invalidPayload, "deposit amount must be positive");
  if (extra.minDeposit !== undefined) {
    const min = parseU64(extra.minDeposit, "extra.minDeposit", SCHEME_ERROR_CODES.invalidPaymentRequirements);
    if (!min.ok) throw new DepositRefusedError(min.code, min.message);
    if (amount < min.value) throw new DepositRefusedError(SCHEME_ERROR_CODES.depositBelowMinDeposit, "deposit amount is below extra.minDeposit");
  }
  if (cumulative <= 0n) throw new DepositRefusedError(SCHEME_ERROR_CODES.invalidPayload, "voucher cumulative must be positive");

  const buyerAddress = publicKeyOf(buyer);
  let channelId: string;
  try {
    channelId = deriveChannelId({ buyer: buyerAddress, escrowAddress: extra.escrowAddress, mint: requirements.asset, salt });
  } catch (error) {
    if (error instanceof SchemeError) throw new DepositRefusedError(error.code, "the accept and salt do not derive a channel id");
    throw error;
  }
  const clientRef = clientRefOf(channelId);

  // The private transfer. The rail fails loudly when it cannot make it privately.
  const { sig, transaction } = await rail.deposit(extra.escrowAddress as Address, amount, { id: clientRefId(clientRef) });

  const voucher = signVoucher(buyer, { channelId, maxClaimableAmount: cumulative.toString(), expiresAt: 0 });
  const payload: DepositPayload = {
    type: "deposit",
    channelConfig: { buyer: buyerAddress, vendor: requirements.payTo, mint: requirements.asset, salt, withdrawDelay: extra.withdrawDelay },
    depositSignature: sig,
    deposit: { amount: amount.toString(), transaction },
    voucher,
  };
  return { payload, channelId, clientRef, signature: sig };
}
