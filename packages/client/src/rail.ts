// The default rail: `MagicBlockBuyer` from `@wakeless/binding-magicblock`, built from the
// connection details once per session. Construction attests the TEE RPC
// (`verifyTeeRpcIntegrity`) and logs the buyer in; that is the one place the buyer's
// key is used outside voucher signing, and it stays inside the binding's process.
import { createKeyPairFromBytes, createKeyPairFromPrivateKeyBytes, type Address } from "@solana/kit";
import { DEVNET_CAIP2, type BuyerBinding, type Caip2 } from "@wakeless/binding";
import { MagicBlockBuyer, type MagicBlockTransport } from "@wakeless/binding-magicblock";
import { CLIENT_ERROR_CODES, WakelessClientError } from "./errors.js";

export const DEFAULT_PAYMENTS_API = "https://payments.magicblock.app";
export const DEFAULT_TEE_RPC = "https://devnet-tee.magicblock.app";
/** Devnet USDC (`docs/SCHEME.md` §4.1). */
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

export interface MagicBlockRailOptions {
  /** Private Payments API base URL. Default `https://payments.magicblock.app`. */
  readonly paymentsApi?: string;
  /** The TEE RPC the deposits are submitted to and attested against. Default `https://devnet-tee.magicblock.app`. */
  readonly teeRpc?: string;
  /** The Helius devnet RPC; the binding asserts the cluster's genesis hash. Carries an API key: never logged. */
  readonly baseRpc?: string;
  /** The channel mint. Default devnet USDC. */
  readonly mint?: string;
  /** Devnet only in v1. */
  readonly network?: Caip2;
  /** When set, the attestation report is written here at construction. */
  readonly attestationReportPath?: string;
  /** Tests and the e2e harness only: a wire the binding talks through instead of the real one. */
  readonly transport?: MagicBlockTransport;
}

/** Builds the MagicBlock rail for a buyer. The keypair is 64 bytes (seed then public key) or a 32-byte seed. */
export async function createMagicBlockRail(buyerKeypair: Uint8Array, options: MagicBlockRailOptions): Promise<BuyerBinding> {
  if (options.baseRpc === undefined) {
    throw new WakelessClientError(CLIENT_ERROR_CODES.railUnconfigured, "no rail was given and baseRpc is not set; pass rail, or paymentsApi, teeRpc and baseRpc");
  }
  const buyer = buyerKeypair.byteLength === 64 ? await createKeyPairFromBytes(buyerKeypair) : await createKeyPairFromPrivateKeyBytes(buyerKeypair);
  return MagicBlockBuyer.create({
    network: options.network ?? DEVNET_CAIP2,
    baseRpcUrl: options.baseRpc,
    teeRpcUrl: options.teeRpc ?? DEFAULT_TEE_RPC,
    paymentsApiUrl: options.paymentsApi ?? DEFAULT_PAYMENTS_API,
    mint: (options.mint ?? DEVNET_USDC) as Address,
    buyer,
    ...(options.attestationReportPath === undefined ? {} : { attestationReportPath: options.attestationReportPath }),
    ...(options.transport === undefined ? {} : { transport: options.transport }),
  });
}
