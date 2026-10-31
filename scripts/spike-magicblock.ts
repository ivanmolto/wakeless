// Task 1.2: MagicBlock spike on devnet. Deposit, private transfer buyer → escrow,
// private transfer escrow → vendor1, vendor1 private balance, vendor1 withdraw; then
// an observer pass over every base-layer signature through the Helius RPC.
//
// Writes docs/attestation-devnet.json and docs/spike-log.md. Never logs keys,
// bearer tokens or signatures of messages; the transaction signatures it records
// are public ledger data. If a step cannot be completed privately it stops and
// reports the call and the error; it never substitutes a public transfer.
//
// Base-layer transactions go to SOLANA_RPC_URL (Helius devnet) and are confirmed
// there; ephemeral ones go through the API's /v1/transaction/send to the TEE RPC.
// SPIKE_PRIOR_SIGNATURES (semicolon-separated `label:signature`, label optional) adds
// base-layer signatures from an earlier attempt or from setup to the record and the
// observer pass; SPIKE_PRIOR_EPHEMERAL_SIGNATURES does the same for the ephemeral layer.
// SPIKE_BUYER_DEPOSIT_SIGNATURE reuses an earlier attempt's buyer deposit (step 3a)
// instead of depositing again; SPIKE_BUYER_TRANSFER_SIGNATURE does the same for step 3b.
//
// Step 0 is onboarding: a private transfer inside the rollup is a plain SPL transfer
// between the two parties' ephemeral token accounts, and a recipient without one fails
// with InvalidAccountData (seen 31 Oct 2026). Each recipient creates its own account by
// depositing once, so the escrow and vendor1 each deposit 0.01 USDC first.
import { createHash } from "node:crypto";
import { readFileSync, writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { getAuthToken, verifyTeeRpcIntegrity } from "@magicblock-labs/ephemeral-rollups-kit";
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import {
  type Address,
  address,
  createKeyPairFromBytes,
  createSolanaRpc,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase64Encoder,
  getBase64EncodedWireTransaction,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  signBytes,
  signature as asSignature,
} from "@solana/kit";
import { assertDevnetGenesisHash, assertDevnetRpcUrl, DEVNET_CAIP2, redactSecrets } from "./lib/devnet.js";
import { loadDotEnv } from "./lib/env.js";
import { assertNotMainnetKeyPath } from "./lib/keypairs.js";

const root = resolve(import.meta.dirname, "..");
loadDotEnv(root);

const USDC = 1_000_000n; // 6 decimals
const DEPOSIT = 2n * USDC;
const ONBOARDING_DEPOSIT = USDC / 100n;
const BUYER_TO_ESCROW = 1n * USDC;
const ESCROW_TO_VENDOR = USDC / 2n;
const VENDOR_WITHDRAW = USDC / 4n;
const MEMO_PROGRAM_IDS = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);
const SETTLEMENT_WAIT_MS = 120_000;
const EXPLORER = (sig: string) => `https://explorer.solana.com/tx/${sig}?cluster=devnet`;

function requireEnv(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set: copy .env.example to .env and fill it in`);
  return value;
}

const rpcUrl = requireEnv("SOLANA_RPC_URL");
assertDevnetRpcUrl(rpcUrl);
const teeRpc = requireEnv("MAGICBLOCK_TEE_RPC").replace(/\/$/, "");
const paymentsApi = requireEnv("MAGICBLOCK_PAYMENTS_API").replace(/\/$/, "");
const mbCluster = requireEnv("MAGICBLOCK_CLUSTER");
if (mbCluster !== "devnet") throw new Error(`Refusing MAGICBLOCK_CLUSTER=${mbCluster}: the spike runs on devnet only`);
if (!/^https:\/\/devnet-tee\.magicblock\.app$/.test(teeRpc)) {
  throw new Error("Refusing MAGICBLOCK_TEE_RPC: the spike attests devnet-tee.magicblock.app only");
}
// The Private Payments API routes `devnet-private` to the TEE validator; plain `devnet`
// routes to the public devnet-as validator, which is not a Private Ephemeral Rollup.
const API_CLUSTER = "devnet-private";
const usdcMint = address(requireEnv("USDC_MINT"));

// ---------------------------------------------------------------------------- signers

/** `teeToken`: TEE RPC login via the kit's getAuthToken. `token`: the Payments API's own login; the API rejects TEE tokens (TOKEN_IDENTITY_MISMATCH). */
type Signer = { name: string; keyPair: Awaited<ReturnType<typeof createKeyPairFromBytes>>; address: Address; token?: string; teeToken?: string };

async function loadSigner(name: string, envVar: string): Promise<Signer> {
  const path = resolve(root, process.env[envVar] || `keys/${name}.json`);
  assertNotMainnetKeyPath(path);
  const bytes = Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
  const keyPair = await createKeyPairFromBytes(bytes);
  return { name, keyPair, address: await getAddressFromPublicKey(keyPair.publicKey) };
}

// ---------------------------------------------------------------------------- api

class ApiError extends Error {
  constructor(
    readonly call: string,
    readonly status: number,
    readonly body: unknown,
  ) {
    super(`${call} → HTTP ${status}: ${JSON.stringify(body)}`);
  }
}

async function api<T>(method: "GET" | "POST", path: string, body?: unknown, token?: string): Promise<T> {
  const headers: Record<string, string> = { accept: "application/json" };
  if (body !== undefined) headers["content-type"] = "application/json";
  if (token) headers.authorization = `Bearer ${token}`;
  const res = await fetch(`${paymentsApi}${path}`, {
    method,
    headers,
    body: body === undefined ? undefined : JSON.stringify(body),
  });
  const text = await res.text();
  let json: unknown;
  try {
    json = JSON.parse(text);
  } catch {
    json = { raw: text.slice(0, 500) };
  }
  if (!res.ok) throw new ApiError(`${method} ${path}`, res.status, json);
  return json as T;
}

type Built = {
  kind: string;
  version: "legacy" | "v0";
  transactionBase64: string;
  sendTo: "base" | "ephemeral";
  sendRpcEndpoint?: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  instructionCount: number;
  requiredSigners: string[];
  validator?: string;
  fees?: { lamports: string; tokens: string };
};

type Sent = {
  signature: string;
  sendTo: "base" | "ephemeral";
  confirmed: boolean;
  confirmationRpcEndpoint: string;
  confirmationRequiresAuthToken: boolean;
};

// ---------------------------------------------------------------------------- log

type Step = {
  step: string;
  role: string;
  call: string;
  request: Record<string, unknown>;
  layer?: "base" | "ephemeral";
  signature?: string;
  endpoint?: string;
  built?: Omit<Built, "transactionBase64">;
  result?: Record<string, unknown>;
  error?: string;
};

const steps: Step[] = [];
const startedAt = new Date();

function note(step: Step): void {
  steps.push(step);
  const where = step.signature ? `${step.layer} ${step.signature}` : (step.error ?? "ok");
  console.log(`[${step.step}] ${step.role} ${step.call} → ${where}`);
}

let baseRpc: ReturnType<typeof createSolanaRpc>;

/** Base layer: send to the Helius devnet RPC and poll until confirmed or the blockhash expires. */
async function sendBase(wire: string, signature: string, lastValidBlockHeight: number): Promise<Sent> {
  await baseRpc.sendTransaction(wire as Parameters<typeof baseRpc.sendTransaction>[0], { encoding: "base64", preflightCommitment: "confirmed", maxRetries: 3n }).send();
  for (;;) {
    const status = (await baseRpc.getSignatureStatuses([asSignature(signature)]).send()).value[0];
    if (status?.err) throw new Error(`base-layer transaction ${signature} failed: ${JSON.stringify(status.err)}`);
    if (status && (status.confirmationStatus === "confirmed" || status.confirmationStatus === "finalized")) break;
    const height = Number(await baseRpc.getBlockHeight({ commitment: "confirmed" }).send());
    if (height > lastValidBlockHeight) throw new Error(`base-layer transaction ${signature} expired unconfirmed (block height ${height} > ${lastValidBlockHeight})`);
    await new Promise((r) => setTimeout(r, 2_000));
  }
  return { signature, sendTo: "base", confirmed: true, confirmationRpcEndpoint: new URL(rpcUrl).origin, confirmationRequiresAuthToken: false };
}

/** JSON-RPC against the TEE RPC with a TEE login token (read methods only). */
async function teeRpcCall<T>(teeToken: string, method: string, params: unknown[]): Promise<T> {
  const res = await fetch(`${teeRpc}?token=${encodeURIComponent(teeToken)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }),
  });
  const json = (await res.json()) as { result?: T; error?: unknown };
  if (json.error) throw new Error(`TEE RPC ${method}: ${JSON.stringify(json.error)}`);
  return json.result as T;
}

/**
 * Ephemeral layer: submitted straight to the TEE RPC the build named in sendRpcEndpoint,
 * with the sender's TEE token, and read back from it. The API's /v1/transaction/send with
 * `confirm: true` was not reliable on 31 Oct 2026: it reported `confirmed` for a transaction
 * that failed with InvalidAccountData, and "expired: block height exceeded" for transactions
 * that had landed on both layers.
 */
async function sendEphemeral(wire: string, built: Built, sender: Signer): Promise<Sent> {
  const endpoint = built.sendRpcEndpoint ?? teeRpc;
  if (endpoint !== teeRpc) throw new Error(`build asks for ephemeral endpoint ${endpoint}; refusing anything but ${teeRpc}`);
  if (!sender.teeToken) throw new Error(`${sender.name} has no TEE token for the ephemeral submission`);
  const signature = await teeRpcCall<string>(sender.teeToken, "sendTransaction", [wire, { encoding: "base64", preflightCommitment: "confirmed" }]);
  for (let i = 0; i < 20; i++) {
    const tx = await teeRpcCall<{ meta?: { err: unknown; logMessages?: string[] } } | null>(sender.teeToken, "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
    if (tx) {
      if (tx.meta?.err) throw new Error(`ephemeral transaction ${signature} failed: ${JSON.stringify(tx.meta.err)}; logs: ${JSON.stringify(tx.meta.logMessages ?? [])}`);
      return { signature, sendTo: "ephemeral", confirmed: true, confirmationRpcEndpoint: endpoint, confirmationRequiresAuthToken: true };
    }
    await new Promise((r) => setTimeout(r, 1_000));
  }
  throw new Error(`ephemeral transaction ${signature} not found on the TEE RPC after 20 s`);
}

/** Signs every required signer we hold, refuses if one is missing, submits where sendTo says. */
async function signAndSend(step: string, role: string, call: string, request: Record<string, unknown>, built: Built, signers: Signer[]): Promise<Sent> {
  const missing = built.requiredSigners.filter((s) => !signers.some((k) => k.address === s));
  if (missing.length) throw new Error(`${call}: required signer not held: ${missing.join(", ")}`);
  const tx = getTransactionDecoder().decode(getBase64Encoder().encode(built.transactionBase64));
  const signed = await partiallySignTransaction(
    signers.map((s) => s.keyPair),
    tx,
  );
  const unsigned = Object.entries(signed.signatures).filter(([, sig]) => sig === null).map(([a]) => a);
  if (unsigned.length) throw new Error(`${call}: transaction still needs signatures from ${unsigned.join(", ")}`);
  const wire = getBase64EncodedWireTransaction(signed);
  const signature = getSignatureFromTransaction(signed) as string;
  const builtMeta: Omit<Built, "transactionBase64"> = { ...built };
  delete (builtMeta as Partial<Built>).transactionBase64;
  try {
    const sent = built.sendTo === "base" ? await sendBase(wire, signature, built.lastValidBlockHeight) : await sendEphemeral(wire, built, signers[0]!);
    note({
      step,
      role,
      call,
      request,
      layer: sent.sendTo,
      signature: sent.signature,
      endpoint: sent.confirmationRpcEndpoint,
      built: builtMeta,
      result: { confirmed: sent.confirmed, confirmationRequiresAuthToken: sent.confirmationRequiresAuthToken },
    });
    return sent;
  } catch (error) {
    note({ step, role, call, request, layer: built.sendTo, signature, built: builtMeta, error: describe(error) });
    throw error;
  }
}

function describe(error: unknown): string {
  return redactSecrets(error instanceof Error ? error.message : String(error));
}

// ---------------------------------------------------------------------------- attestation

async function attest(): Promise<Record<string, unknown>> {
  const file = resolve(root, "docs/attestation-devnet.json");
  const identity = await fetch(teeRpc, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getIdentity" }),
  })
    .then((r) => r.json() as Promise<{ result?: { identity?: string } }>)
    .then((j) => j.result?.identity ?? null)
    .catch(() => null);
  const base: Record<string, unknown> = {
    rpcUrl: teeRpc,
    host: new URL(teeRpc).hostname,
    validatorIdentity: identity,
    cluster: DEVNET_CAIP2,
    verifier: { package: "@magicblock-labs/ephemeral-rollups-kit", version: "0.17.3", method: "verifyTeeRpcIntegrity" },
    collateral: "https://pccs.phala.network/tdx/certification/v4",
    verifiedAt: new Date().toISOString(),
  };
  try {
    await verifyTeeRpcIntegrity(teeRpc);
  } catch (error) {
    const report = { verified: false, ...base, error: describe(error) };
    writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
    throw new Error(`Attestation of ${teeRpc} failed: ${describe(error)}`, { cause: error });
  }
  // The kit verifies and discards the quote; fetch one more for the record. It is a
  // TDX quote over a fresh challenge, public data, verified above by the same code path.
  const challenge = Buffer.from(crypto.getRandomValues(new Uint8Array(64))).toString("base64");
  const quoteRes = await fetch(`${teeRpc}/quote?challenge=${encodeURIComponent(challenge)}`);
  const quoteJson = (await quoteRes.json()) as { quote?: string };
  const quote = quoteJson.quote ?? null;
  const report = {
    verified: true,
    ...base,
    quoteChallengeBase64: challenge,
    quoteSha256: quote ? createHash("sha256").update(Buffer.from(quote, "base64")).digest("hex") : null,
    quoteBase64: quote,
  };
  writeFileSync(file, JSON.stringify(report, null, 2) + "\n");
  console.log(`[1] attestation verified: ${base.host} identity ${identity}`);
  return report;
}

// ---------------------------------------------------------------------------- observer

type Observed = {
  signature: string;
  slot?: number;
  blockTime?: number | null;
  err?: unknown;
  feePayer?: string;
  programIds: string[];
  signers: string[];
  accountKeys: string[];
  tokenAmounts: { program: string; type: string; amount: string; source?: string; destination?: string; authority?: string }[];
  tokenBalanceDeltas: { account: string; owner?: string; mint?: string; delta: string }[];
  recipients: string[];
  memo: string[];
  feeTransfers: { from: string; to: string; lamports: string }[];
  lamportFee?: number;
  error?: string;
};

type ParsedIx = { programId: string; program?: string; parsed?: { type?: string; info?: Record<string, unknown> }; data?: string; accounts?: string[] };

async function observe(rpc: ReturnType<typeof createSolanaRpc>, sig: string): Promise<Observed> {
  const out: Observed = { signature: sig, programIds: [], signers: [], accountKeys: [], tokenAmounts: [], tokenBalanceDeltas: [], recipients: [], memo: [], feeTransfers: [] };
  let tx;
  try {
    // Version 1 transactions (SIMD-0385) exist on devnet; kit 8 types still say 0.
    tx = await rpc.getTransaction(asSignature(sig), { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 as unknown as 0, commitment: "confirmed" }).send();
  } catch (error) {
    out.error = describe(error);
    return out;
  }
  if (!tx) {
    out.error = "not found on the base layer";
    return out;
  }
  out.slot = Number(tx.slot);
  out.blockTime = tx.blockTime === null ? null : Number(tx.blockTime);
  out.err = tx.meta?.err ?? null;
  out.lamportFee = tx.meta ? Number(tx.meta.fee) : undefined;
  const msg = tx.transaction.message as unknown as { accountKeys: { pubkey: string; signer: boolean }[]; instructions: ParsedIx[] };
  out.accountKeys = msg.accountKeys.map((k) => k.pubkey);
  out.signers = msg.accountKeys.filter((k) => k.signer).map((k) => k.pubkey);
  out.feePayer = msg.accountKeys[0]?.pubkey;
  const inner = ((tx.meta?.innerInstructions ?? []) as unknown as { instructions: ParsedIx[] }[]).flatMap((i) => i.instructions);
  const all = [...msg.instructions, ...inner];
  for (const ix of all) {
    if (!out.programIds.includes(ix.programId)) out.programIds.push(ix.programId);
    if (MEMO_PROGRAM_IDS.has(ix.programId)) out.memo.push(typeof ix.parsed === "string" ? ix.parsed : JSON.stringify(ix.parsed ?? ix.data));
    const info = ix.parsed?.info ?? {};
    const type = ix.parsed?.type ?? "";
    if (ix.program === "spl-token" && /^transfer/.test(type)) {
      const amount = (info.amount as string | undefined) ?? (info.tokenAmount as { amount?: string } | undefined)?.amount ?? "?";
      out.tokenAmounts.push({ program: ix.program, type, amount, source: info.source as string, destination: info.destination as string, authority: info.authority as string });
      if (info.destination) out.recipients.push(info.destination as string);
    }
    if (ix.program === "system" && type === "transfer") {
      out.feeTransfers.push({ from: info.source as string, to: info.destination as string, lamports: String(info.lamports) });
    }
  }
  type TokenBalance = { accountIndex: number; mint: string; owner?: string; uiTokenAmount: { amount: string } };
  const pre = (tx.meta?.preTokenBalances ?? []) as unknown as readonly TokenBalance[];
  const post = (tx.meta?.postTokenBalances ?? []) as unknown as readonly TokenBalance[];
  for (const p of post) {
    const before = pre.find((q) => q.accountIndex === p.accountIndex)?.uiTokenAmount.amount ?? "0";
    const delta = BigInt(p.uiTokenAmount.amount) - BigInt(before);
    if (delta !== 0n) {
      out.tokenBalanceDeltas.push({ account: out.accountKeys[p.accountIndex] ?? String(p.accountIndex), owner: p.owner, mint: p.mint, delta: delta.toString() });
      if (delta > 0n && out.accountKeys[p.accountIndex]) out.recipients.push(out.accountKeys[p.accountIndex]!);
    }
  }
  out.recipients = [...new Set(out.recipients)];
  return out;
}

/** What each party's TEE login can read back about an ephemeral transaction. */
type EphemeralView = { reader: string; found: boolean; err?: unknown; logMessages?: number; accountKeys?: string[]; tokenBalances?: unknown; error?: string };

async function observeEphemeral(sig: string, readers: Signer[]): Promise<EphemeralView[]> {
  const views: EphemeralView[] = [];
  for (const r of readers) {
    if (!r.teeToken) continue;
    try {
      const tx = await teeRpcCall<{ meta?: { err: unknown; logMessages?: string[]; postTokenBalances?: unknown[] }; transaction?: { message?: { accountKeys?: ({ pubkey: string } | string)[] } } } | null>(r.teeToken, "getTransaction", [sig, { encoding: "jsonParsed", commitment: "confirmed", maxSupportedTransactionVersion: 0 }]);
      if (!tx) {
        views.push({ reader: r.name, found: false });
        continue;
      }
      views.push({
        reader: r.name,
        found: true,
        err: tx.meta?.err ?? null,
        logMessages: tx.meta?.logMessages?.length ?? 0,
        accountKeys: (tx.transaction?.message?.accountKeys ?? []).map((k) => (typeof k === "string" ? k : k.pubkey)),
        tokenBalances: tx.meta?.postTokenBalances ?? [],
      });
    } catch (error) {
      views.push({ reader: r.name, found: false, error: describe(error) });
    }
  }
  return views;
}

// ---------------------------------------------------------------------------- main

async function main(): Promise<void> {
  const rpc = createSolanaRpc(rpcUrl);
  baseRpc = rpc;
  assertDevnetGenesisHash(await rpc.getGenesisHash().send());
  console.log(`cluster ${DEVNET_CAIP2} · api ${paymentsApi} (cluster=${API_CLUSTER}) · tee ${teeRpc}`);

  const buyer = await loadSigner("buyer", "BUYER_KEYPAIR");
  const escrow = await loadSigner("escrow", "ESCROW_KEYPAIR");
  const vendor1 = await loadSigner("vendor1", "VENDOR1_KEYPAIR");
  const ata = async (owner: Address) => (await findAssociatedTokenPda({ owner, mint: usdcMint, tokenProgram: TOKEN_PROGRAM_ADDRESS }))[0];
  const vendor1Ata = await ata(vendor1.address);
  const escrowAta = await ata(escrow.address);
  const buyerAta = await ata(buyer.address);
  console.log(`buyer ${buyer.address}\nescrow ${escrow.address}\nvendor1 ${vendor1.address} (base ATA ${vendor1Ata})`);

  // (1) attestation. Fails → stop; nothing else runs.
  const attestation = await attest();

  // (2) auth tokens. getAuthToken logs in at the TEE RPC (escrow and vendor1, as the prompt
  // says). The Payments API does not accept that token for the same wallet
  // (TOKEN_IDENTITY_MISMATCH), so every wallet that calls the API also runs the API's own
  // challenge/login; the buyer only needs the latter.
  const signMessage = (s: Signer) => (message: Uint8Array) => signBytes(s.keyPair.privateKey, message).then((sig) => new Uint8Array(sig));
  const teeLogin = async (s: Signer) => {
    const { token, expiresAt } = await getAuthToken(teeRpc, s.address as unknown as Parameters<typeof getAuthToken>[1], signMessage(s));
    s.teeToken = token;
    note({ step: "2", role: s.name, call: `getAuthToken ${new URL(teeRpc).hostname}`, request: { pubkey: s.address }, result: { token: "<redacted>", expiresAt: new Date(expiresAt).toISOString() } });
  };
  const apiLogin = async (s: Signer) => {
    const { challenge } = await api<{ challenge: string }>("GET", `/v1/spl/challenge?pubkey=${s.address}&cluster=${API_CLUSTER}`);
    const sig = getBase58Decoder().decode(await signMessage(s)(new TextEncoder().encode(challenge)));
    const { token } = await api<{ token: string }>("POST", "/v1/spl/login", { pubkey: s.address, challenge, signature: sig, cluster: API_CLUSTER });
    s.token = token;
    note({ step: "2", role: s.name, call: "GET /v1/spl/challenge + POST /v1/spl/login", request: { pubkey: s.address, challengePrefix: challenge.split("\n")[0] }, result: { token: "<redacted>" } });
  };
  await teeLogin(escrow);
  await teeLogin(vendor1);
  await teeLogin(buyer); // reads back the buyer's own ephemeral transaction
  for (const s of [buyer, escrow, vendor1]) await apiLogin(s);

  const prior = (envVar: string) =>
    (process.env[envVar] ?? "")
      .split(";")
      .map((s) => s.trim())
      .filter(Boolean)
      .map((entry) => {
        const i = entry.lastIndexOf(":");
        return i === -1 ? { label: "earlier attempt", signature: entry } : { label: entry.slice(0, i), signature: entry.slice(i + 1) };
      });
  const baseSignatures = prior("SPIKE_PRIOR_SIGNATURES");
  const ephemeralSignatures = prior("SPIKE_PRIOR_EPHEMERAL_SIGNATURES");
  const track = (label: string, sent: Sent) => (sent.sendTo === "base" ? baseSignatures : ephemeralSignatures).push({ label, signature: sent.signature });

  const privateBalance = async (s: Signer) =>
    api<{ address: string; mint: string; ata: string; location: string; balance: string } & Record<string, unknown>>("GET", `/v1/spl/private-balance?address=${s.address}&mint=${usdcMint}&cluster=${API_CLUSTER}`, undefined, s.token);

  // (0) onboarding deposits: escrow and vendor1 each create their own ephemeral token account.
  for (const s of [escrow, vendor1]) {
    const before = await privateBalance(s);
    if ((before.delegation as { status?: string } | undefined)?.status === "delegated") {
      note({ step: "0", role: s.name, call: "GET /v1/spl/private-balance", request: { address: s.address }, result: { ...before, onboarding: "already delegated; no onboarding deposit" } });
      continue;
    }
    const req = { owner: s.address, cluster: API_CLUSTER, mint: usdcMint, amount: Number(ONBOARDING_DEPOSIT), private: true, initVaultIfMissing: true, initAtasIfMissing: true, initIfMissing: true, idempotent: true };
    const built = await api<Built>("POST", "/v1/spl/deposit", req);
    track(`${s.name} onboarding deposit 0.01 USDC (private)`, await signAndSend("0", s.name, "POST /v1/spl/deposit", req, built, [s]));
    const after = await privateBalance(s);
    note({ step: "0", role: s.name, call: "GET /v1/spl/private-balance", request: { address: s.address }, result: after });
  }

  // (3) buyer deposit (base), then buyer → escrow private transfer (ephemeral).
  const depositReq = { owner: buyer.address, cluster: API_CLUSTER, mint: usdcMint, amount: Number(DEPOSIT), private: true, initVaultIfMissing: true, initAtasIfMissing: true, initIfMissing: true, idempotent: true };
  if (process.env.SPIKE_BUYER_DEPOSIT_SIGNATURE) {
    const signature = process.env.SPIKE_BUYER_DEPOSIT_SIGNATURE;
    note({ step: "3a", role: "buyer", call: "POST /v1/spl/deposit", request: depositReq, layer: "base", signature, result: { reused: "landed in an earlier attempt of this run; not repeated" } });
    baseSignatures.push({ label: "buyer deposit 2 USDC (private)", signature });
  } else {
    const deposit = await api<Built>("POST", "/v1/spl/deposit", depositReq);
    track("buyer deposit 2 USDC (private)", await signAndSend("3a", "buyer", "POST /v1/spl/deposit", depositReq, deposit, [buyer]));
  }

  const buyerTransferReq = { from: buyer.address, to: escrow.address, cluster: API_CLUSTER, mint: usdcMint, amount: Number(BUYER_TO_ESCROW), visibility: "private", fromBalance: "ephemeral", toBalance: "ephemeral", clientRefId: "1001", initAtasIfMissing: true };
  if (process.env.SPIKE_BUYER_TRANSFER_SIGNATURE) {
    const signature = process.env.SPIKE_BUYER_TRANSFER_SIGNATURE;
    note({ step: "3b", role: "buyer", call: "POST /v1/spl/transfer", request: buyerTransferReq, layer: "ephemeral", signature, result: { reused: "landed in an earlier attempt of this run; not repeated" } });
    ephemeralSignatures.push({ label: "buyer → escrow 1 USDC private, ref 1001", signature });
  } else {
    const buyerTransfer = await api<Built>("POST", "/v1/spl/transfer", buyerTransferReq, buyer.token);
    track("buyer → escrow 1 USDC private, ref 1001", await signAndSend("3b", "buyer", "POST /v1/spl/transfer", buyerTransferReq, buyerTransfer, [buyer]));
  }

  const escrowBefore = await privateBalance(escrow);
  note({ step: "3c", role: "escrow", call: "GET /v1/spl/private-balance", request: { address: escrow.address }, result: escrowBefore });

  // (4) escrow → vendor1 private transfer. toBalance "ephemeral": the briefing (§3 flow step 3,
  // §5 table) credits the vendor's private balance and the vendor withdraws when it chooses;
  // steps 5 and 6 read and withdraw that balance.
  const escrowTransferReq = { from: escrow.address, to: vendor1.address, cluster: API_CLUSTER, mint: usdcMint, amount: Number(ESCROW_TO_VENDOR), visibility: "private", fromBalance: "ephemeral", toBalance: "ephemeral", clientRefId: "2001", minDelayMs: "5000", maxDelayMs: "30000", split: 1, gasless: false, initAtasIfMissing: true };
  const escrowTransfer = await api<Built>("POST", "/v1/spl/transfer", escrowTransferReq, escrow.token);
  const step4 = await signAndSend("4", "escrow", "POST /v1/spl/transfer", escrowTransferReq, escrowTransfer, [escrow]);
  track("escrow → vendor1 0.5 USDC private, ref 2001, delay 5–30 s", step4);

  // (5) vendor1 private balance: poll until the queued transfer settles.
  const deadline = Date.now() + SETTLEMENT_WAIT_MS;
  let vendorBalance = await privateBalance(vendor1);
  while (BigInt(vendorBalance.balance) < ESCROW_TO_VENDOR && Date.now() < deadline) {
    await new Promise((r) => setTimeout(r, 5_000));
    vendorBalance = await privateBalance(vendor1);
  }
  const refLike = JSON.stringify(vendorBalance).match(/ref|memo|2001/gi) ?? [];
  note({ step: "5", role: "vendor1", call: "GET /v1/spl/private-balance", request: { address: vendor1.address }, result: { ...vendorBalance, referenceIdsVisible: refLike.length ? `fields matching ref/memo/2001: ${refLike.join(",")}` : "none: no clientRefId, memo or sender appears in the response" } });
  const escrowAfter = await privateBalance(escrow);
  note({ step: "5b", role: "escrow", call: "GET /v1/spl/private-balance", request: { address: escrow.address }, result: escrowAfter });
  if (BigInt(vendorBalance.balance) < ESCROW_TO_VENDOR) {
    note({ step: "5", role: "vendor1", call: "settlement", request: {}, error: `vendor1 private balance is ${vendorBalance.balance} after ${SETTLEMENT_WAIT_MS / 1000} s; the queued transfer has not settled` });
  }

  // (6) vendor1 withdraw 0.25 USDC to its base ATA.
  const withdrawReq = { owner: vendor1.address, cluster: API_CLUSTER, mint: usdcMint, amount: Number(VENDOR_WITHDRAW), initAtasIfMissing: true, idempotent: true };
  let withdrawSent: Sent | undefined;
  try {
    const withdraw = await api<Built>("POST", "/v1/spl/withdraw", withdrawReq, vendor1.token);
    withdrawSent = await signAndSend("6", "vendor1", "POST /v1/spl/withdraw", withdrawReq, withdraw, [vendor1]);
    track("vendor1 withdraw 0.25 USDC to base ATA", withdrawSent);
  } catch (error) {
    if (error instanceof ApiError) note({ step: "6", role: "vendor1", call: "POST /v1/spl/withdraw", request: withdrawReq, error: describe(error) });
    else throw error;
  }

  // The withdraw instruction only requests the release; the vault pays the base ATA in a
  // later transaction cranked by the validator. Wait for it so the observer pass sees it.
  const baseBalance = async (ata: Address) => BigInt((await rpc.getTokenAccountBalance(ata).send()).value.amount);
  const vendorBaseBefore = await baseBalance(vendor1Ata).catch(() => 0n);
  let vendorBaseAfter = vendorBaseBefore;
  if (withdrawSent) {
    const until = Date.now() + SETTLEMENT_WAIT_MS;
    while (Date.now() < until) {
      vendorBaseAfter = await baseBalance(vendor1Ata).catch(() => vendorBaseBefore);
      if (vendorBaseAfter >= vendorBaseBefore + VENDOR_WITHDRAW) break;
      await new Promise((r) => setTimeout(r, 5_000));
    }
    note({ step: "6b", role: "observer", call: "getTokenAccountBalance vendor1 base ATA", request: { ata: vendor1Ata }, result: { before: vendorBaseBefore.toString(), after: vendorBaseAfter.toString(), arrived: vendorBaseAfter >= vendorBaseBefore + VENDOR_WITHDRAW } });
  }

  // What each party can read back about the two ephemeral transactions through the TEE RPC.
  const ephemeralViews: { label: string; signature: string; views: EphemeralView[] }[] = [];
  for (const e of ephemeralSignatures) ephemeralViews.push({ ...e, views: await observeEphemeral(e.signature, [buyer, escrow, vendor1]) });

  // Observer pass. Every base-layer signature we produced, plus every base-layer signature
  // that touched the accounts an observer would watch during the run: the escrow and
  // vendor1 wallets and their base ATAs, and the buyer's base ATA. Anything the validator
  // committed or cranked for the private transfer would show here.
  await new Promise((r) => setTimeout(r, 10_000));
  const since = Math.floor(startedAt.getTime() / 1000) - 5;
  const watched: Record<string, Address> = { "escrow wallet": escrow.address, "escrow base ATA": escrowAta, "vendor1 wallet": vendor1.address, "vendor1 base ATA": vendor1Ata, "buyer base ATA": buyerAta };
  const seenDuringRun: { label: string; signature: string }[] = [];
  for (const [label, addr] of Object.entries(watched)) {
    const sigs = await rpc.getSignaturesForAddress(addr, { limit: 50, commitment: "confirmed" }).send();
    for (const s of sigs) {
      if (s.blockTime !== null && Number(s.blockTime) >= since && !seenDuringRun.some((x) => x.signature === s.signature)) {
        seenDuringRun.push({ label: `touched ${label}`, signature: s.signature });
      }
    }
  }
  const toObserve = [...baseSignatures];
  for (const s of seenDuringRun) if (!toObserve.some((x) => x.signature === s.signature)) toObserve.push(s);
  const observed: (Observed & { label: string })[] = [];
  for (const { label, signature } of toObserve) observed.push({ label, ...(await observe(rpc, signature)) });

  writeLog({ attestation, buyer, escrow, vendor1, vendor1Ata, escrowAta, baseSignatures, ephemeralSignatures, ephemeralViews, observed, step4Signature: step4.signature, vendorBalance });
}

type LogInput = {
  attestation: Record<string, unknown>;
  buyer: Signer;
  escrow: Signer;
  vendor1: Signer;
  vendor1Ata: Address;
  escrowAta: Address;
  baseSignatures: { label: string; signature: string }[];
  ephemeralSignatures: { label: string; signature: string }[];
  ephemeralViews: { label: string; signature: string; views: EphemeralView[] }[];
  observed: (Observed & { label: string })[];
  step4Signature: string;
  vendorBalance: { balance: string };
};

function writeLog(x: LogInput): void {
  const lines: string[] = [];
  lines.push("# MagicBlock spike log (task 1.2)", "");
  lines.push(`Run started ${startedAt.toISOString()} on devnet (\`${DEVNET_CAIP2}\`). Private Payments API \`${paymentsApi}\` with \`cluster: "${API_CLUSTER}"\`; TEE RPC \`${teeRpc}\` (validator identity \`${String(x.attestation.validatorIdentity)}\`), attestation in \`docs/attestation-devnet.json\` (verified: ${String(x.attestation.verified)}).`, "");
  lines.push("Wallets: buyer `" + x.buyer.address + "`, escrow `" + x.escrow.address + "` (base ATA `" + x.escrowAta + "`), vendor1 `" + x.vendor1.address + "` (base ATA `" + x.vendor1Ata + "`).", "");
  lines.push("## Steps", "");
  lines.push("| Step | Role | Call | Layer | Signature | Result |", "| --- | --- | --- | --- | --- | --- |");
  for (const s of steps) {
    const sig = s.signature ? (s.layer === "base" ? `[${s.signature}](${EXPLORER(s.signature)})` : `\`${s.signature}\``) : "";
    const result = s.error ? `ERROR: ${s.error}` : s.result ? JSON.stringify(s.result) : "ok";
    lines.push(`| ${s.step} | ${s.role} | \`${s.call}\` | ${s.layer ?? ""} | ${sig} | ${result.replace(/\|/g, "\\|")} |`);
  }
  lines.push("", "Ephemeral signatures are executed inside the TEE validator and are not on the public ledger; no public explorer shows them. Base signatures link to the Solana explorer on devnet.", "");
  lines.push("## Signatures", "", "Machine-readable, one per line: `layer label signature`.", "", "```");
  for (const s of x.baseSignatures) lines.push(`base ${s.label} ${s.signature}`);
  for (const s of x.ephemeralSignatures) lines.push(`ephemeral ${s.label} ${s.signature}`);
  lines.push("```", "");
  lines.push(`The escrow → vendor1 private transfer (step 4) was submitted to the ephemeral layer with signature \`${x.step4Signature}\`. ${x.baseSignatures.some((s) => s.label.startsWith("escrow → vendor1")) ? "A base-layer signature was produced for it; see below." : "It produced no base-layer signature of its own."}`, "");
  lines.push("## Ephemeral transactions as read through the TEE RPC", "", "Each ephemeral signature fetched with `getTransaction` (jsonParsed) using the TEE login of the buyer, the escrow and vendor1 in turn.", "");
  for (const e of x.ephemeralViews) {
    lines.push(`### ${e.label}`, "", `Signature \`${e.signature}\``, "");
    for (const v of e.views) {
      if (!v.found) lines.push(`- ${v.reader}: not returned${v.error ? ` (${v.error})` : ""}`);
      else lines.push(`- ${v.reader}: found, err ${JSON.stringify(v.err)}, ${v.logMessages} log lines, account keys ${v.accountKeys?.length ? v.accountKeys.map((k) => `\`${k}\``).join(", ") : "none"}, token balances ${JSON.stringify(v.tokenBalances)}`);
    }
    lines.push("");
  }
  lines.push("## Observer notes (Helius RPC, base layer)", "");
  lines.push("Every base-layer signature produced by the run, plus every base-layer signature in the run's window that touched the escrow wallet, the vendor1 wallet, their base ATAs or the buyer's base ATA.", "");
  const vendorKeys = new Set([x.vendor1.address as string, x.vendor1Ata as string]);
  for (const o of x.observed) {
    lines.push(`### ${o.label}`, "", `Signature [${o.signature}](${EXPLORER(o.signature)})${o.slot ? `, slot ${o.slot}` : ""}${o.blockTime ? `, ${new Date(o.blockTime * 1000).toISOString()}` : ""}${o.err ? `, err ${JSON.stringify(o.err)}` : ""}`, "");
    if (o.error) {
      lines.push(`- Error: ${o.error}`, "");
      continue;
    }
    lines.push(`- Program ids: ${o.programIds.map((p) => `\`${p}\``).join(", ") || "none"}`);
    lines.push(`- Signers: ${o.signers.map((p) => `\`${p}\``).join(", ")}; fee payer \`${o.feePayer}\`, fee ${o.lamportFee} lamports`);
    lines.push(`- Token amounts (parsed spl-token transfers): ${o.tokenAmounts.length ? o.tokenAmounts.map((t) => `${t.type} ${t.amount} from \`${t.source}\` to \`${t.destination}\` by \`${t.authority}\``).join("; ") : "none"}`);
    lines.push(`- Token balance deltas: ${o.tokenBalanceDeltas.length ? o.tokenBalanceDeltas.map((d) => `\`${d.account}\` (owner \`${d.owner}\`) ${d.delta}`).join("; ") : "none"}`);
    lines.push(`- Recipients: ${o.recipients.length ? o.recipients.map((r) => `\`${r}\``).join(", ") : "none"}`);
    lines.push(`- Memo instruction: ${o.memo.length ? o.memo.join("; ") : "none"}`);
    lines.push(`- Fee transfers (system transfer instructions): ${o.feeTransfers.length ? o.feeTransfers.map((f) => `${f.lamports} lamports \`${f.from}\` → \`${f.to}\``).join("; ") : "none"}`);
    const namesVendor = o.accountKeys.filter((k) => vendorKeys.has(k));
    const namesAmount = o.tokenAmounts.some((t) => t.amount === ESCROW_TO_VENDOR.toString()) || o.tokenBalanceDeltas.some((d) => d.delta.replace("-", "") === ESCROW_TO_VENDOR.toString());
    lines.push(`- Names vendor1 (wallet or base ATA): ${namesVendor.length ? namesVendor.map((k) => `\`${k}\``).join(", ") : "no"}; carries the 0.5 USDC amount (500000): ${namesAmount ? "yes" : "no"}`, "");
  }
  lines.push("## Summary for Gate R", "");
  const step4Base = x.observed.filter((o) => o.label.startsWith("escrow → vendor1"));
  const isSetup = (o: Observed & { label: string }) => /^setup/.test(o.label);
  const signedByVendor = (o: Observed) => o.signers.includes(x.vendor1.address as string);
  const vendorNamedByOthers = x.observed.filter((o) => !isSetup(o) && !signedByVendor(o) && o.accountKeys.some((k) => vendorKeys.has(k)));
  const amountSeen = x.observed.filter((o) => !isSetup(o) && (o.tokenAmounts.some((t) => t.amount === ESCROW_TO_VENDOR.toString()) || o.tokenBalanceDeltas.some((d) => d.delta.replace("-", "") === ESCROW_TO_VENDOR.toString())));
  const escrowAndVendor = x.observed.filter((o) => o.accountKeys.some((k) => vendorKeys.has(k)) && o.accountKeys.some((k) => k === x.escrow.address || k === x.escrowAta));
  lines.push(`- Step 4 base-layer signatures: ${step4Base.length === 0 ? "none" : step4Base.map((o) => o.signature).join(", ")}.`);
  lines.push(`- Base-layer transactions in the window that name vendor1 without vendor1 signing them (setup excluded): ${vendorNamedByOthers.length === 0 ? "none" : vendorNamedByOthers.map((o) => `${o.label} ${o.signature}`).join("; ")}.`);
  lines.push(`- Base-layer transactions in the window that name both the escrow and vendor1: ${escrowAndVendor.length === 0 ? "none" : escrowAndVendor.map((o) => `${o.label} ${o.signature}`).join("; ")}.`);
  lines.push(`- Base-layer transactions in the window carrying the 0.5 USDC amount (setup excluded): ${amountSeen.length === 0 ? "none" : amountSeen.map((o) => `${o.label} ${o.signature}`).join("; ")}.`);
  lines.push(`- Transactions signed by vendor1 itself (its onboarding deposit and its withdrawal) name vendor1 by construction; they show the vault as counterparty, not the escrow.`);
  lines.push(`- vendor1 private balance after settlement: ${x.vendorBalance.balance} base units.`);
  lines.push("");
  const file = resolve(root, "docs/spike-log.md");
  writeFileSync(file, lines.join("\n"));
  console.log(`wrote ${file}`);
}

main().then(
  () => {
    process.exitCode = 0;
  },
  (error: unknown) => {
    console.error(`STOP: ${describe(error)}`);
    if (steps.length) {
      // Keep whatever was recorded so the failure is reproducible.
      const file = resolve(root, "docs/spike-log.md");
      const lines = ["# MagicBlock spike log (task 1.2) — stopped", "", `Run started ${startedAt.toISOString()}. Stopped: ${describe(error)}`, "", "| Step | Role | Call | Layer | Signature | Result |", "| --- | --- | --- | --- | --- | --- |"];
      for (const s of steps) lines.push(`| ${s.step} | ${s.role} | \`${s.call}\` | ${s.layer ?? ""} | ${s.signature ?? ""} | ${s.error ? `ERROR: ${s.error}` : s.result ? JSON.stringify(s.result) : "ok"} |`);
      lines.push("", "```");
      for (const s of steps) if (s.signature) lines.push(`${s.layer} ${s.role} step ${s.step} ${s.signature}`);
      lines.push("```", "");
      writeFileSync(file, lines.join("\n"));
    }
    process.exitCode = 1;
  },
);
