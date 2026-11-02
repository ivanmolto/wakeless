// Requests devnet SOL for the five keypairs and prints the buyer's USDC ATA.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { type Address, address, createSolanaRpc, lamports } from "@solana/kit";
import {
  assertDevnetGenesisHash,
  assertDevnetRpcUrl,
  DEVNET_CAIP2,
  redactSecrets,
} from "./lib/devnet.js";
import { loadDotEnv } from "./lib/env.js";
import { assertNotMainnetKeyPath, KEY_ROLES, publicKeyFromKeypairJson } from "./lib/keypairs.js";
import { isFaucetClosedError, isRateLimitError, MAX_RETRIES, withRateLimitRetry } from "./lib/retry.js";

const ONE_SOL = 1_000_000_000n;
const CONFIRM_TIMEOUT_MS = 60_000;

const root = resolve(import.meta.dirname, "..");
loadDotEnv(root);

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: copy .env.example to .env and fill it in`);
  return value;
}

function readPublicKey(envVar: string, name: string): Address {
  const path = resolve(root, process.env[envVar] || `keys/${name}.json`);
  assertNotMainnetKeyPath(path);
  return publicKeyFromKeypairJson(readFileSync(path, "utf8"));
}

async function main(): Promise<number> {
  const rpcUrl = requireEnv("SOLANA_RPC_URL");
  assertDevnetRpcUrl(rpcUrl);
  const usdcMint = address(requireEnv("USDC_MINT"));
  // The facilitator's receipt signer signs off-chain receipts only and never pays a fee: no SOL.
  const wallets = KEY_ROLES.filter(({ name }) => name !== "facilitator").map(({ name, envVar }) => ({ name, publicKey: readPublicKey(envVar, name) }));

  const rpc = createSolanaRpc(rpcUrl);
  assertDevnetGenesisHash(await rpc.getGenesisHash().send());
  console.log(`cluster  ${DEVNET_CAIP2}`);

  const fund = async (publicKey: Address): Promise<bigint> => {
    const before = (await rpc.getBalance(publicKey).send()).value;
    if (before >= ONE_SOL) return before;
    await withRateLimitRetry(() => rpc.requestAirdrop(publicKey, lamports(ONE_SOL)).send());
    const deadline = Date.now() + CONFIRM_TIMEOUT_MS;
    while (Date.now() < deadline) {
      const balance = (await rpc.getBalance(publicKey).send()).value;
      if (balance > before) return balance;
      await new Promise((r) => setTimeout(r, 2_000));
    }
    throw new Error("Airdrop was accepted but the balance did not change within 60 s");
  };

  let failures = 0;
  for (const { name, publicKey } of wallets) {
    try {
      const balance = await fund(publicKey);
      console.log(`${name.padEnd(8)} ${publicKey} ${Number(balance) / Number(ONE_SOL)} SOL`);
    } catch (error) {
      failures++;
      const reason = isFaucetClosedError(error)
        ? "this RPC's faucet is closed; request SOL for this address at https://faucet.solana.com"
        : isRateLimitError(error)
          ? `rate limited after ${MAX_RETRIES} retries; use https://faucet.solana.com for this address`
          : redactSecrets(error instanceof Error ? error.message : String(error));
      console.error(`${name.padEnd(8)} ${publicKey} FAILED: ${reason}`);
    }
  }

  // Printed even after a failed airdrop: the ATA needs no SOL to derive.
  const buyer = wallets[0]!.publicKey;
  const [ata] = await findAssociatedTokenPda({
    owner: buyer,
    mint: usdcMint,
    tokenProgram: TOKEN_PROGRAM_ADDRESS,
  });
  console.log(`\nbuyer wallet    ${buyer}`);
  console.log(`buyer USDC ATA  ${ata}`);
  console.log("Fund it at https://faucet.circle.com (network: Solana Devnet): paste the buyer wallet.");
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  },
);
