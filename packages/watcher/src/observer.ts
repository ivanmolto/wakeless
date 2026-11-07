// The observer's view (task 9.1): what an unprivileged reader of the public ledger sees of
// each signature, and the four pass/fail checks of the briefing (§5) on every Wakeless
// signature: no vendor address; no vendor-attributable amount; no Memo instruction; no fee
// transfer naming the vendor. One failure fails the run. The checks are mechanical: a fixed
// set of addresses and amounts that must not appear, and nothing else.
import { getBase58Encoder, type Address, type Signature } from "@solana/kit";
import type { ObserverView } from "@wakeless/binding";
import type { BaseTransaction, LedgerInstruction } from "./parse.js";
import type { FetchTransaction } from "./rpc.js";

export type CheckId = 1 | 2 | 3 | 4;

export const CHECK_NAMES: Readonly<Record<CheckId, string>> = {
  1: "no vendor address",
  2: "no vendor-attributable amount",
  3: "no Memo instruction",
  4: "no fee transfer naming the vendor",
};

/** The parties and amounts a signature must not show. */
export interface CheckSubject {
  /** How the table names the subject: "the vendors", "the escrow and the buyer". */
  readonly label: string;
  /** Wallets and token accounts that must not appear anywhere in the transaction. */
  readonly addresses: readonly Address[];
  /** Amounts (base units) the owner knows were paid to a vendor; none of them may be in clear. */
  readonly amounts?: readonly bigint[];
}

export interface CheckResult {
  readonly check: CheckId;
  readonly name: string;
  readonly pass: boolean;
  /** Where the subject was found, when it was. */
  readonly evidence: readonly string[];
}

/**
 * An `ObserverView` with, when the watcher parsed the transaction itself, every account key
 * and every instruction's raw data. A binding's own `observe` gives the view alone; the
 * watcher's reader gives all three, and the checks then also read the bytes a program was
 * given: an address or an amount in instruction data is in plaintext as much as one in a
 * token transfer (the public rail's `open` names `payTo` only there).
 */
export type Checkable = ObserverView & {
  readonly accountKeys?: readonly Address[];
  readonly instructions?: readonly Pick<LedgerInstruction, "programId" | "data">[];
};

function short(address: string): string {
  return `${address.slice(0, 4)}…${address.slice(-4)}`;
}

function addressBytes(address: Address): Uint8Array | null {
  try {
    const bytes = new Uint8Array(getBase58Encoder().encode(address));
    return bytes.byteLength === 32 ? bytes : null;
  } catch {
    return null;
  }
}

function u64Bytes(amount: bigint): Uint8Array {
  const bytes = new Uint8Array(8);
  new DataView(bytes.buffer).setBigUint64(0, amount, true);
  return bytes;
}

function contains(haystack: Uint8Array, needle: Uint8Array): boolean {
  outer: for (let i = 0; i + needle.byteLength <= haystack.byteLength; i++) {
    for (let j = 0; j < needle.byteLength; j++) if (haystack[i + j] !== needle[j]) continue outer;
    return true;
  }
  return false;
}

/** The four checks on one signature. A signature that is not on the base layer passes all four: there is nothing to read. */
export function runChecks(view: Checkable, subject: CheckSubject): readonly CheckResult[] {
  const forbidden = new Set<string>(subject.addresses);
  const amounts = new Set<bigint>(subject.amounts ?? []);
  const names = (a: string | undefined): boolean => a !== undefined && forbidden.has(a);

  const found1: string[] = [];
  const found2: string[] = [];
  const found3: string[] = [];
  const found4: string[] = [];
  if (view.onBaseLayer) {
    for (const key of view.accountKeys ?? []) if (names(key)) found1.push(`account key ${key}`);
    for (const signer of view.signers) if (names(signer) && !(view.accountKeys ?? []).includes(signer)) found1.push(`signer ${signer}`);
    for (const recipient of view.plaintextRecipients) if (names(recipient) && !(view.accountKeys ?? []).includes(recipient)) found1.push(`recipient ${recipient}`);
    for (const memo of view.memoText) for (const address of forbidden) if (memo.includes(address)) found1.push(`memo names ${address}`);
    for (const amount of view.plaintextAmounts) {
      const party = [amount.source, amount.destination, amount.owner].find(names);
      const where = `${amount.kind} ${amount.amount}${amount.destination ? ` to ${short(amount.destination)}` : ""}${amount.owner ? ` (owner ${short(amount.owner)})` : ""}`;
      if (party !== undefined) {
        found2.push(`${where} names ${party}`);
        if (!(view.accountKeys ?? []).includes(party)) found1.push(`token party ${party}`);
      } else if (amounts.has(amount.amount)) {
        found2.push(`${where} equals an amount paid to a vendor`);
      }
    }
    for (const ix of view.instructions ?? []) {
      if (ix.data === null || ix.data.byteLength === 0) continue;
      for (const address of forbidden) {
        const bytes = addressBytes(address as Address);
        if (bytes !== null && contains(ix.data, bytes)) found1.push(`instruction data of ${short(ix.programId)} carries ${address}`);
      }
      for (const amount of amounts) {
        if (amount > 0n && contains(ix.data, u64Bytes(amount))) found2.push(`instruction data of ${short(ix.programId)} carries ${amount} as a u64`);
      }
    }
    for (const memo of view.memoText) found3.push(`memo ${JSON.stringify(memo)}`);
    for (const fee of view.feeTransfers) {
      if (names(fee.from) || names(fee.to)) found4.push(`${fee.lamports} lamports ${fee.from} → ${fee.to}`);
    }
  }
  return [
    { check: 1, name: CHECK_NAMES[1], pass: found1.length === 0, evidence: found1 },
    { check: 2, name: CHECK_NAMES[2], pass: found2.length === 0, evidence: found2 },
    { check: 3, name: CHECK_NAMES[3], pass: found3.length === 0, evidence: found3 },
    { check: 4, name: CHECK_NAMES[4], pass: found4.length === 0, evidence: found4 },
  ];
}

/**
 * Who made a transaction. The run's own transactions (the buyer's deposits and withdrawals,
 * the escrow's settlements and refunds) are checked against the vendors. A vendor's own
 * withdrawal names the vendor by construction (briefing §5: "recipient, asset, amount;
 * source is the vault"), so it is checked against the escrow and the buyer instead: the
 * claim for it is that it links to neither. That is a rule per party, not a judgement per row.
 */
export type Party = "buyer" | "escrow" | "vendor";

export interface SignatureInput {
  readonly signature: Signature;
  /** What the transaction is, in the owner's words: "deposit to vendor 1's channel", "vault deposit". */
  readonly label: string;
  readonly party: Party;
}

export interface RunDescription {
  /** `wakeless`: a failed check fails the run. `public`: the checks are informational, the rail is expected to fail them. */
  readonly rail: "wakeless" | "public";
  readonly buyer: Address;
  readonly escrow?: Address;
  readonly vendors: readonly Address[];
  /** Token accounts of the parties, when the owner knows them; the balances' owners cover the rest. */
  readonly tokenAccounts?: Readonly<Record<string, readonly Address[]>>;
  /** Amounts the owner paid to vendors (deposits, cumulative vouchers, settlements), base units. */
  readonly attributableAmounts?: readonly bigint[];
  readonly signatures: readonly SignatureInput[];
}

export interface ObserverRow extends SignatureInput {
  readonly onBaseLayer: boolean;
  readonly slot: number | null;
  readonly blockTime: number | null;
  readonly err: unknown;
  readonly programIds: readonly Address[];
  readonly signers: readonly Address[];
  readonly plaintextAmounts: ObserverView["plaintextAmounts"];
  readonly plaintextRecipients: readonly Address[];
  readonly memoText: readonly string[];
  readonly feeTransfers: ObserverView["feeTransfers"];
  readonly checkedAgainst: string;
  readonly checks: readonly CheckResult[];
}

export interface ObserverFailure {
  readonly signature: Signature;
  readonly label: string;
  readonly check: CheckId;
  readonly name: string;
  readonly evidence: readonly string[];
}

export interface ObserverReport {
  readonly rail: RunDescription["rail"];
  readonly rows: readonly ObserverRow[];
  /** Every failed check on the wakeless rail; empty on the public rail, whose rows record their checks but fail nothing. */
  readonly failures: readonly ObserverFailure[];
  readonly counts: {
    readonly signatures: number;
    readonly onBaseLayer: number;
    readonly notOnBaseLayer: number;
  };
}

function tokenAccountsOf(run: RunDescription, owners: readonly Address[]): Address[] {
  return owners.flatMap((owner) => run.tokenAccounts?.[owner] ?? []);
}

/** The subject a signature is checked against, by the party that made it. */
export function subjectFor(run: RunDescription, party: Party): CheckSubject {
  if (party === "vendor") {
    const owners = [run.buyer, ...(run.escrow === undefined ? [] : [run.escrow])];
    return { label: run.escrow === undefined ? "the buyer" : "the escrow and the buyer", addresses: [...owners, ...tokenAccountsOf(run, owners)] };
  }
  return { label: "the vendors", addresses: [...run.vendors, ...tokenAccountsOf(run, run.vendors)], amounts: run.attributableAmounts ?? [] };
}

export function observeTransaction(input: SignatureInput, tx: BaseTransaction, run: RunDescription): ObserverRow {
  const subject = subjectFor(run, input.party);
  const checks = runChecks(tx, subject);
  return {
    ...input,
    onBaseLayer: tx.onBaseLayer,
    slot: tx.slot,
    blockTime: tx.blockTime,
    err: tx.err,
    programIds: tx.programIds,
    signers: tx.signers,
    plaintextAmounts: tx.plaintextAmounts,
    plaintextRecipients: tx.plaintextRecipients,
    memoText: tx.memoText,
    feeTransfers: tx.feeTransfers,
    checkedAgainst: subject.label,
    checks,
  };
}

export function reportOf(rail: RunDescription["rail"], rows: readonly ObserverRow[]): ObserverReport {
  const failures: ObserverFailure[] = [];
  if (rail === "wakeless") {
    for (const row of rows) {
      for (const check of row.checks) {
        if (!check.pass) failures.push({ signature: row.signature, label: row.label, check: check.check, name: check.name, evidence: check.evidence });
      }
    }
  }
  const onBaseLayer = rows.filter((row) => row.onBaseLayer).length;
  return { rail, rows, failures, counts: { signatures: rows.length, onBaseLayer, notOnBaseLayer: rows.length - onBaseLayer } };
}

/** Fetches every signature of a run and runs the checks. Signatures are fetched one at a time, in the order given. */
export async function observe(run: RunDescription, fetch: FetchTransaction): Promise<ObserverReport> {
  const rows: ObserverRow[] = [];
  for (const input of run.signatures) rows.push(observeTransaction(input, await fetch(input.signature), run));
  return reportOf(run.rail, rows);
}

/** One line per failure, for the process that exits non-zero. */
export function formatFailures(report: ObserverReport): string[] {
  return report.failures.map((f) => `FAIL check ${f.check} (${f.name}) on ${f.signature} [${f.label}]: ${f.evidence.join("; ")}`);
}

// ------------------------------------------------------------------------------ rendering

function jsonReplacer(_key: string, value: unknown): unknown {
  return typeof value === "bigint" ? value.toString() : value;
}

export function reportToJson(report: ObserverReport): string {
  return JSON.stringify(report, jsonReplacer, 2) + "\n";
}

function cell(text: string): string {
  return text.replace(/\|/g, "\\|").replace(/\n/g, " ") || "—";
}

function time(blockTime: number | null): string {
  return blockTime === null ? "" : new Date(blockTime * 1000).toISOString().replace(".000Z", "Z");
}

function amountText(a: ObserverView["plaintextAmounts"][number]): string {
  const to = a.destination === undefined ? "" : ` → ${short(a.destination)}${a.owner === undefined ? "" : ` (owner ${short(a.owner)})`}`;
  const from = a.source === undefined ? "" : ` ${short(a.source)}`;
  return `${a.kind === "transfer" ? "transfer" : "balance Δ"} ${a.amount}${from}${to}`;
}

/** The observer table for one rail, as the README quotes it. Addresses are given in full: the claims are about them. */
export function renderMarkdownTable(report: ObserverReport): string {
  const lines: string[] = [];
  lines.push("| # | What | Signature | Base layer | Program ids | Signers | Plaintext token amounts | Plaintext recipients | Memo | Fee transfers (lamports) | Checks (against) |");
  lines.push("| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |");
  report.rows.forEach((row, i) => {
    const base = row.onBaseLayer ? `slot ${row.slot ?? "?"}, ${time(row.blockTime)}${row.err === null || row.err === undefined ? "" : ", failed"}` : "not on the base layer";
    const checks = row.checks.map((c) => `${c.check} ${c.pass ? "pass" : "FAIL"}`).join(", ");
    lines.push(
      `| ${i + 1} | ${cell(row.label)} | \`${row.signature}\` | ${cell(base)} | ${cell(row.programIds.map(short).join(", "))} | ${cell(row.signers.map((s) => `\`${s}\``).join(", "))} | ${cell(row.plaintextAmounts.map(amountText).join("; "))} | ${cell(row.plaintextRecipients.map((r) => `\`${r}\``).join(", "))} | ${cell(row.memoText.map((m) => `\`${m}\``).join("; "))} | ${cell(row.feeTransfers.map((f) => `${f.lamports} ${short(f.from)} → ${short(f.to)}`).join("; "))} | ${cell(`${checks} (${row.checkedAgainst})`)} |`,
    );
  });
  return lines.join("\n");
}
