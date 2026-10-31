// Base-layer transaction (jsonParsed) → ObserverView. Ported from the spike's observer pass.
// The input is RPC output, so it is parsed as untrusted data: unknown shapes throw
// MalformedResponseError; unknown fields are ignored.
import { isAddress, type Address, type Signature } from "@solana/kit";
import type { FeeTransfer, ObserverView, PlaintextAmount } from "@wakeless/binding";
import { MalformedResponseError } from "./api.js";

export const MEMO_PROGRAM_IDS: ReadonlySet<string> = new Set(["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"]);
const SYSTEM_PROGRAM = "11111111111111111111111111111111";

const WHAT = "base-layer getTransaction response";

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asAddress(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new MalformedResponseError(WHAT, `${field} is not an address`);
  return value;
}

function asAmount(value: unknown, field: string): bigint {
  if (typeof value === "number" && Number.isSafeInteger(value) && value >= 0) return BigInt(value);
  if (typeof value === "string" && /^(0|[1-9][0-9]*)$/.test(value)) return BigInt(value);
  throw new MalformedResponseError(WHAT, `${field} is not an unsigned integer`);
}

export function emptyObserverView(signature: Signature): ObserverView {
  return { signature, onBaseLayer: false, programIds: [], signers: [], plaintextAmounts: [], plaintextRecipients: [], memoText: [], feeTransfers: [] };
}

/** `json` is the `result` of `getTransaction` with `encoding: "jsonParsed"`; `null` means not on the base layer. */
export function parseObserverView(signature: Signature, json: unknown): ObserverView {
  if (json === null) return emptyObserverView(signature);
  if (!isRecord(json) || !isRecord(json.transaction) || !isRecord(json.transaction.message)) throw new MalformedResponseError(WHAT, "transaction.message missing");
  const message = json.transaction.message;
  if (!Array.isArray(message.accountKeys)) throw new MalformedResponseError(WHAT, "accountKeys is not an array");
  const accountKeys: Address[] = [];
  const signers: Address[] = [];
  for (const key of message.accountKeys) {
    if (!isRecord(key)) throw new MalformedResponseError(WHAT, "accountKeys entry is not an object");
    const pubkey = asAddress(key.pubkey, "accountKeys[].pubkey");
    accountKeys.push(pubkey);
    if (key.signer === true) signers.push(pubkey);
  }
  const meta = isRecord(json.meta) ? json.meta : {};
  const outer = Array.isArray(message.instructions) ? message.instructions : [];
  const inner = Array.isArray(meta.innerInstructions) ? meta.innerInstructions.flatMap((group) => (isRecord(group) && Array.isArray(group.instructions) ? group.instructions : [])) : [];

  const programIds: Address[] = [];
  const plaintextAmounts: PlaintextAmount[] = [];
  const recipients: Address[] = [];
  const memoText: string[] = [];
  const feeTransfers: FeeTransfer[] = [];

  for (const ix of [...outer, ...inner]) {
    if (!isRecord(ix)) throw new MalformedResponseError(WHAT, "instruction is not an object");
    const programId = asAddress(ix.programId, "instruction.programId");
    if (!programIds.includes(programId)) programIds.push(programId);
    const parsed = ix.parsed;
    if (MEMO_PROGRAM_IDS.has(programId)) {
      memoText.push(typeof parsed === "string" ? parsed : JSON.stringify(parsed ?? ix.data ?? null));
      continue;
    }
    if (!isRecord(parsed)) continue;
    const info = isRecord(parsed.info) ? parsed.info : {};
    const type = typeof parsed.type === "string" ? parsed.type : "";
    if (ix.program === "spl-token" && /^transfer/.test(type)) {
      const raw = info.amount ?? (isRecord(info.tokenAmount) ? info.tokenAmount.amount : undefined);
      const amount = asAmount(raw, "transfer amount");
      const destination = info.destination === undefined ? undefined : asAddress(info.destination, "transfer destination");
      plaintextAmounts.push({
        amount,
        kind: "transfer",
        ...(info.source === undefined ? {} : { source: asAddress(info.source, "transfer source") }),
        ...(destination === undefined ? {} : { destination }),
        ...(info.mint === undefined ? {} : { mint: asAddress(info.mint, "transfer mint") }),
      });
      if (destination !== undefined) recipients.push(destination);
    }
    if (programId === SYSTEM_PROGRAM && type === "transfer") {
      feeTransfers.push({ from: asAddress(info.source, "system transfer source"), to: asAddress(info.destination, "system transfer destination"), lamports: asAmount(info.lamports, "lamports") });
    }
  }

  const pre = Array.isArray(meta.preTokenBalances) ? meta.preTokenBalances : [];
  const post = Array.isArray(meta.postTokenBalances) ? meta.postTokenBalances : [];
  const balanceOf = (entry: unknown): { index: number; amount: bigint; owner?: Address; mint?: Address } => {
    if (!isRecord(entry) || typeof entry.accountIndex !== "number" || !isRecord(entry.uiTokenAmount)) throw new MalformedResponseError(WHAT, "token balance entry malformed");
    return {
      index: entry.accountIndex,
      amount: asAmount(entry.uiTokenAmount.amount, "token balance amount"),
      ...(entry.owner === undefined ? {} : { owner: asAddress(entry.owner, "token balance owner") }),
      ...(entry.mint === undefined ? {} : { mint: asAddress(entry.mint, "token balance mint") }),
    };
  };
  const before = new Map(pre.map(balanceOf).map((b) => [b.index, b.amount]));
  for (const p of post.map(balanceOf)) {
    const delta = p.amount - (before.get(p.index) ?? 0n);
    if (delta === 0n) continue;
    const account = accountKeys[p.index];
    if (account === undefined) throw new MalformedResponseError(WHAT, "token balance accountIndex out of range");
    plaintextAmounts.push({ amount: delta < 0n ? -delta : delta, kind: "balanceDelta", destination: account, ...(p.owner === undefined ? {} : { owner: p.owner }), ...(p.mint === undefined ? {} : { mint: p.mint }) });
    if (delta > 0n) recipients.push(account);
  }

  return { signature, onBaseLayer: true, programIds, signers, plaintextAmounts, plaintextRecipients: [...new Set(recipients)], memoText, feeTransfers };
}
