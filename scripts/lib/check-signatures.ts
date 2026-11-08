// Task 12.2: the pure half of `pnpm check:signatures`. Finds every Solana signature a
// markdown document names, decides which cluster each belongs to from the line it sits on,
// and resolves each through read-only JSON-RPC lookups: the devnet base layer first, then
// the TEE RPC for a signature that executed inside the rollup (the TEE answers existence and
// success for an ephemeral signature without a login, as the 31 Oct spike recorded), and the
// mainnet reader of `@wakeless/watcher/leak` for a signature the document marks as mainnet.
// Read methods only; no keypair; the RPC URL (it carries an API key) is never printed.
import { assertDevnetGenesisHash, assertDevnetRpcUrl, redactSecrets } from "@wakeless/watcher";
import { createMainnetReader, type MainnetReader } from "@wakeless/watcher/leak";

/** A Solana signature is 64 bytes: 86 to 88 base58 characters. */
const SIGNATURE = /\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g;

export type Cluster = "devnet" | "mainnet";

export interface FoundSignature {
  readonly signature: string;
  readonly cluster: Cluster;
  /** 1-based line of the first occurrence. */
  readonly line: number;
}

/**
 * Every distinct signature in `markdown`, in order of first appearance. A signature is
 * mainnet when the line that first names it contains the word "mainnet"; devnet otherwise.
 * A devnet signature on a line that mentions mainnet is therefore looked up on the wrong
 * cluster and reported missing, which is the loud failure wanted over a silent pass.
 */
export function extractSignatures(markdown: string): FoundSignature[] {
  const seen = new Map<string, FoundSignature>();
  markdown.split("\n").forEach((text, index) => {
    for (const match of text.matchAll(SIGNATURE)) {
      const signature = match[0];
      if (seen.has(signature)) continue;
      seen.set(signature, { signature, cluster: /mainnet/i.test(text) ? "mainnet" : "devnet", line: index + 1 });
    }
  });
  return [...seen.values()];
}

export type Where = "devnet base layer" | "devnet rollup" | "mainnet" | "missing";

export interface Resolution {
  readonly signature: string;
  readonly cluster: Cluster;
  readonly where: Where;
  readonly slot: number | null;
  /** The transaction's error as the RPC reports it; `null` when it succeeded. */
  readonly err: unknown;
}

interface RpcTransaction {
  readonly slot: number;
  readonly meta?: { readonly err?: unknown } | null;
}

/** A plain JSON-RPC `getTransaction`: `null` when the node does not know the signature. */
export async function fetchTransactionJson(rpcUrl: string, signature: string, fetchImpl: typeof fetch = fetch): Promise<RpcTransaction | null> {
  let response: Response;
  try {
    response = await fetchImpl(rpcUrl, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getTransaction", params: [signature, { encoding: "json", maxSupportedTransactionVersion: 1, commitment: "confirmed" }] }),
      signal: AbortSignal.timeout(30_000),
    });
  } catch (error) {
    throw new Error(`getTransaction failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`, { cause: error });
  }
  if (!response.ok) throw new Error(`getTransaction answered HTTP ${response.status}`);
  const body = (await response.json()) as { result?: RpcTransaction | null; error?: { message?: string } };
  if (body.error !== undefined) throw new Error(`getTransaction error: ${redactSecrets(body.error.message ?? "unknown")}`);
  return body.result ?? null;
}

async function fetchGenesisHash(rpcUrl: string, fetchImpl: typeof fetch): Promise<string> {
  const response = await fetchImpl(rpcUrl, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getGenesisHash", params: [] }),
    signal: AbortSignal.timeout(30_000),
  });
  if (!response.ok) throw new Error(`getGenesisHash answered HTTP ${response.status}`);
  const body = (await response.json()) as { result?: string };
  if (typeof body.result !== "string") throw new Error("getGenesisHash returned no hash");
  return body.result;
}

export interface ResolverOptions {
  /** Devnet base-layer RPC (Helius); asserted devnet by URL and by genesis hash. */
  readonly devnetRpcUrl: string;
  /** The attested TEE RPC; must be the devnet TEE host. */
  readonly teeRpcUrl: string;
  /** Built only when the document names a mainnet signature; read-only, no keypair. */
  readonly mainnetReader?: () => MainnetReader;
  readonly fetchImpl?: typeof fetch;
  /** Milliseconds between lookups, for the RPC's rate limit. */
  readonly paceMs?: number;
}

const TEE_HOST = "devnet-tee.magicblock.app";

/**
 * Resolves every signature. Devnet: the base layer, then the rollup. Mainnet: the leak
 * package's reader, the one read-only mainnet path the repository allows, and only when a
 * document actually names a mainnet signature; otherwise no mainnet URL is ever built.
 */
export async function resolveSignatures(found: readonly FoundSignature[], options: ResolverOptions): Promise<Resolution[]> {
  const fetchImpl = options.fetchImpl ?? fetch;
  assertDevnetRpcUrl(options.devnetRpcUrl);
  const teeHost = new URL(options.teeRpcUrl).hostname;
  if (teeHost !== TEE_HOST || !options.teeRpcUrl.startsWith("https://")) throw new Error(`refusing TEE RPC host ${teeHost}: expected https://${TEE_HOST}`);
  if (found.some((f) => f.cluster === "devnet")) assertDevnetGenesisHash(await fetchGenesisHash(options.devnetRpcUrl, fetchImpl));

  let mainnet: MainnetReader | undefined;
  const out: Resolution[] = [];
  for (const [index, f] of found.entries()) {
    if (index > 0 && options.paceMs) await new Promise((r) => setTimeout(r, options.paceMs));
    if (f.cluster === "mainnet") {
      if (options.mainnetReader === undefined) {
        out.push({ signature: f.signature, cluster: f.cluster, where: "missing", slot: null, err: "no mainnet reader configured (LEAK_RPC_URL or HELIUS_API_KEY)" });
        continue;
      }
      mainnet ??= options.mainnetReader();
      const raw = (await mainnet.fetchTransaction(f.signature as Parameters<MainnetReader["fetchTransaction"]>[0])) as RpcTransaction | null | undefined;
      out.push(raw ? { signature: f.signature, cluster: f.cluster, where: "mainnet", slot: raw.slot, err: raw.meta?.err ?? null } : { signature: f.signature, cluster: f.cluster, where: "missing", slot: null, err: null });
      continue;
    }
    const base = await fetchTransactionJson(options.devnetRpcUrl, f.signature, fetchImpl);
    if (base !== null) {
      out.push({ signature: f.signature, cluster: f.cluster, where: "devnet base layer", slot: base.slot, err: base.meta?.err ?? null });
      continue;
    }
    const rollup = await fetchTransactionJson(options.teeRpcUrl, f.signature, fetchImpl);
    out.push(rollup !== null ? { signature: f.signature, cluster: f.cluster, where: "devnet rollup", slot: rollup.slot, err: rollup.meta?.err ?? null } : { signature: f.signature, cluster: f.cluster, where: "missing", slot: null, err: null });
  }
  return out;
}

/** Builds the mainnet reader from the environment; the URL never leaves this function. */
export function mainnetReaderFromEnv(env: NodeJS.ProcessEnv): (() => MainnetReader) | undefined {
  const url = env.LEAK_RPC_URL || (env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${env.HELIUS_API_KEY}` : undefined);
  return url === undefined ? undefined : () => createMainnetReader(url);
}

export function shortSignature(signature: string): string {
  return `${signature.slice(0, 8)}…${signature.slice(-8)}`;
}

/** One line per signature, shortened: what a terminal and a log may hold. */
export function formatResolutions(resolutions: readonly Resolution[]): string {
  return resolutions
    .map((r) => {
      const where = r.where === "missing" ? `MISSING on ${r.cluster}${typeof r.err === "string" ? ` (${r.err})` : ""}` : `${r.where}, slot ${r.slot}${r.err === null || r.err === undefined ? "" : ", failed on chain"}`;
      return `${shortSignature(r.signature)}  ${where}`;
    })
    .join("\n");
}

export function missing(resolutions: readonly Resolution[]): Resolution[] {
  return resolutions.filter((r) => r.where === "missing");
}
