// The shape of a leakage snapshot, `docs/leak/snapshot-YYYY-MM-DD.json` (task 11.3). This
// file owns the schema: the indexer writes it (`publish.ts`), the watcher's web page reads
// its headline, and the site page will. Every address in a snapshot is truncated to its
// first four and last four characters; the parser refuses anything longer, so a full payer
// or payTo address cannot pass through it. No imports: the web bundle includes this file.

export const SNAPSHOT_SCHEMA = "wakeless-leak-snapshot@1";

export class ParseError extends Error {
  constructor(path: string, what: string) {
    super(`${path}: ${what}`);
    this.name = "ParseError";
  }
}

/** `AbCd…WxYz`: the only form an address takes in published output. */
export const TRUNCATED_ADDRESS = /^[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}$/;

export interface SnapshotHeadline {
  readonly channels: number;
  readonly payers: number;
  readonly payTo: number;
  /** Distinct (payer, payTo) pairs readable on mainnet. */
  readonly relationships: number;
  readonly payersWithTwoOrMorePayTo: number;
  /** Sample size: signatures the indexer scanned. */
  readonly signaturesScanned: number;
}

export interface SnapshotSample {
  readonly signaturesScanned: number;
  readonly signaturesCap: number;
  /** The since-date the run was given, or null for the program's whole history within the cap. */
  readonly since: string | null;
  /** First and last block times scanned, ISO. */
  readonly oldest: string | null;
  readonly newest: string | null;
  readonly transactionsFetched: number;
  readonly transactionsFailed: number;
  readonly channelsWithoutOpen: number;
}

export interface SnapshotDegree {
  readonly payTo: string;
  readonly payers: number;
  readonly channels: number;
}

export interface SnapshotWeek {
  readonly week: string;
  readonly channels: number;
}

export interface SnapshotSettled {
  /** The symbol when the mint is the one USDC mint, the truncated mint otherwise; null without any open in the window. */
  readonly unit: string | null;
  readonly decimals: number | null;
  readonly channelsWithSettlement: number;
  readonly channelsWithoutSettlement: number;
  /** Base units, as decimal strings. */
  readonly total: string;
  readonly median: string;
  readonly max: string;
  /** Channels opened in another mint: counted, never summed into the figures above. */
  readonly channelsInOtherMints: number;
  readonly channelsWithUnknownMint: number;
}

export interface SnapshotTrajectory {
  readonly payer: string;
  readonly channels: number;
  readonly vendors: readonly string[];
  readonly firstContactOrder: readonly string[];
  readonly spendPerVendor: Readonly<Record<string, string>>;
  readonly settlementTimes: readonly number[];
  readonly edges: number;
}

export interface SnapshotX402scan {
  /** The exact-scheme per-call transfer count on Solana, when a public source gave one. */
  readonly exactTransfers: number | null;
  readonly source: string;
  readonly note: string;
}

export interface LeakSnapshot {
  readonly schema: typeof SNAPSHOT_SCHEMA;
  readonly date: string;
  readonly program: { readonly id: string; readonly explorer: string };
  readonly rpcHost: string;
  readonly sample: SnapshotSample;
  readonly headline: SnapshotHeadline;
  readonly channelsPerPayer: { readonly median: number; readonly max: number; readonly payers: number };
  readonly payToDegree: readonly SnapshotDegree[];
  /** Distinct `payee` seats (facilitator sponsor keys under the x402 profile), not vendors. */
  readonly payeeSeats: number;
  readonly settled: SnapshotSettled;
  readonly channelsPerWeek: readonly SnapshotWeek[];
  readonly instructions: Readonly<Record<string, number>>;
  readonly channelsWithFeeRecipient: number;
  readonly sampleTrajectory: SnapshotTrajectory | null;
  readonly x402scan: SnapshotX402scan;
}

/** What the watcher's web page needs of a snapshot. */
export interface LeakHeadline {
  readonly file: string;
  readonly date: string;
  readonly relationships: number;
  readonly signaturesScanned: number;
  readonly channels?: number;
  readonly payers?: number;
  readonly payTo?: number;
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
function nullableStr(v: unknown, path: string): string | null {
  return v === null ? null : str(v, path);
}
function count(v: unknown, path: string): number {
  if (typeof v !== "number" || !Number.isInteger(v) || v < 0) throw new ParseError(path, "expected a non-negative integer");
  return v;
}
function amount(v: unknown, path: string): string {
  const s = str(v, path);
  if (!/^\d+$/.test(s)) throw new ParseError(path, "expected a base-unit integer string");
  return s;
}
function date(v: unknown, path: string): string {
  const s = str(v, path);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(s) || Number.isNaN(Date.parse(s))) throw new ParseError(path, "expected a YYYY-MM-DD date");
  return s;
}
function truncated(v: unknown, path: string): string {
  const s = str(v, path);
  if (!TRUNCATED_ADDRESS.test(s)) throw new ParseError(path, "expected a truncated address (first four, ellipsis, last four)");
  return s;
}

function headline(v: unknown, path: string): SnapshotHeadline {
  const o = obj(v, path);
  return {
    channels: count(o.channels, `${path}.channels`),
    payers: count(o.payers, `${path}.payers`),
    payTo: count(o.payTo, `${path}.payTo`),
    relationships: count(o.relationships, `${path}.relationships`),
    payersWithTwoOrMorePayTo: count(o.payersWithTwoOrMorePayTo, `${path}.payersWithTwoOrMorePayTo`),
    signaturesScanned: count(o.signaturesScanned, `${path}.signaturesScanned`),
  };
}

function sample(v: unknown, path: string): SnapshotSample {
  const o = obj(v, path);
  return {
    signaturesScanned: count(o.signaturesScanned, `${path}.signaturesScanned`),
    signaturesCap: count(o.signaturesCap, `${path}.signaturesCap`),
    since: nullableStr(o.since, `${path}.since`),
    oldest: nullableStr(o.oldest, `${path}.oldest`),
    newest: nullableStr(o.newest, `${path}.newest`),
    transactionsFetched: count(o.transactionsFetched, `${path}.transactionsFetched`),
    transactionsFailed: count(o.transactionsFailed, `${path}.transactionsFailed`),
    channelsWithoutOpen: count(o.channelsWithoutOpen, `${path}.channelsWithoutOpen`),
  };
}

function settled(v: unknown, path: string): SnapshotSettled {
  const o = obj(v, path);
  const unit = nullableStr(o.unit, `${path}.unit`);
  if (unit !== null && unit !== "USDC") truncated(unit, `${path}.unit`);
  return {
    unit,
    decimals: o.decimals === null ? null : count(o.decimals, `${path}.decimals`),
    channelsWithSettlement: count(o.channelsWithSettlement, `${path}.channelsWithSettlement`),
    channelsWithoutSettlement: count(o.channelsWithoutSettlement, `${path}.channelsWithoutSettlement`),
    total: amount(o.total, `${path}.total`),
    median: amount(o.median, `${path}.median`),
    max: amount(o.max, `${path}.max`),
    channelsInOtherMints: count(o.channelsInOtherMints, `${path}.channelsInOtherMints`),
    channelsWithUnknownMint: count(o.channelsWithUnknownMint, `${path}.channelsWithUnknownMint`),
  };
}

function trajectory(v: unknown, path: string): SnapshotTrajectory | null {
  if (v === null) return null;
  const o = obj(v, path);
  const spend = obj(o.spendPerVendor, `${path}.spendPerVendor`);
  const spendPerVendor: Record<string, string> = {};
  for (const [k, a] of Object.entries(spend)) spendPerVendor[truncated(k, `${path}.spendPerVendor key`)] = amount(a, `${path}.spendPerVendor.${k}`);
  return {
    payer: truncated(o.payer, `${path}.payer`),
    channels: count(o.channels, `${path}.channels`),
    vendors: arr(o.vendors, `${path}.vendors`).map((x, i) => truncated(x, `${path}.vendors[${i}]`)),
    firstContactOrder: arr(o.firstContactOrder, `${path}.firstContactOrder`).map((x, i) => truncated(x, `${path}.firstContactOrder[${i}]`)),
    spendPerVendor,
    settlementTimes: arr(o.settlementTimes, `${path}.settlementTimes`).map((x, i) => count(x, `${path}.settlementTimes[${i}]`)),
    edges: count(o.edges, `${path}.edges`),
  };
}

export function parseLeakSnapshot(v: unknown): LeakSnapshot {
  const o = obj(v, "snapshot");
  if (o.schema !== SNAPSHOT_SCHEMA) throw new ParseError("snapshot.schema", `expected "${SNAPSHOT_SCHEMA}"`);
  const program = obj(o.program, "snapshot.program");
  const perPayer = obj(o.channelsPerPayer, "snapshot.channelsPerPayer");
  const x = obj(o.x402scan, "snapshot.x402scan");
  const instructions: Record<string, number> = {};
  for (const [k, n] of Object.entries(obj(o.instructions, "snapshot.instructions"))) instructions[k] = count(n, `snapshot.instructions.${k}`);
  return {
    schema: SNAPSHOT_SCHEMA,
    date: date(o.date, "snapshot.date"),
    program: { id: str(program.id, "snapshot.program.id"), explorer: str(program.explorer, "snapshot.program.explorer") },
    rpcHost: str(o.rpcHost, "snapshot.rpcHost"),
    sample: sample(o.sample, "snapshot.sample"),
    headline: headline(o.headline, "snapshot.headline"),
    channelsPerPayer: { median: count(perPayer.median, "snapshot.channelsPerPayer.median"), max: count(perPayer.max, "snapshot.channelsPerPayer.max"), payers: count(perPayer.payers, "snapshot.channelsPerPayer.payers") },
    payToDegree: arr(o.payToDegree, "snapshot.payToDegree").map((d, i) => {
      const e = obj(d, `snapshot.payToDegree[${i}]`);
      return { payTo: truncated(e.payTo, `snapshot.payToDegree[${i}].payTo`), payers: count(e.payers, `snapshot.payToDegree[${i}].payers`), channels: count(e.channels, `snapshot.payToDegree[${i}].channels`) };
    }),
    payeeSeats: count(o.payeeSeats, "snapshot.payeeSeats"),
    settled: settled(o.settled, "snapshot.settled"),
    channelsPerWeek: arr(o.channelsPerWeek, "snapshot.channelsPerWeek").map((w, i) => {
      const e = obj(w, `snapshot.channelsPerWeek[${i}]`);
      return { week: date(e.week, `snapshot.channelsPerWeek[${i}].week`), channels: count(e.channels, `snapshot.channelsPerWeek[${i}].channels`) };
    }),
    instructions,
    channelsWithFeeRecipient: count(o.channelsWithFeeRecipient, "snapshot.channelsWithFeeRecipient"),
    sampleTrajectory: trajectory(o.sampleTrajectory, "snapshot.sampleTrajectory"),
    x402scan: {
      exactTransfers: x.exactTransfers === null ? null : count(x.exactTransfers, "snapshot.x402scan.exactTransfers"),
      source: str(x.source, "snapshot.x402scan.source"),
      note: str(x.note, "snapshot.x402scan.note"),
    },
  };
}

function optionalCount(o: Obj, key: string, path: string): number | undefined {
  return o[key] === undefined ? undefined : count(o[key], `${path}.${key}`);
}

/**
 * The headline of a snapshot, read from `headline` or, failing that, from the top level.
 * A snapshot without a relationship count or a sample size yields `undefined`: a number
 * without its sample size is not published (CLAUDE.md, Leakage dashboard).
 */
export function parseLeakHeadline(file: string, v: unknown): LeakHeadline | undefined {
  const o = obj(v, file);
  const h = o.headline === undefined ? o : obj(o.headline, `${file}.headline`);
  if (h.relationships === undefined || h.signaturesScanned === undefined) return undefined;
  const channels = optionalCount(h, "channels", file);
  const payers = optionalCount(h, "payers", file);
  const payTo = optionalCount(h, "payTo", file);
  return {
    file,
    date: str(o.date, `${file}.date`),
    relationships: count(h.relationships, `${file}.relationships`),
    signaturesScanned: count(h.signaturesScanned, `${file}.signaturesScanned`),
    ...(channels === undefined ? {} : { channels }),
    ...(payers === undefined ? {} : { payers }),
    ...(payTo === undefined ? {} : { payTo }),
  };
}

/** The latest snapshot by its dated file name, or undefined when there is none or none is usable. */
export function latestLeakHeadline(files: Readonly<Record<string, unknown>>): LeakHeadline | undefined {
  const dated = Object.keys(files)
    .filter((f) => /snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f))
    .sort();
  const last = dated.at(-1);
  return last === undefined ? undefined : parseLeakHeadline(last.slice(last.lastIndexOf("/") + 1), files[last]);
}
