// The shapes the page reads: `docs/side-by-side.json` (written by `pnpm side-by-side`) and,
// when present, a leakage snapshot `docs/leak/snapshot-YYYY-MM-DD.json`, whose schema the
// indexer owns (`packages/watcher/src/leak/snapshot.schema.ts`, task 11.3). Both parsers
// take unknown input and either return a typed value or throw ParseError; nothing else escapes.
import { ParseError } from "../../src/leak/snapshot.schema.js";

export { latestLeakHeadline, ParseError, parseLeakHeadline, type LeakHeadline } from "../../src/leak/snapshot.schema.js";

export interface Comparison {
  readonly vendorsRecovered: number;
  readonly vendorsActual: number;
  readonly spendRecoveredBps: number;
  readonly orderRecovered: boolean;
}

export interface Edge {
  readonly signature: string;
  readonly blockTime: number | null;
  readonly program: string;
  readonly from: string;
  readonly to: string;
  readonly amount: string;
}

export interface Trajectory {
  readonly payer?: string;
  readonly firstContactOrder: readonly string[];
  readonly spendPerVendor: Readonly<Record<string, string>>;
  readonly settlementTimes: readonly number[];
}

export interface ObserverRow {
  readonly signature: string;
  readonly label: string;
  readonly onBaseLayer: boolean;
  readonly plaintextAmounts: number;
  readonly plaintextRecipients: number;
  readonly memos: number;
  readonly checksFailed: readonly string[];
}

export interface Rail {
  readonly rail: "public" | "wakeless";
  readonly title: string;
  readonly calls: number;
  readonly railTransactions: number;
  readonly transactionsPerCall: string;
  readonly comparison: Comparison;
  readonly observer: { readonly rows: readonly ObserverRow[]; readonly signatures: number; readonly onBaseLayer: number; readonly notOnBaseLayer: number };
  readonly rebuilt: Trajectory & { readonly edges: readonly Edge[] };
  readonly actual: Trajectory;
}

export interface SideBySide {
  readonly date: string;
  readonly workload: string;
  /** The plain-English paragraph `differenceParagraph()` wrote: the difference, what remains, the trust boundary. */
  readonly difference: string;
  /** The trust boundary alone: the three operators who see inside. */
  readonly trustBoundary: string;
  readonly publicRail: Rail;
  readonly wakeless: Rail;
}

type Obj = Record<string, unknown>;

function obj(v: unknown, path: string): Obj {
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new ParseError(path, "expected an object");
  return v as Obj;
}
function arr(v: unknown, path: string): unknown[] {
  if (!Array.isArray(v)) throw new ParseError(path, "expected an array");
  return v;
}
function str(v: unknown, path: string): string {
  if (typeof v !== "string") throw new ParseError(path, "expected a string");
  return v;
}
function num(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isFinite(v)) throw new ParseError(path, "expected a finite number");
  return v;
}
function count(v: unknown, path: string): number {
  const n = num(v, path);
  if (!Number.isInteger(n) || n < 0) throw new ParseError(path, "expected a non-negative integer");
  return n;
}
function bool(v: unknown, path: string): boolean {
  if (typeof v !== "boolean") throw new ParseError(path, "expected a boolean");
  return v;
}
function amount(v: unknown, path: string): string {
  const s = str(v, path);
  if (!/^\d+$/.test(s)) throw new ParseError(path, "expected a base-unit integer string");
  return s;
}

function trajectory(v: unknown, path: string): Trajectory {
  const o = obj(v, path);
  const spend = obj(o.spendPerVendor, `${path}.spendPerVendor`);
  const spendPerVendor: Record<string, string> = {};
  for (const [k, a] of Object.entries(spend)) spendPerVendor[k] = amount(a, `${path}.spendPerVendor.${k}`);
  return {
    ...(o.payer === undefined ? {} : { payer: str(o.payer, `${path}.payer`) }),
    firstContactOrder: arr(o.firstContactOrder, `${path}.firstContactOrder`).map((x, i) => str(x, `${path}.firstContactOrder[${i}]`)),
    spendPerVendor,
    settlementTimes: arr(o.settlementTimes, `${path}.settlementTimes`).map((x, i) => num(x, `${path}.settlementTimes[${i}]`)),
  };
}

function edge(v: unknown, path: string): Edge {
  const o = obj(v, path);
  return {
    signature: str(o.signature, `${path}.signature`),
    blockTime: o.blockTime === null || o.blockTime === undefined ? null : num(o.blockTime, `${path}.blockTime`),
    program: str(o.program, `${path}.program`),
    from: str(o.from, `${path}.from`),
    to: str(o.to, `${path}.to`),
    amount: amount(o.amount, `${path}.amount`),
  };
}

function row(v: unknown, path: string): ObserverRow {
  const o = obj(v, path);
  const checks = arr(o.checks, `${path}.checks`).map((c, i) => obj(c, `${path}.checks[${i}]`));
  return {
    signature: str(o.signature, `${path}.signature`),
    // The e2e helper numbers its labels; the page numbers its own rows.
    label: str(o.label, `${path}.label`).replace(/^\d+\. /, ""),
    onBaseLayer: bool(o.onBaseLayer, `${path}.onBaseLayer`),
    plaintextAmounts: arr(o.plaintextAmounts, `${path}.plaintextAmounts`).length,
    plaintextRecipients: arr(o.plaintextRecipients, `${path}.plaintextRecipients`).length,
    memos: arr(o.memoText, `${path}.memoText`).length,
    checksFailed: checks.filter((c, i) => !bool(c.pass, `${path}.checks[${i}].pass`)).map((c, i) => str(c.name, `${path}.checks[${i}].name`)),
  };
}

function rail(v: unknown, path: string, expected: Rail["rail"]): Rail {
  const o = obj(v, path);
  if (o.rail !== expected) throw new ParseError(`${path}.rail`, `expected "${expected}"`);
  const cmp = obj(o.comparison, `${path}.comparison`);
  const observer = obj(o.observer, `${path}.observer`);
  const counts = obj(observer.counts, `${path}.observer.counts`);
  const rebuilt = obj(o.rebuilt, `${path}.rebuilt`);
  return {
    rail: expected,
    title: str(o.title, `${path}.title`),
    calls: count(o.calls, `${path}.calls`),
    railTransactions: count(o.railTransactions, `${path}.railTransactions`),
    transactionsPerCall: str(o.transactionsPerCall, `${path}.transactionsPerCall`),
    comparison: {
      vendorsRecovered: count(cmp.vendorsRecovered, `${path}.comparison.vendorsRecovered`),
      vendorsActual: count(cmp.vendorsActual, `${path}.comparison.vendorsActual`),
      spendRecoveredBps: count(cmp.spendRecoveredBps, `${path}.comparison.spendRecoveredBps`),
      orderRecovered: bool(cmp.orderRecovered, `${path}.comparison.orderRecovered`),
    },
    observer: {
      rows: arr(observer.rows, `${path}.observer.rows`).map((r, i) => row(r, `${path}.observer.rows[${i}]`)),
      signatures: count(counts.signatures, `${path}.observer.counts.signatures`),
      onBaseLayer: count(counts.onBaseLayer, `${path}.observer.counts.onBaseLayer`),
      notOnBaseLayer: count(counts.notOnBaseLayer, `${path}.observer.counts.notOnBaseLayer`),
    },
    rebuilt: { ...trajectory(rebuilt, `${path}.rebuilt`), edges: arr(rebuilt.edges, `${path}.rebuilt.edges`).map((e, i) => edge(e, `${path}.rebuilt.edges[${i}]`)) },
    actual: trajectory(o.actual, `${path}.actual`),
  };
}

export function parseSideBySide(v: unknown): SideBySide {
  const o = obj(v, "side-by-side");
  return {
    date: str(o.date, "date"),
    workload: str(o.workload, "workload"),
    difference: str(o.difference, "difference"),
    trustBoundary: str(o.trustBoundary, "trustBoundary"),
    publicRail: rail(o.public, "public", "public"),
    wakeless: rail(o.wakeless, "wakeless", "wakeless"),
  };
}
