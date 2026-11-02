// `pnpm fund:private --role buyer --usdc 1`: moves devnet USDC from a wallet's base token
// account into its private balance with one Payments API vault deposit (`POST /v1/spl/deposit`,
// `private: true`), as spike step 3a. This is a public base-layer transaction naming the wallet
// and the vault; it is onboarding, not part of the rail, and the client never makes it. Prints
// the private balance before and after and the base-layer signature. Devnet only; never a key
// under keys/mainnet/; never prints a token or a key.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import {
  address,
  createKeyPairFromBytes,
  createSolanaRpc,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  signBytes,
  signature as asSignature,
} from "@solana/kit";
import { assertDevnetGenesisHash, assertDevnetRpcUrl, redactSecrets } from "./lib/devnet.js";
import { loadDotEnv } from "./lib/env.js";
import { assertNotMainnetKeyPath, KEY_ROLES } from "./lib/keypairs.js";

const ROOT = resolve(import.meta.dirname, "..");
const API_CLUSTER = "devnet-private";
const USDC = 1_000_000n;
/** A cap, so a typo cannot move the whole base balance. */
const MAX_USDC = 5;

function arg(name: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  return process.argv[i]!.includes("=") ? process.argv[i]!.split("=")[1] : process.argv[i + 1];
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

async function main(): Promise<void> {
  const role = KEY_ROLES.find((r) => r.name === arg("role") && r.name !== "facilitator");
  const usdc = Number(arg("usdc"));
  if (role === undefined || !Number.isFinite(usdc) || usdc <= 0 || usdc > MAX_USDC) {
    throw new Error(`usage: pnpm fund:private --role <buyer|escrow|vendor1|vendor2|vendor3> --usdc <0 < n <= ${MAX_USDC}>`);
  }
  const amount = BigInt(Math.round(usdc * Number(USDC)));

  loadDotEnv(ROOT);
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured here: this script runs on devnet only");
  const rpcUrl = required("SOLANA_RPC_URL");
  assertDevnetRpcUrl(rpcUrl);
  const paymentsApi = (process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app").replace(/\/$/, "");
  if (/mainnet/i.test(new URL(paymentsApi).hostname)) throw new Error("Refusing a mainnet Payments API");
  const mint = address(required("USDC_MINT"));

  const keyPath = resolve(ROOT, process.env[role.envVar] || `keys/${role.name}.json`);
  assertNotMainnetKeyPath(keyPath);
  const keyPair = await createKeyPairFromBytes(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")) as number[]));
  const owner = await getAddressFromPublicKey(keyPair.publicKey);

  const rpc = createSolanaRpc(rpcUrl);
  assertDevnetGenesisHash(await rpc.getGenesisHash().send());

  const api = async <T>(method: "GET" | "POST", path: string, body?: unknown, token?: string): Promise<T> => {
    const headers: Record<string, string> = { accept: "application/json" };
    if (body !== undefined) headers["content-type"] = "application/json";
    if (token) headers.authorization = `Bearer ${token}`;
    const res = await fetch(`${paymentsApi}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
    const json = (await res.json().catch(() => ({}))) as { error?: { code?: string; message?: string } };
    if (!res.ok) throw new Error(`${method} ${path} → HTTP ${res.status}${json.error?.code ? ` ${json.error.code}` : ""}${json.error?.message ? `: ${json.error.message}` : ""}`);
    return json as T;
  };

  // Payments API login, for the private-balance reads. The token stays in this function.
  const { challenge } = await api<{ challenge: string }>("GET", `/v1/spl/challenge?pubkey=${owner}&cluster=${API_CLUSTER}`);
  const challengeSig = getBase58Decoder().decode(new Uint8Array(await signBytes(keyPair.privateKey, new TextEncoder().encode(challenge))));
  const { token } = await api<{ token: string }>("POST", "/v1/spl/login", { pubkey: owner, challenge, signature: challengeSig, cluster: API_CLUSTER });
  const privateBalance = async () => BigInt((await api<{ balance: string }>("GET", `/v1/spl/private-balance?address=${owner}&mint=${mint}&cluster=${API_CLUSTER}`, undefined, token)).balance);

  const before = await privateBalance();
  console.log(`${role.name} ${owner}`);
  console.log(`private balance before: ${Number(before) / Number(USDC)} USDC`);

  const built = await api<{ transactionBase64: string; sendTo: string; requiredSigners: string[]; lastValidBlockHeight: number }>("POST", "/v1/spl/deposit", {
    owner,
    cluster: API_CLUSTER,
    mint,
    amount: Number(amount),
    private: true,
    initVaultIfMissing: true,
    initAtasIfMissing: true,
    initIfMissing: true,
    idempotent: true,
  });
  if (built.sendTo !== "base") throw new Error(`the deposit build is routed to ${built.sendTo}; a vault deposit is a base-layer transaction`);
  const missing = built.requiredSigners.filter((s) => s !== owner);
  if (missing.length) throw new Error(`the deposit needs ${missing.length} signer(s) this script does not hold`);
  const signed = await partiallySignTransaction([keyPair], getTransactionDecoder().decode(getBase64Encoder().encode(built.transactionBase64)));
  if (Object.values(signed.signatures).some((s) => s === null)) throw new Error("the deposit still needs a signature after signing with the wallet key");
  const wire = getBase64EncodedWireTransaction(signed);
  const sig = getSignatureFromTransaction(signed);

  await rpc.sendTransaction(wire, { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3n }).send();
  for (;;) {
    const status = (await rpc.getSignatureStatuses([asSignature(sig)]).send()).value[0];
    if (status?.err) throw new Error(`deposit ${sig} failed on the base layer: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) break;
    if (Number(await rpc.getBlockHeight({ commitment: "confirmed" }).send()) > built.lastValidBlockHeight) throw new Error(`deposit ${sig} expired unconfirmed`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  console.log(`deposit ${usdc} USDC (private) landed: https://explorer.solana.com/tx/${sig}?cluster=devnet`);

  // The private balance follows the base confirmation after a short delay.
  let after = before;
  for (let i = 0; i < 30 && after < before + amount; i++) {
    await new Promise((r) => setTimeout(r, 2_000));
    after = await privateBalance();
  }
  console.log(`private balance after:  ${Number(after) / Number(USDC)} USDC`);
  if (after < before + amount) throw new Error("the private balance has not grown by the deposit yet; read it again in a minute before depositing more");
}

main().catch((error: unknown) => {
  console.error(`[fund:private] ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
});
