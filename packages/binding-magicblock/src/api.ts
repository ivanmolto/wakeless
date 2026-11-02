// Private Payments API shapes, as read on devnet on 31 Oct 2026 (scripts/spike-magicblock.ts),
// and the parsers that admit nothing else. Every parser takes `unknown` and throws
// MalformedResponseError on any other shape; the fuzz tests hold that.
import { BINDING_ERROR_CODES, BindingError } from "@wakeless/binding";

/** A non-2xx answer from the Payments API. The body's `error.code` and `error.message` are kept; nothing else. */
export class ApiError extends Error {
  constructor(
    readonly call: string,
    readonly status: number,
    readonly apiCode: string | undefined,
    readonly apiMessage: string | undefined,
  ) {
    super(`${call} → HTTP ${status}${apiCode ? ` ${apiCode}` : ""}${apiMessage ? `: ${apiMessage}` : ""}`);
    this.name = "ApiError";
  }
}

/** A JSON-RPC error from the TEE RPC. Ingress refuses a transaction this way. */
export class TeeRpcError extends Error {
  constructor(
    readonly method: string,
    readonly rpcError: unknown,
  ) {
    super(`TEE RPC ${method}: ${JSON.stringify(rpcError)}`);
    this.name = "TeeRpcError";
  }
}

/** A response that does not match the shape the spike recorded. */
export class MalformedResponseError extends Error {
  constructor(what: string, detail: string) {
    super(`${what}: ${detail}`);
    this.name = "MalformedResponseError";
  }
}

/** A transfer that was submitted but not seen confirmed in time. The signature lets the caller keep it owed and look again. */
export class UnconfirmedTransferError extends Error {
  constructor(
    readonly signature: string,
    readonly waitedMs: number,
  ) {
    super(`ephemeral transaction ${signature} not confirmed on the TEE RPC after ${waitedMs} ms`);
    this.name = "UnconfirmedTransferError";
  }
}

/** Codes the API uses for a route it will not serve privately, plus what ingress screening answers. */
const REJECTION_CODES = /^(UNSUPPORTED_TRANSFER_ROUTE|.*(REJECT|SCREEN|GEOFENC|SANCTION|FORBIDDEN|BLOCKED|DENIED).*)$/i;

/**
 * Maps a failed private transfer to `shielded_binding_rejected` when the API or the enclave
 * refused it. Anything else is rethrown unchanged. Nothing here is ever retried, and
 * nothing is ever retried publicly.
 */
export function mapTransferError(error: unknown): never {
  if (error instanceof ApiError && (error.status === 403 || (error.apiCode !== undefined && REJECTION_CODES.test(error.apiCode)))) {
    throw new BindingError(BINDING_ERROR_CODES.bindingRejected, `private transfer refused by the Payments API (${error.apiCode ?? `HTTP ${error.status}`})`, {
      cause: error,
      apiCode: error.apiCode ?? `HTTP_${error.status}`,
    });
  }
  if (error instanceof TeeRpcError && error.method === "sendTransaction") {
    throw new BindingError(BINDING_ERROR_CODES.bindingRejected, "private transfer refused at PER ingress", { cause: error, apiCode: "TEE_INGRESS" });
  }
  throw error;
}

// ---------------------------------------------------------------------------- shapes

export type BuiltTransaction = {
  kind: string;
  version: "legacy" | "v0";
  transactionBase64: string;
  sendTo: "base" | "ephemeral";
  sendRpcEndpoint?: string;
  recentBlockhash: string;
  lastValidBlockHeight: number;
  instructionCount?: number;
  requiredSigners: string[];
  validator?: string;
};

export type PrivateBalance = {
  address: string;
  mint: string;
  /** The owner's token account; delegated into the rollup when `location` is `ephemeral`. */
  ata: string;
  location: string;
  balance: bigint;
  delegation?: { status?: string; validator?: string; endpoint?: string };
};

/** What the TEE RPC returns for an ephemeral signature: existence and success, nothing else (probe, 31 Oct 2026). */
export type TeeTransaction = {
  err: unknown;
  slot: number | null;
  blockTime: number | null;
};

// ---------------------------------------------------------------------------- parsers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function str(record: Record<string, unknown>, key: string, what: string): string {
  const value = record[key];
  if (typeof value !== "string") throw new MalformedResponseError(what, `${key} is not a string`);
  return value;
}

function optStr(record: Record<string, unknown>, key: string, what: string): string | undefined {
  const value = record[key];
  if (value === undefined || value === null) return undefined;
  if (typeof value !== "string") throw new MalformedResponseError(what, `${key} is not a string`);
  return value;
}

function num(record: Record<string, unknown>, key: string, what: string): number {
  const value = record[key];
  if (typeof value !== "number" || !Number.isFinite(value)) throw new MalformedResponseError(what, `${key} is not a finite number`);
  return value;
}

export function parseBuiltTransaction(json: unknown): BuiltTransaction {
  const what = "Payments API build response";
  if (!isRecord(json)) throw new MalformedResponseError(what, "not an object");
  const version = str(json, "version", what);
  if (version !== "legacy" && version !== "v0") throw new MalformedResponseError(what, "version is neither legacy nor v0");
  const sendTo = str(json, "sendTo", what);
  if (sendTo !== "base" && sendTo !== "ephemeral") throw new MalformedResponseError(what, "sendTo is neither base nor ephemeral");
  const signers = json.requiredSigners;
  if (!Array.isArray(signers) || !signers.every((s) => typeof s === "string")) throw new MalformedResponseError(what, "requiredSigners is not a string array");
  const transactionBase64 = str(json, "transactionBase64", what);
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(transactionBase64)) throw new MalformedResponseError(what, "transactionBase64 is not base64");
  const instructionCount = json.instructionCount === undefined ? undefined : num(json, "instructionCount", what);
  return {
    kind: str(json, "kind", what),
    version,
    transactionBase64,
    sendTo,
    sendRpcEndpoint: optStr(json, "sendRpcEndpoint", what),
    recentBlockhash: str(json, "recentBlockhash", what),
    lastValidBlockHeight: num(json, "lastValidBlockHeight", what),
    ...(instructionCount === undefined ? {} : { instructionCount }),
    requiredSigners: signers as string[],
    validator: optStr(json, "validator", what),
  };
}

export function parsePrivateBalance(json: unknown): PrivateBalance {
  const what = "Payments API private-balance response";
  if (!isRecord(json)) throw new MalformedResponseError(what, "not an object");
  const balance = str(json, "balance", what);
  if (!/^(0|[1-9][0-9]*)$/.test(balance)) throw new MalformedResponseError(what, "balance is not a decimal integer");
  const delegation = json.delegation;
  if (delegation !== undefined && delegation !== null && !isRecord(delegation)) throw new MalformedResponseError(what, "delegation is not an object");
  return {
    address: str(json, "address", what),
    mint: str(json, "mint", what),
    ata: str(json, "ata", what),
    location: str(json, "location", what),
    balance: BigInt(balance),
    ...(isRecord(delegation)
      ? { delegation: { status: optStr(delegation, "status", what), validator: optStr(delegation, "validator", what), endpoint: optStr(delegation, "endpoint", what) } }
      : {}),
  };
}

/** `null` when the TEE RPC has no such transaction. */
export function parseTeeTransaction(json: unknown): TeeTransaction | null {
  const what = "TEE RPC getTransaction response";
  if (json === null) return null;
  if (!isRecord(json)) throw new MalformedResponseError(what, "not an object");
  const meta = json.meta;
  if (meta !== undefined && meta !== null && !isRecord(meta)) throw new MalformedResponseError(what, "meta is not an object");
  const err = isRecord(meta) ? (meta.err ?? null) : null;
  const slot = typeof json.slot === "number" ? json.slot : null;
  const blockTime = typeof json.blockTime === "number" ? json.blockTime : null;
  return { err, slot, blockTime };
}

const REFERENCE_KEY = /^(clientRefId|clientRef|refId|reference|referenceId|referenceIds|memo|memos)$/i;

/**
 * Every value a response carries under a reference-like key (`clientRefId`, `reference`,
 * `memo`), at any depth, as strings. The spike found none in a private-balance answer;
 * this is how a reader shows it is still none. Never throws.
 */
export function referenceIdsIn(json: unknown, depth = 0): string[] {
  if (depth > 8) return [];
  if (Array.isArray(json)) return json.flatMap((item) => referenceIdsIn(item, depth + 1));
  if (!isRecord(json)) return [];
  const out: string[] = [];
  for (const [key, value] of Object.entries(json)) {
    if (REFERENCE_KEY.test(key)) {
      const values = Array.isArray(value) ? value : [value];
      for (const v of values) if ((typeof v === "string" && v !== "") || typeof v === "number") out.push(String(v));
    } else {
      out.push(...referenceIdsIn(value, depth + 1));
    }
  }
  return out;
}

export function parseChallenge(json: unknown): string {
  const what = "Payments API challenge response";
  if (!isRecord(json)) throw new MalformedResponseError(what, "not an object");
  return str(json, "challenge", what);
}

export function parseLoginToken(json: unknown): string {
  const what = "Payments API login response";
  if (!isRecord(json)) throw new MalformedResponseError(what, "not an object");
  const token = str(json, "token", what);
  if (token.length === 0) throw new MalformedResponseError(what, "token is empty");
  return token;
}

export function parseIdentity(json: unknown): string | null {
  if (!isRecord(json)) return null;
  const identity = json.identity;
  return typeof identity === "string" ? identity : null;
}
