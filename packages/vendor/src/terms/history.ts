// The per-buyer history a vendor keeps (briefing §3c, CLAUDE.md "Relationship terms").
// Keyed by `channelConfig.buyer`. It is this vendor's private state: never sent to the
// facilitator, never shared between vendors, never written to chain or to `clientRefId`.
// Fed by three things the vendor already sees: its own middleware's `/verify` outcomes
// (corrective 402s for a cumulative above the deposit, counted per period), the
// facilitator receipts the vendor reads (a redeemed period with nothing owed is a clean
// period) and a close or idle-close that left something owed after the grace period.
import { mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { decodeBase58Exact, parseU64, SCHEME_ERROR_CODES } from "@wakeless/scheme";
import { capitalOf, type Incident, type IncidentKind } from "./policy.js";

export const HISTORY_VERSION = 1;

/** Corrective 402s in one period from which `repeated_exceeds_deposit` opens. */
export const REPEATED_EXCEEDS_THRESHOLD = 3;

/** The period a buyer's channel is in: what the middleware has refused since the last redemption. */
export interface OpenPeriod {
  readonly channelId: string;
  readonly corrective402s: number;
  /** Set once the period's incident has opened, so it opens once. */
  readonly incidentOpened: boolean;
}

export interface BuyerHistory {
  readonly buyer: string;
  /** Redeemed periods with nothing left owed. Capital is `capitalOf(cleanPeriods)`. */
  readonly cleanPeriods: number;
  /** Incidents stay active in v1; there is no rehabilitation (briefing §3c). */
  readonly incidents: readonly Incident[];
  /** Channels this buyer has paid through, newest last. */
  readonly channels: readonly string[];
  readonly period?: OpenPeriod;
  readonly firstSeenAt: string;
  readonly updatedAt: string;
}

export interface HistoryFile {
  readonly version: typeof HISTORY_VERSION;
  readonly buyers: Readonly<Record<string, BuyerHistory>>;
}

export interface RedeemedPeriod {
  readonly channelId: string;
  /** The buyer when the caller knows it; otherwise the store looks the channel up from what the middleware saw. */
  readonly buyer?: string;
  readonly period: number;
  /** `accepted - settled` once the period's transfer landed, atomic units. */
  readonly owed: bigint;
}

export interface ClosedChannel {
  readonly channelId: string;
  readonly buyer?: string;
  /** What the buyer still owed when the channel closed or idle-closed, atomic units. */
  readonly owed: bigint;
  /** Whether the grace period (`withdrawDelay`) had passed when the owed amount was read. */
  readonly afterGrace: boolean;
}

/** What the vendor's history store does. Implementations differ only in where the file lives. */
export interface TermsHistoryStore {
  get(buyer: string): BuyerHistory | undefined;
  /** The middleware saw a payment from `buyer` through `channelId`. */
  seen(buyer: string, channelId: string): void;
  /** The middleware answered `buyer` a corrective 402 for a cumulative above the deposit. */
  corrective(buyer: string, channelId: string): void;
  /** A facilitator receipt: a redeemed period. Clean when nothing is owed. */
  redeemed(event: RedeemedPeriod): BuyerHistory | undefined;
  /** A channel closed or idle-closed. An incident when something was owed after the grace period. */
  closed(event: ClosedChannel): BuyerHistory | undefined;
  /** The buyer of a channel, from what the middleware saw. */
  buyerOf(channelId: string): string | undefined;
  snapshot(): HistoryFile;
}

/** The incidents that count today. In v1 every incident counts: none retires. */
export function activeIncidents(history: BuyerHistory | undefined): readonly Incident[] {
  return history === undefined ? [] : history.incidents;
}

export function capitalBpsOf(history: BuyerHistory | undefined): number {
  return history === undefined ? 0 : capitalOf(history.cleanPeriods);
}

/** `abcd…wxyz`: how a channel or buyer is named on a receipt's evidence line. */
export function shortId(value: string): string {
  return value.length <= 9 ? value : `${value.slice(0, 4)}…${value.slice(-4)}`;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  return decodeBase58Exact(value, 32) !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isIso(value: unknown): value is string {
  return typeof value === "string" && !Number.isNaN(Date.parse(value));
}

const KINDS: ReadonlySet<string> = new Set<IncidentKind>(["close_with_unpaid", "repeated_exceeds_deposit"]);

/** The history file from untrusted JSON. Throws on any other shape: a vendor's own file that does not parse is a fault, not a default. */
export function parseHistoryFile(json: unknown): HistoryFile {
  if (!isRecord(json) || json.version !== HISTORY_VERSION || !isRecord(json.buyers)) throw new Error(`terms history: not a version ${HISTORY_VERSION} history file`);
  const buyers: Record<string, BuyerHistory> = {};
  for (const [key, raw] of Object.entries(json.buyers)) {
    if (!isAddress(key) || !isRecord(raw) || raw.buyer !== key) throw new Error("terms history: a buyer entry is not keyed by its address");
    if (!isCount(raw.cleanPeriods) || !Array.isArray(raw.incidents) || !Array.isArray(raw.channels)) throw new Error(`terms history: buyer ${shortId(key)} is malformed`);
    if (!isIso(raw.firstSeenAt) || !isIso(raw.updatedAt)) throw new Error(`terms history: buyer ${shortId(key)} has no times`);
    const incidents = raw.incidents.map((i: unknown): Incident => {
      if (!isRecord(i) || typeof i.kind !== "string" || !KINDS.has(i.kind) || typeof i.evidence !== "string" || !isIso(i.at)) throw new Error(`terms history: buyer ${shortId(key)} has a malformed incident`);
      return { kind: i.kind as IncidentKind, evidence: i.evidence, at: i.at };
    });
    const channels = raw.channels.map((c: unknown) => {
      if (!isAddress(c)) throw new Error(`terms history: buyer ${shortId(key)} names a malformed channel`);
      return c;
    });
    let period: OpenPeriod | undefined;
    if (raw.period !== undefined) {
      if (!isRecord(raw.period) || !isAddress(raw.period.channelId) || !isCount(raw.period.corrective402s) || typeof raw.period.incidentOpened !== "boolean") {
        throw new Error(`terms history: buyer ${shortId(key)} has a malformed open period`);
      }
      period = { channelId: raw.period.channelId, corrective402s: raw.period.corrective402s, incidentOpened: raw.period.incidentOpened };
    }
    buyers[key] = { buyer: key, cleanPeriods: raw.cleanPeriods, incidents, channels, ...(period === undefined ? {} : { period }), firstSeenAt: raw.firstSeenAt, updatedAt: raw.updatedAt };
  }
  return { version: HISTORY_VERSION, buyers };
}

/** `owed` as a decimal u64 string, for evidence lines. */
function owedText(owed: bigint): string {
  const parsed = parseU64(owed.toString(), "owed", SCHEME_ERROR_CODES.invalidPayload);
  if (!parsed.ok) throw new RangeError("owed must be a u64");
  return owed.toString();
}

/**
 * The in-memory store. `persist` is called after every change with the whole file; the
 * file store passes a writer, tests pass nothing.
 */
export class MemoryTermsHistory implements TermsHistoryStore {
  private readonly buyers = new Map<string, BuyerHistory>();
  private readonly channelBuyer = new Map<string, string>();

  constructor(
    initial?: HistoryFile,
    private readonly persist: (file: HistoryFile) => void = () => undefined,
    private readonly now: () => Date = () => new Date(),
  ) {
    if (initial !== undefined) {
      for (const history of Object.values(initial.buyers)) {
        this.buyers.set(history.buyer, history);
        for (const channelId of history.channels) this.channelBuyer.set(channelId, history.buyer);
      }
    }
  }

  get(buyer: string): BuyerHistory | undefined {
    return this.buyers.get(buyer);
  }

  buyerOf(channelId: string): string | undefined {
    return this.channelBuyer.get(channelId);
  }

  snapshot(): HistoryFile {
    return { version: HISTORY_VERSION, buyers: Object.fromEntries([...this.buyers.entries()].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))) };
  }

  private put(history: BuyerHistory): BuyerHistory {
    const updated = { ...history, updatedAt: this.now().toISOString() };
    this.buyers.set(updated.buyer, updated);
    for (const channelId of updated.channels) this.channelBuyer.set(channelId, updated.buyer);
    this.persist(this.snapshot());
    return updated;
  }

  private known(buyer: string, channelId: string): BuyerHistory {
    if (!isAddress(buyer)) throw new Error("terms history: buyer must be a 32-byte base58 address");
    if (!isAddress(channelId)) throw new Error("terms history: channelId must be a 32-byte base58 id");
    const at = this.now().toISOString();
    const current = this.buyers.get(buyer) ?? { buyer, cleanPeriods: 0, incidents: [], channels: [], firstSeenAt: at, updatedAt: at };
    return current.channels.includes(channelId) ? current : { ...current, channels: [...current.channels, channelId] };
  }

  seen(buyer: string, channelId: string): void {
    const before = this.buyers.get(buyer);
    const history = this.known(buyer, channelId);
    if (before !== history) this.put(history);
  }

  corrective(buyer: string, channelId: string): void {
    const history = this.known(buyer, channelId);
    const period: OpenPeriod = history.period?.channelId === channelId ? history.period : { channelId, corrective402s: 0, incidentOpened: false };
    const corrective402s = period.corrective402s + 1;
    let incidents = history.incidents;
    let incidentOpened = period.incidentOpened;
    if (!incidentOpened && corrective402s >= REPEATED_EXCEEDS_THRESHOLD) {
      incidentOpened = true;
      incidents = [...incidents, { kind: "repeated_exceeds_deposit", evidence: `${corrective402s} corrective 402s in one period of channel ${shortId(channelId)}`, at: this.now().toISOString() }];
    }
    this.put({ ...history, incidents, period: { channelId, corrective402s, incidentOpened } });
  }

  private resolve(event: { channelId: string; buyer?: string }): string | undefined {
    return event.buyer ?? this.channelBuyer.get(event.channelId);
  }

  redeemed(event: RedeemedPeriod): BuyerHistory | undefined {
    const buyer = this.resolve(event);
    if (buyer === undefined) return undefined;
    if (!Number.isSafeInteger(event.period) || event.period < 1) throw new RangeError("period must be a positive integer");
    const history = this.known(buyer, event.channelId);
    const { period: _closedPeriod, ...rest } = history;
    void _closedPeriod;
    // The period ends with its redemption: the corrective count starts again. An incident it opened stays.
    const clean = owedText(event.owed) === "0";
    return this.put({ ...rest, cleanPeriods: clean ? history.cleanPeriods + 1 : history.cleanPeriods });
  }

  closed(event: ClosedChannel): BuyerHistory | undefined {
    const buyer = this.resolve(event);
    if (buyer === undefined) return undefined;
    const history = this.known(buyer, event.channelId);
    const { period: _closedPeriod, ...rest } = history;
    void _closedPeriod;
    const owed = owedText(event.owed);
    if (owed === "0" || !event.afterGrace) return this.put(rest);
    const incident: Incident = { kind: "close_with_unpaid", evidence: `channel ${shortId(event.channelId)} closed owing ${owed} after the grace period`, at: this.now().toISOString() };
    return this.put({ ...rest, incidents: [...rest.incidents, incident] });
  }
}

/**
 * The store on disk: one JSON file, mode 0600, written whole and atomically (temp file,
 * then rename), in the shape `{version, buyers}`. A missing file is an empty history; a
 * file that does not parse throws, so a vendor never silently quotes from nothing.
 */
export class FileTermsHistory extends MemoryTermsHistory {
  constructor(
    readonly path: string,
    now?: () => Date,
  ) {
    super(
      readHistoryFile(path),
      (file) => {
        mkdirSync(dirname(path), { recursive: true, mode: 0o700 });
        const temp = `${path}.${process.pid}.tmp`;
        writeFileSync(temp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
        renameSync(temp, path);
      },
      now,
    );
  }
}

export function readHistoryFile(path: string): HistoryFile | undefined {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
  return parseHistoryFile(JSON.parse(text));
}
