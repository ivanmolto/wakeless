// The leakage indexer's read of mainnet: plain JSON-RPC over `fetch`, two read methods
// (`getSignaturesForAddress`, `getTransaction`), nothing else. This is the one code path
// CLAUDE.md lets read mainnet without the mainnet flags: it loads no keypair, imports no
// signing helper, and spends nothing. The URL carries an API key, so no error message
// quotes it. Rate limits (HTTP 429, JSON-RPC -32429) are retried with backoff.
import type { Signature } from "@solana/kit";

export interface SignatureInfo {
  readonly signature: Signature;
  readonly slot: number;
  readonly blockTime: number | null;
  readonly err: unknown;
}

export interface MainnetReader {
  /** The host the reader talks to, for the snapshot; never the full URL. */
  readonly host: string;
  listSignatures(address: string, options: { readonly before?: Signature; readonly limit: number }): Promise<SignatureInfo[]>;
  /** The raw `getTransaction` result (`jsonParsed`), or null when the signature is not on the ledger. */
  fetchTransaction(signature: Signature): Promise<unknown>;
}

export const MAINNET_HOST_PATTERN = /mainnet/i;
const NOT_MAINNET = /devnet|testnet|localhost|127\.0\.0\.1/i;

/** RPC URLs carry API keys; anything printed from an RPC error goes through this. */
export function redactSecrets(message: string): string {
  return message.replace(/(api[-_]?key=)[^&\s"']+/gi, "$1[redacted]");
}

/** Refuses before any RPC call: the indexer reads mainnet and nothing else; the message never contains the URL. */
export function assertMainnetRpcUrl(url: string): string {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error("the RPC URL is not a valid URL");
  }
  if (!MAINNET_HOST_PATTERN.test(hostname) || NOT_MAINNET.test(hostname)) throw new Error("refusing a non-mainnet RPC URL: the leakage indexer reads the mainnet payment-channels program");
  return hostname;
}

interface JsonRpcResponse {
  readonly result?: unknown;
  readonly error?: { readonly code?: number; readonly message?: string };
}

export interface ReaderOptions {
  readonly fetch?: typeof fetch;
  readonly retries?: number;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Requests started per second across every caller, so the provider's limit is met instead of hit (default 5; 0 for none). */
  readonly requestsPerSecond?: number;
  readonly now?: () => number;
}

const defaultSleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

export function createMainnetReader(rpcUrl: string, options: ReaderOptions = {}): MainnetReader {
  const host = assertMainnetRpcUrl(rpcUrl);
  const doFetch = options.fetch ?? fetch;
  const retries = options.retries ?? 12;
  const sleep = options.sleep ?? defaultSleep;
  const now = options.now ?? Date.now;
  const rps = options.requestsPerSecond ?? 5;
  const interval = rps > 0 ? 1000 / rps : 0;
  let nextStart = 0;

  /** Spaces request starts `interval` apart, in call order, whatever the concurrency. */
  async function pace(): Promise<void> {
    if (interval === 0) return;
    const t = now();
    const start = Math.max(t, nextStart);
    nextStart = start + interval;
    if (start > t) await sleep(start - t);
  }

  /** A rate limit holds every caller back, not only the one it answered. */
  function holdAll(ms: number): void {
    nextStart = Math.max(nextStart, now() + ms);
  }

  function backoff(attempt: number): number {
    return Math.min(30_000, 500 * 2 ** attempt);
  }

  async function call(method: string, params: unknown[]): Promise<unknown> {
    let attempt = 0;
    for (;;) {
      await pace();
      let response: Response;
      try {
        response = await doFetch(rpcUrl, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      } catch (error) {
        if (attempt++ >= retries) throw new Error(`${method} failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`, { cause: error });
        await sleep(backoff(attempt));
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        if (attempt++ >= retries) throw new Error(`${method} failed: HTTP ${response.status} after ${retries} retries`);
        const retryAfter = Number(response.headers.get("retry-after"));
        const wait = Number.isFinite(retryAfter) && retryAfter > 0 ? retryAfter * 1000 : backoff(attempt);
        if (response.status === 429) holdAll(wait);
        await sleep(wait);
        continue;
      }
      if (!response.ok) throw new Error(`${method} failed: HTTP ${response.status}`);
      const json = (await response.json()) as JsonRpcResponse;
      if (json.error !== undefined) {
        const code = json.error.code ?? 0;
        if ((code === -32429 || code === 429) && attempt++ < retries) {
          holdAll(backoff(attempt));
          await sleep(backoff(attempt));
          continue;
        }
        throw new Error(`${method} failed: RPC error ${code} ${redactSecrets(json.error.message ?? "")}`);
      }
      return json.result;
    }
  }

  return {
    host,
    async listSignatures(address, { before, limit }) {
      const result = await call("getSignaturesForAddress", [address, { limit, commitment: "confirmed", ...(before === undefined ? {} : { before }) }]);
      if (!Array.isArray(result)) throw new Error("getSignaturesForAddress returned no array");
      return result.map((entry): SignatureInfo => {
        if (!isRecord(entry) || typeof entry.signature !== "string" || typeof entry.slot !== "number") throw new Error("getSignaturesForAddress entry malformed");
        return { signature: entry.signature as Signature, slot: entry.slot, blockTime: typeof entry.blockTime === "number" ? entry.blockTime : null, err: entry.err ?? null };
      });
    },
    fetchTransaction(signature) {
      return call("getTransaction", [signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1, commitment: "confirmed" }]);
    },
  };
}
