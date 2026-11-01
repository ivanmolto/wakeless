// The owner's spend caps: one per payment and one over a rolling 24 hours, both in
// USDC atomic units, checked by the client's `beforePayment` hook before any deposit is
// made or voucher signed. The ledger of approved charges lives in one JSON file, mode
// 0600, next to the channel file, so a restart of the MCP server does not reset the day.
// A charge is recorded when it is approved: a request the vendor then fails to serve
// still counts for the day (nothing was charged, but the day is bounded by what the
// agent asked for, conservatively).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export const USDC_DECIMALS = 6;
/** 0.05 USDC. */
export const DEFAULT_PER_PAYMENT = 50_000n;
/** 1 USDC. */
export const DEFAULT_PER_DAY = 1_000_000n;
export const DAY_MS = 24 * 60 * 60 * 1000;
export const BUDGET_VERSION = 1;

/** A spend the caps refuse. Nothing was signed or sent. */
export const BUDGET_EXCEEDED = "shielded_mcp_budget_exceeded";

export class BudgetRefusedError extends Error {
  readonly code = BUDGET_EXCEEDED;
  constructor(message: string) {
    super(message);
    this.name = "BudgetRefusedError";
  }
}

export interface BudgetLimits {
  /** The most one request may charge, atomic units. */
  readonly perPayment: bigint;
  /** The most all requests may charge in any 24 hours, atomic units. */
  readonly perDay: bigint;
}

interface Entry {
  /** Unix milliseconds. */
  readonly at: number;
  /** Atomic units, decimal string. */
  readonly charge: string;
}

interface BudgetFile {
  readonly version: typeof BUDGET_VERSION;
  readonly limits?: { readonly perPayment: string; readonly perDay: string };
  readonly entries: Entry[];
}

export interface BudgetStatus {
  readonly limits: { readonly perPayment: string; readonly perDay: string };
  readonly last24h: {
    readonly spent: string;
    readonly remaining: string;
    readonly payments: number;
    /** When the oldest charge in the window leaves it, ISO 8601; absent when the window is empty. */
    readonly oldestExpiresAt?: string;
  };
}

export interface BudgetOptions {
  /** The ledger file. Default `~/.wakeless/mcp-budget.json`; `null` keeps the ledger in memory only (tests). */
  readonly path?: string | null;
  /** Starting caps, used when the file records none. Defaults 0.05 and 1 USDC. */
  readonly limits?: Partial<BudgetLimits>;
  /** Unix milliseconds. Tests inject it. */
  readonly now?: () => number;
}

export function defaultBudgetPath(): string {
  return join(homedir(), ".wakeless", "mcp-budget.json");
}

const DECIMAL = /^(0|[1-9][0-9]*)(?:\.([0-9]{1,6}))?$/;
const U64 = /^(0|[1-9][0-9]*)$/;

/**
 * A USDC amount as the owner writes it ("0.05", 0.05, "1") to atomic units, exactly:
 * at most six decimals, positive, no exponent. Numbers go through their shortest decimal
 * form, so `0.05` is 50000 and `1e-7` is refused.
 */
export function parseUsdc(input: unknown, name: string): bigint {
  const text = typeof input === "number" ? (Number.isFinite(input) ? String(input) : "") : typeof input === "string" ? input.trim() : "";
  const match = DECIMAL.exec(text);
  if (match === null) throw new RangeError(`${name} must be a USDC amount with at most six decimals, like "0.05"`);
  const whole = BigInt(match[1]!);
  if (whole > 1_000_000_000n) throw new RangeError(`${name} is implausibly large for a cap`);
  const fraction = (match[2] ?? "").padEnd(USDC_DECIMALS, "0");
  const atomic = whole * 10n ** BigInt(USDC_DECIMALS) + BigInt(fraction);
  if (atomic <= 0n) throw new RangeError(`${name} must be above zero`);
  return atomic;
}

/** Atomic units to a USDC string without trailing zeros: 50000 is "0.05", 1000000 is "1". */
export function formatUsdc(atomic: bigint): string {
  const negative = atomic < 0n;
  const abs = negative ? -atomic : atomic;
  const unit = 10n ** BigInt(USDC_DECIMALS);
  const whole = abs / unit;
  const fraction = (abs % unit).toString().padStart(USDC_DECIMALS, "0").replace(/0+$/, "");
  return `${negative ? "-" : ""}${whole}${fraction === "" ? "" : `.${fraction}`}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isEntry(value: unknown): value is Entry {
  return isObject(value) && typeof value.at === "number" && Number.isFinite(value.at) && typeof value.charge === "string" && U64.test(value.charge);
}

function readFile(path: string): BudgetFile {
  if (!existsSync(path)) return { version: BUDGET_VERSION, entries: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error("the budget file is not JSON; move it aside to start afresh (the day's spend would be forgotten)");
  }
  if (!isObject(parsed) || parsed.version !== BUDGET_VERSION || !Array.isArray(parsed.entries) || !parsed.entries.every(isEntry)) {
    throw new Error("the budget file is not a version 1 budget file; move it aside to start afresh");
  }
  const limits = parsed.limits;
  if (limits !== undefined && (!isObject(limits) || typeof limits.perPayment !== "string" || !U64.test(limits.perPayment) || typeof limits.perDay !== "string" || !U64.test(limits.perDay))) {
    throw new Error("the budget file holds limits this server cannot read; move it aside to start afresh");
  }
  return parsed as unknown as BudgetFile;
}

/** Whole file, mode 0600, through a temp file and rename; the directory is created 0700. */
function writeFile(path: string, file: BudgetFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

export class Budget {
  private readonly path: string | null;
  private readonly now: () => number;
  private readonly defaults: BudgetLimits;
  private memory: BudgetFile;

  constructor(options: BudgetOptions = {}) {
    this.path = options.path === undefined ? defaultBudgetPath() : options.path;
    this.now = options.now ?? (() => Date.now());
    this.defaults = { perPayment: options.limits?.perPayment ?? DEFAULT_PER_PAYMENT, perDay: options.limits?.perDay ?? DEFAULT_PER_DAY };
    if (this.defaults.perPayment <= 0n || this.defaults.perDay <= 0n) throw new RangeError("caps must be above zero");
    this.memory = { version: BUDGET_VERSION, entries: [] };
    // Read once at construction so an unreadable file fails the start, not the first payment.
    this.read();
  }

  private read(): BudgetFile {
    if (this.path === null) return this.memory;
    return readFile(this.path);
  }

  /** Drops entries that have left the window before writing. */
  private write(file: BudgetFile): void {
    const since = this.now() - DAY_MS;
    const pruned: BudgetFile = { ...file, entries: file.entries.filter((e) => e.at > since) };
    if (this.path === null) this.memory = pruned;
    else writeFile(this.path, pruned);
  }

  limits(): BudgetLimits {
    const stored = this.read().limits;
    return stored === undefined ? this.defaults : { perPayment: BigInt(stored.perPayment), perDay: BigInt(stored.perDay) };
  }

  /** Sets either cap or both; persists with the ledger. */
  setLimits(change: Partial<BudgetLimits>): BudgetLimits {
    const current = this.limits();
    const next: BudgetLimits = { perPayment: change.perPayment ?? current.perPayment, perDay: change.perDay ?? current.perDay };
    if (next.perPayment <= 0n || next.perDay <= 0n) throw new RangeError("caps must be above zero");
    const file = this.read();
    this.write({ ...file, limits: { perPayment: next.perPayment.toString(), perDay: next.perDay.toString() } });
    return next;
  }

  private window(): Entry[] {
    const since = this.now() - DAY_MS;
    return this.read().entries.filter((e) => e.at > since);
  }

  /** Charges approved in the last 24 hours, atomic units. */
  spentInWindow(): bigint {
    return this.window().reduce((sum, e) => sum + BigInt(e.charge), 0n);
  }

  /** Throws `BudgetRefusedError` with the reason when `charge` would break a cap. Records nothing. */
  check(charge: bigint): void {
    if (charge <= 0n) throw new RangeError("charge must be above zero");
    const { perPayment, perDay } = this.limits();
    if (charge > perPayment) {
      throw new BudgetRefusedError(
        `refused: this request would charge ${formatUsdc(charge)} USDC, above the per-payment cap of ${formatUsdc(perPayment)} USDC. Nothing was signed. If this is intended, raise the cap with set_limits({ perPayment }).`,
      );
    }
    const window = this.window();
    const spent = window.reduce((sum, e) => sum + BigInt(e.charge), 0n);
    if (spent + charge > perDay) {
      const oldest = window.reduce((min, e) => Math.min(min, e.at), Number.POSITIVE_INFINITY);
      const frees = Number.isFinite(oldest) ? ` The window frees up at ${new Date(oldest + DAY_MS).toISOString()}.` : "";
      throw new BudgetRefusedError(
        `refused: ${formatUsdc(spent)} USDC was charged in the last 24 hours and this request's ${formatUsdc(charge)} USDC would take it to ${formatUsdc(spent + charge)} USDC, above the daily cap of ${formatUsdc(perDay)} USDC. Nothing was signed.${frees} If this is intended, raise the cap with set_limits({ perDay }).`,
      );
    }
  }

  /** `check`, then records the charge at the current time. */
  reserve(charge: bigint): void {
    this.check(charge);
    const file = this.read();
    this.write({ ...file, entries: [...file.entries, { at: this.now(), charge: charge.toString() }] });
  }

  status(): BudgetStatus {
    const limits = this.limits();
    const window = this.window();
    const spent = window.reduce((sum, e) => sum + BigInt(e.charge), 0n);
    const remaining = limits.perDay > spent ? limits.perDay - spent : 0n;
    const oldest = window.reduce((min, e) => Math.min(min, e.at), Number.POSITIVE_INFINITY);
    return {
      limits: { perPayment: formatUsdc(limits.perPayment), perDay: formatUsdc(limits.perDay) },
      last24h: {
        spent: formatUsdc(spent),
        remaining: formatUsdc(remaining),
        payments: window.length,
        ...(Number.isFinite(oldest) ? { oldestExpiresAt: new Date(oldest + DAY_MS).toISOString() } : {}),
      },
    };
  }
}
