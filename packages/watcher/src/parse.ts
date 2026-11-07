// A base-layer `getTransaction` response (`jsonParsed`) as the watcher reads it: the
// `ObserverView` of `@wakeless/binding` plus what `reconstruct()` needs beyond it (every
// account key, every instruction with its raw data, the owner of every token account the
// balances name). The watcher is the auditor of the bindings, so it parses the ledger on
// its own instead of taking a binding's word for it; the view it builds is the same shape
// the MagicBlock binding's `observe` returns. The input is RPC output and is treated as
// untrusted data: an unknown shape throws `WatcherParseError`, an unknown field is ignored.
import { getBase58Encoder, isAddress, type Address, type Signature } from "@solana/kit";
import type { FeeTransfer, ObserverView, PlaintextAmount } from "@wakeless/binding";

export const MEMO_PROGRAM_IDS: ReadonlySet<string> = new Set([
  "MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr",
  "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo",
]);
export const SYSTEM_PROGRAM = "11111111111111111111111111111111" as Address;
export const TOKEN_PROGRAMS: ReadonlySet<string> = new Set([
  "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
  "TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb",
]);

export class WatcherParseError extends Error {
  constructor(detail: string) {
    super(`base-layer getTransaction response: ${detail}`);
    this.name = "WatcherParseError";
  }
}

/** One instruction as the ledger shows it: parsed by the RPC, or raw accounts and data. */
export interface LedgerInstruction {
  readonly programId: Address;
  /** The RPC's name for a program it parses (`spl-token`, `system`, `spl-memo`), when it does. */
  readonly program?: string;
  /** The RPC's parsed form, when it parses the program. */
  readonly parsed?: unknown;
  /** Account addresses in instruction order, for an instruction the RPC does not parse. */
  readonly accounts: readonly Address[];
  /** Instruction data, decoded from base58, for an instruction the RPC does not parse. */
  readonly data: Uint8Array | null;
  /** Index of the top-level instruction this one is, or was invoked under. */
  readonly outerIndex: number;
  readonly inner: boolean;
}

/** A token transfer the ledger shows in plaintext, with the owners the balances give. */
export interface TokenTransfer {
  readonly amount: bigint;
  readonly source: Address;
  readonly destination: Address;
  readonly authority?: Address;
  readonly mint?: Address;
  readonly outerIndex: number;
  readonly inner: boolean;
}

export interface BaseTransaction extends ObserverView {
  readonly slot: number | null;
  /** Unix seconds, when the RPC gives it. */
  readonly blockTime: number | null;
  readonly err: unknown;
  readonly accountKeys: readonly Address[];
  readonly instructions: readonly LedgerInstruction[];
  readonly transfers: readonly TokenTransfer[];
  /** Token account → owner, from the pre and post token balances. */
  readonly tokenOwners: ReadonlyMap<Address, Address>;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new WatcherParseError(`${field} is not an address`);
  return value;
}

// Raw JSON gives numbers and decimal strings; `@solana/kit` gives u64 fields as bigint.
function asAmount(value: unknown, field: string): bigint {
  if (typeof value === "bigint" && value >= 0n) return value;
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new WatcherParseError(`${field} is not an unsigned integer`);
}

function asOptionalNumber(value: unknown, field: string): number | null {
  if (value === undefined || value === null) return null;
  if (typeof value === "bigint" && value >= 0n && value <= BigInt(Number.MAX_SAFE_INTEGER)) return Number(value);
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return value;
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return Number(value);
  throw new WatcherParseError(`${field} is not a number`);
}

function decodeData(value: unknown): Uint8Array | null {
  if (value === undefined || value === null) return null;
  if (typeof value !== "string") throw new WatcherParseError("instruction data is not a string");
  if (value === "") return new Uint8Array(0);
  if (!/^[1-9A-HJ-NP-Za-km-z]+$/.test(value)) throw new WatcherParseError("instruction data is not base58");
  return new Uint8Array(getBase58Encoder().encode(value));
}

export function emptyBaseTransaction(signature: Signature): BaseTransaction {
  return {
    signature,
    onBaseLayer: false,
    slot: null,
    blockTime: null,
    err: null,
    accountKeys: [],
    instructions: [],
    transfers: [],
    tokenOwners: new Map(),
    programIds: [],
    signers: [],
    plaintextAmounts: [],
    plaintextRecipients: [],
    memoText: [],
    feeTransfers: [],
  };
}

/** The `ObserverView` part of a parsed transaction, as a binding's `observe` would return it. */
export function observerViewOf(tx: BaseTransaction): ObserverView {
  const { signature, onBaseLayer, programIds, signers, plaintextAmounts, plaintextRecipients, memoText, feeTransfers } = tx;
  return { signature, onBaseLayer, programIds, signers, plaintextAmounts, plaintextRecipients, memoText, feeTransfers };
}

function parseInstruction(ix: unknown, outerIndex: number, inner: boolean): LedgerInstruction {
  if (!isRecord(ix)) throw new WatcherParseError("instruction is not an object");
  const programId = asAddress(ix.programId, "instruction.programId");
  const accounts: Address[] = [];
  if (ix.accounts !== undefined) {
    if (!Array.isArray(ix.accounts)) throw new WatcherParseError("instruction.accounts is not an array");
    for (const account of ix.accounts) accounts.push(asAddress(account, "instruction.accounts[]"));
  }
  return {
    programId,
    ...(typeof ix.program === "string" ? { program: ix.program } : {}),
    ...(ix.parsed === undefined ? {} : { parsed: ix.parsed }),
    accounts,
    data: ix.parsed === undefined ? decodeData(ix.data) : null,
    outerIndex,
    inner,
  };
}

/** `json` is the `result` of `getTransaction` with `encoding: "jsonParsed"`; `null` means not on the base layer. */
export function parseBaseTransaction(signature: Signature, json: unknown): BaseTransaction {
  if (json === null) return emptyBaseTransaction(signature);
  if (!isRecord(json) || !isRecord(json.transaction) || !isRecord(json.transaction.message)) throw new WatcherParseError("transaction.message missing");
  const message = json.transaction.message;
  if (!Array.isArray(message.accountKeys)) throw new WatcherParseError("accountKeys is not an array");
  const accountKeys: Address[] = [];
  const signers: Address[] = [];
  for (const key of message.accountKeys) {
    if (!isRecord(key)) throw new WatcherParseError("accountKeys entry is not an object");
    const pubkey = asAddress(key.pubkey, "accountKeys[].pubkey");
    accountKeys.push(pubkey);
    if (key.signer === true) signers.push(pubkey);
  }
  const meta = isRecord(json.meta) ? json.meta : {};
  const slot = asOptionalNumber(json.slot, "slot");
  const blockTime = asOptionalNumber(json.blockTime, "blockTime");

  const instructions: LedgerInstruction[] = [];
  const outer = Array.isArray(message.instructions) ? message.instructions : [];
  outer.forEach((ix, index) => instructions.push(parseInstruction(ix, index, false)));
  if (Array.isArray(meta.innerInstructions)) {
    for (const group of meta.innerInstructions) {
      if (!isRecord(group)) throw new WatcherParseError("innerInstructions group is not an object");
      const index = asOptionalNumber(group.index, "innerInstructions[].index") ?? 0;
      const list = Array.isArray(group.instructions) ? group.instructions : [];
      for (const ix of list) instructions.push(parseInstruction(ix, index, true));
    }
  }

  const pre = Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [];
  const post = Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [];
  const balanceOf = (entry: unknown): { index: number; amount: bigint; owner?: Address; mint?: Address } => {
    if (!isRecord(entry) || typeof entry.accountIndex !== "number" || !isRecord(entry.uiTokenAmount)) throw new WatcherParseError("token balance entry malformed");
    return {
      index: entry.accountIndex,
      amount: asAmount(entry.uiTokenAmount.amount, "token balance amount"),
      ...(entry.owner === undefined ? {} : { owner: asAddress(entry.owner, "token balance owner") }),
      ...(entry.mint === undefined ? {} : { mint: asAddress(entry.mint, "token balance mint") }),
    };
  };
  const tokenOwners = new Map<Address, Address>();
  const preBalances = pre.map(balanceOf);
  const postBalances = post.map(balanceOf);
  for (const b of [...preBalances, ...postBalances]) {
    const account = accountKeys[b.index];
    if (account === undefined) throw new WatcherParseError("token balance accountIndex out of range");
    if (b.owner !== undefined) tokenOwners.set(account, b.owner);
  }

  const programIds: Address[] = [];
  const plaintextAmounts: PlaintextAmount[] = [];
  const recipients: Address[] = [];
  const memoText: string[] = [];
  const feeTransfers: FeeTransfer[] = [];
  const transfers: TokenTransfer[] = [];

  for (const ix of instructions) {
    if (!programIds.includes(ix.programId)) programIds.push(ix.programId);
    if (MEMO_PROGRAM_IDS.has(ix.programId)) {
      memoText.push(typeof ix.parsed === "string" ? ix.parsed : JSON.stringify(ix.parsed ?? null));
      continue;
    }
    const parsed = ix.parsed;
    if (!isRecord(parsed)) continue;
    const info = isRecord(parsed.info) ? parsed.info : {};
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (TOKEN_PROGRAMS.has(ix.programId) && /^transfer/.test(type)) {
      const raw = info.amount ?? (isRecord(info.tokenAmount) ? info.tokenAmount.amount : undefined);
      const amount = asAmount(raw, "transfer amount");
      const source = asAddress(info.source, "transfer source");
      const destination = asAddress(info.destination, "transfer destination");
      const mint = info.mint === undefined ? undefined : asAddress(info.mint, "transfer mint");
      const authority = info.authority === undefined ? undefined : asAddress(info.authority, "transfer authority");
      plaintextAmounts.push({ amount, kind: "transfer", source, destination, ...(mint === undefined ? {} : { mint }) });
      transfers.push({ amount, source, destination, ...(authority === undefined ? {} : { authority }), ...(mint === undefined ? {} : { mint }), outerIndex: ix.outerIndex, inner: ix.inner });
      recipients.push(destination);
    }
    if (ix.programId === SYSTEM_PROGRAM && type === "transfer") {
      feeTransfers.push({ from: asAddress(info.source, "system transfer source"), to: asAddress(info.destination, "system transfer destination"), lamports: asAmount(info.lamports, "lamports") });
    }
  }

  const before = new Map(preBalances.map((b) => [b.index, b.amount]));
  for (const p of postBalances) {
    const delta = p.amount - (before.get(p.index) ?? 0n);
    if (delta === 0n) continue;
    const account = accountKeys[p.index]!;
    plaintextAmounts.push({ amount: delta < 0n ? -delta : delta, kind: "balanceDelta", destination: account, ...(p.owner === undefined ? {} : { owner: p.owner }), ...(p.mint === undefined ? {} : { mint: p.mint }) });
    if (delta > 0n) recipients.push(account);
  }

  return {
    signature,
    onBaseLayer: true,
    slot,
    blockTime,
    err: meta.err ?? null,
    accountKeys,
    instructions,
    transfers,
    tokenOwners,
    programIds,
    signers,
    plaintextAmounts,
    plaintextRecipients: [...new Set(recipients)],
    memoText,
    feeTransfers,
  };
}
