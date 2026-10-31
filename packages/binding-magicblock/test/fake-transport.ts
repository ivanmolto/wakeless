// A transport that answers like the Payments API and the TEE RPC did on devnet on 31 Oct 2026
// (scripts/spike-magicblock.ts, docs/spike-log.md), records every request, and lets a test
// change one answer at a time. It fakes the wire, never the privacy primitive's semantics:
// the TEE returns an ephemeral transaction without accounts, logs or balances, as observed.
import { getTransferInstruction } from "@solana-program/token";
import {
  appendTransactionMessageInstruction,
  compileTransaction,
  createTransactionMessage,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  pipe,
  setTransactionMessageFeePayer,
  setTransactionMessageLifetimeUsingBlockhash,
  signTransaction,
  type Address,
  type Blockhash,
  type Signature,
} from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { ApiError, TeeRpcError } from "../src/api.js";
import type { EscrowKeyPair } from "../src/binding.js";
import type { ApiRequest, MagicBlockTransport } from "../src/transport.js";

export const TEE_RPC = "https://devnet-tee.magicblock.app";
export const PAYMENTS_API = "https://payments.magicblock.app";
export const BASE_RPC = "https://devnet.helius-rpc.com/?api-key=00000000-0000-0000-0000-000000000000";
export const DEVNET_GENESIS = `${DEVNET_CAIP2.slice("solana:".length)}ngZkXpnbCu8R`;
export const VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
export const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU" as Address;
const BLOCKHASH = "8fJ2RNrqBkVHCdzF8DZo9kLgU17MsR25uq7WQJSe2dXL" as Blockhash;

export type TeeCall = { method: string; params: readonly unknown[]; token?: string };

/** The ephemeral transaction as the TEE RPC returns it to any reader: existence and success only. */
export function teeTransactionAsObserved(signature: string, err: unknown = null) {
  return {
    slot: 670637083,
    transaction: { signatures: [signature], message: { header: { numRequiredSignatures: 0, numReadonlySignedAccounts: 0, numReadonlyUnsignedAccounts: 0 }, accountKeys: [], recentBlockhash: "11111111111111111111111111111111", instructions: [] } },
    meta: { err, status: err === null ? { Ok: null } : { Err: err }, fee: 0, preBalances: [], postBalances: [], innerInstructions: [], logMessages: [], preTokenBalances: [], postTokenBalances: [] },
    blockTime: 1793463714,
  };
}

/** An unsigned transfer as the builder returns it: fee payer and sole required signer `from`. */
export async function buildUnsignedTransfer(from: Address, fromAta: Address, toAta: Address, amount: bigint) {
  const message = pipe(
    createTransactionMessage({ version: 0 }),
    (m) => setTransactionMessageFeePayer(from, m),
    (m) => setTransactionMessageLifetimeUsingBlockhash({ blockhash: BLOCKHASH, lastValidBlockHeight: 400_000_000n }, m),
    (m) => appendTransactionMessageInstruction(getTransferInstruction({ source: fromAta, destination: toAta, authority: from, amount }), m),
  );
  return compileTransaction(message);
}

/** A client-signed deposit: buyer → escrow token account, as the x402 deposit payload carries it. */
export async function signedDeposit(buyer: EscrowKeyPair, buyerAddress: Address, buyerAta: Address, escrowAta: Address, amount: bigint): Promise<{ transaction: string; signature: Signature }> {
  const signed = await signTransaction([buyer], await buildUnsignedTransfer(buyerAddress, buyerAta, escrowAta, amount));
  return { transaction: getBase64EncodedWireTransaction(signed), signature: getSignatureFromTransaction(signed) };
}

export interface FakeTransportOptions {
  escrowAddress: Address;
  escrowAta: Address;
  /** Starting private balance of the escrow, base units. */
  balance?: bigint;
  attest?: () => Promise<boolean | void>;
  /** Replaces the answer to `POST /v1/spl/transfer`. */
  transfer?: (body: Record<string, unknown>) => Promise<unknown>;
  /** Replaces the answer to TEE `sendTransaction`. */
  send?: (params: readonly unknown[]) => Promise<unknown>;
  /** Answers to TEE `getTransaction` by signature; default: found and successful. */
  teeTransactions?: Map<string, unknown>;
  /** Answer to base-layer `getTransaction`; default: null (not on the base layer). */
  baseTransaction?: (signature: Signature) => Promise<unknown>;
  genesisHash?: string;
}

export class FakeTransport implements MagicBlockTransport {
  readonly apiCalls: ApiRequest[] = [];
  readonly teeCalls: TeeCall[] = [];
  balance: bigint;
  private readonly opts: FakeTransportOptions;

  constructor(opts: FakeTransportOptions) {
    this.opts = opts;
    this.balance = opts.balance ?? 10_000n;
  }

  /** Requests to a path, by method. */
  calls(method: ApiRequest["method"], path: string): ApiRequest[] {
    return this.apiCalls.filter((c) => c.method === method && c.path.split("?")[0] === path);
  }

  transferBodies(): Record<string, unknown>[] {
    return this.calls("POST", "/v1/spl/transfer").map((c) => c.body as Record<string, unknown>);
  }

  async verifyTeeRpcIntegrity(url: string): Promise<boolean | void> {
    if (url !== TEE_RPC) throw new Error("fake attests devnet-tee only");
    return this.opts.attest ? this.opts.attest() : true;
  }

  async teeLogin(_url: string, address: Address): Promise<{ token: string; expiresAt: number }> {
    return { token: `tee-token-for-${address.slice(0, 4)}`, expiresAt: Date.now() + 3_600_000 };
  }

  async api(request: ApiRequest): Promise<unknown> {
    this.apiCalls.push(request);
    const path = request.path.split("?")[0];
    switch (`${request.method} ${path}`) {
      case "GET /v1/spl/challenge":
        return { challenge: "Sign in to MagicBlock Payments\nnonce: 1" };
      case "POST /v1/spl/login":
        return { token: "api.token.part3.part4" };
      case "GET /v1/spl/private-balance":
        return { address: this.opts.escrowAddress, mint: USDC, ata: this.opts.escrowAta, location: "ephemeral", balance: this.balance.toString(), delegation: { status: "delegated", validator: VALIDATOR, endpoint: TEE_RPC } };
      case "POST /v1/spl/transfer": {
        const body = request.body as Record<string, unknown>;
        if (this.opts.transfer) return this.opts.transfer(body);
        const tx = await buildUnsignedTransfer(body.from as Address, this.opts.escrowAta, `${String(body.to).slice(0, 10)}ata`.padEnd(44, "1") as Address, BigInt(body.amount as number));
        return {
          kind: "spl.transfer",
          version: "v0",
          transactionBase64: getBase64EncodedWireTransaction(tx),
          sendTo: "ephemeral",
          sendRpcEndpoint: TEE_RPC,
          recentBlockhash: BLOCKHASH,
          lastValidBlockHeight: 400_000_000,
          instructionCount: 1,
          requiredSigners: [body.from],
          validator: VALIDATOR,
        };
      }
      default:
        throw new ApiError(`${request.method} ${path}`, 404, "NOT_FOUND", "Route not found");
    }
  }

  async teeRpc(url: string, method: string, params: readonly unknown[], token?: string): Promise<unknown> {
    if (url !== TEE_RPC) throw new Error("fake answers devnet-tee only");
    this.teeCalls.push({ method, params, token });
    switch (method) {
      case "getIdentity":
        return { identity: VALIDATOR };
      case "sendTransaction": {
        if (!token) throw new TeeRpcError(method, { code: -32000, message: "unauthorized" });
        if (this.opts.send) return this.opts.send(params);
        return "sent";
      }
      case "getTransaction": {
        if (!token) throw new TeeRpcError(method, { code: -32000, message: "unauthorized" });
        const sig = params[0] as string;
        if (this.opts.teeTransactions?.has(sig)) return this.opts.teeTransactions.get(sig);
        return teeTransactionAsObserved(sig);
      }
      default:
        throw new TeeRpcError(method, { code: -32601, message: "Method not found" });
    }
  }

  async baseGenesisHash(): Promise<string> {
    return this.opts.genesisHash ?? DEVNET_GENESIS;
  }

  async baseTransaction(signature: Signature): Promise<unknown> {
    return this.opts.baseTransaction ? this.opts.baseTransaction(signature) : null;
  }
}
