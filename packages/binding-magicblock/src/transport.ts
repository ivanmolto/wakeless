// Every byte that leaves the binding goes through this interface, so the contract test can
// stand a fake in front of it and the real one wraps exactly the calls the spike proved:
// the kit's verifyTeeRpcIntegrity and getAuthToken, the Payments API over fetch, the TEE
// RPC over JSON-RPC with the login token, and the base RPC's getTransaction.
import { getAuthToken, verifyTeeRpcIntegrity } from "@magicblock-labs/ephemeral-rollups-kit";
import { createSolanaRpc, type Address, type Signature } from "@solana/kit";
import { ApiError, TeeRpcError } from "./api.js";

export interface ApiRequest {
  readonly method: "GET" | "POST";
  readonly path: string;
  readonly body?: Readonly<Record<string, unknown>>;
  /** The Payments API's own login token (not the TEE RPC's). */
  readonly token?: string;
}

export type SignMessage = (message: Uint8Array) => Promise<Uint8Array>;

export interface MagicBlockTransport {
  /** Throws, or resolves false, when the TEE RPC cannot be attested. */
  verifyTeeRpcIntegrity(teeRpcUrl: string): Promise<boolean | void>;
  /** Login at the TEE RPC; the token is needed to submit to and read from the rollup. */
  teeLogin(teeRpcUrl: string, address: Address, signMessage: SignMessage): Promise<{ token: string; expiresAt: number }>;
  /** Payments API. Rejects with ApiError on a non-2xx answer. */
  api(request: ApiRequest): Promise<unknown>;
  /** TEE RPC JSON-RPC. Rejects with TeeRpcError on a JSON-RPC error. */
  teeRpc(teeRpcUrl: string, method: string, params: readonly unknown[], token?: string): Promise<unknown>;
  /** Base layer: the cluster's genesis hash, asserted before anything else. */
  baseGenesisHash(): Promise<string>;
  /** Base layer: `getTransaction` with `jsonParsed`; `null` when the signature is not there. */
  baseTransaction(signature: Signature): Promise<unknown>;
}

async function parseJson(res: Response): Promise<unknown> {
  const text = await res.text();
  try {
    return JSON.parse(text) as unknown;
  } catch {
    return { raw: text.slice(0, 200) };
  }
}

function errorField(body: unknown, key: "code" | "message"): string | undefined {
  if (typeof body !== "object" || body === null) return undefined;
  const error = (body as Record<string, unknown>).error;
  if (typeof error !== "object" || error === null) return undefined;
  const value = (error as Record<string, unknown>)[key];
  return typeof value === "string" ? value : undefined;
}

export function createTransport(config: { paymentsApiUrl: string; baseRpcUrl: string; fetch?: typeof fetch }): MagicBlockTransport {
  const doFetch = config.fetch ?? fetch;
  const apiBase = config.paymentsApiUrl.replace(/\/$/, "");
  const baseRpc = createSolanaRpc(config.baseRpcUrl);
  return {
    verifyTeeRpcIntegrity: (teeRpcUrl) => verifyTeeRpcIntegrity(teeRpcUrl),
    teeLogin: (teeRpcUrl, address, signMessage) => getAuthToken(teeRpcUrl, address as unknown as Parameters<typeof getAuthToken>[1], signMessage),
    async api({ method, path, body, token }) {
      const headers: Record<string, string> = { accept: "application/json" };
      if (body !== undefined) headers["content-type"] = "application/json";
      if (token) headers.authorization = `Bearer ${token}`;
      const res = await doFetch(`${apiBase}${path}`, { method, headers, body: body === undefined ? undefined : JSON.stringify(body) });
      const json = await parseJson(res);
      if (!res.ok) throw new ApiError(`${method} ${path.split("?")[0]}`, res.status, errorField(json, "code"), errorField(json, "message"));
      return json;
    },
    async teeRpc(teeRpcUrl, method, params, token) {
      const url = token ? `${teeRpcUrl}?token=${encodeURIComponent(token)}` : teeRpcUrl;
      const res = await doFetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }) });
      const json = (await parseJson(res)) as { result?: unknown; error?: unknown };
      if (json.error !== undefined) throw new TeeRpcError(method, json.error);
      if (!res.ok) throw new TeeRpcError(method, { status: res.status });
      return json.result ?? null;
    },
    baseGenesisHash: () => baseRpc.getGenesisHash().send(),
    baseTransaction: (signature) =>
      // Version 1 transactions (SIMD-0385) exist on devnet; kit 8 types still say 0.
      baseRpc.getTransaction(signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 as unknown as 0, commitment: "confirmed" }).send(),
  };
}
