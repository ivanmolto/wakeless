// The buyer's local channel state: one JSON file, mode 0600, under ~/.wakeless/ by
// default. It is the owner's view (`packages/watcher/src/owner.ts` reads it later):
// which channels this buyer holds, their watermark and deposit as last confirmed, a
// deposit made but not yet credited, and the trajectory of paid requests. No key
// material, no tokens. Writes are whole-file and atomic (temp file, then rename).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { CLIENT_ERROR_CODES, WakelessClientError } from "./errors.js";

export const STORE_VERSION = 1;

/** A deposit this buyer made whose crediting the facilitator has not confirmed; resent, never remade. */
export interface PendingDeposit {
  /** Atomic units, decimal u64 string. */
  readonly amount: string;
  /** The private transfer's signature (`DepositPayload.depositSignature`). */
  readonly signature: string;
  /** The client-signed transfer, base64 wire format (`DepositPayload.deposit.transaction`). */
  readonly transaction: string;
}

export interface LocalChannel {
  readonly buyer: string;
  readonly vendor: string;
  readonly mint: string;
  readonly escrowAddress: string;
  readonly network: string;
  /** Decimal u64 string; with buyer, escrow and mint it derives `channelId`. */
  readonly salt: string;
  readonly channelId: string;
  /** Confirmed deposit, atomic units, decimal u64 string. */
  readonly deposit: string;
  /** The last cumulative the facilitator accepted (the watermark), decimal u64 string. */
  readonly accepted: string;
  readonly pendingDeposit?: PendingDeposit;
  /** ISO 8601. */
  readonly createdAt: string;
  readonly updatedAt: string;
}

/** One paid request, as `getTrajectory()` returns it. `amount` is the price the vendor nets; `cumulative` includes the fee shares. */
export interface TrajectoryEntry {
  readonly vendor: string;
  /** The request's path. */
  readonly route: string;
  readonly amount: string;
  readonly cumulative: string;
  /** ISO 8601. */
  readonly timestamp: string;
  readonly fundingSource?: string;
  /** Set when this request carried a deposit (an opening or a top-up): its amount. */
  readonly deposit?: string;
  /**
   * With `deposit`: the private transfer's signature, kept so the watcher can run its
   * four checks on a recorded run later. Owner's file only; a published trajectory
   * strips it (`scripts/agent-run.ts`), and it never reaches a log line.
   */
  readonly depositSignature?: string;
}

interface StoreFile {
  readonly version: typeof STORE_VERSION;
  readonly channels: Record<string, LocalChannel>;
  readonly trajectory: TrajectoryEntry[];
}

export function defaultStorePath(): string {
  return join(homedir(), ".wakeless", "channels.json");
}

function channelKey(buyer: string, vendor: string, mint: string): string {
  return `${buyer}:${vendor}:${mint}`;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const U64 = /^(0|[1-9][0-9]*)$/;

function isChannel(value: unknown): value is LocalChannel {
  if (!isObject(value)) return false;
  for (const key of ["buyer", "vendor", "mint", "escrowAddress", "network", "salt", "channelId", "createdAt", "updatedAt"] as const) {
    if (typeof value[key] !== "string") return false;
  }
  if (typeof value.deposit !== "string" || !U64.test(value.deposit) || typeof value.accepted !== "string" || !U64.test(value.accepted)) return false;
  const pending = value.pendingDeposit;
  if (pending !== undefined) {
    if (!isObject(pending) || typeof pending.amount !== "string" || !U64.test(pending.amount) || typeof pending.signature !== "string" || typeof pending.transaction !== "string") return false;
  }
  return true;
}

function isEntry(value: unknown): value is TrajectoryEntry {
  if (!isObject(value) || typeof value.vendor !== "string" || typeof value.route !== "string" || typeof value.amount !== "string" || typeof value.cumulative !== "string" || typeof value.timestamp !== "string") return false;
  if (value.depositSignature !== undefined && (typeof value.depositSignature !== "string" || value.deposit === undefined)) return false;
  return true;
}

function unreadable(reason: string): WakelessClientError {
  return new WakelessClientError(CLIENT_ERROR_CODES.storeUnreadable, `the local channel file ${reason}; move it aside to start afresh (its channels would be forgotten, not closed)`);
}

/** Reads the whole file, or an empty store when there is none. A file that is not this format is refused, never overwritten. */
function read(path: string): StoreFile {
  if (!existsSync(path)) return { version: STORE_VERSION, channels: {}, trajectory: [] };
  let parsed: unknown;
  try {
    parsed = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw unreadable("is not JSON");
  }
  if (!isObject(parsed) || parsed.version !== STORE_VERSION || !isObject(parsed.channels) || !Array.isArray(parsed.trajectory)) {
    throw unreadable("is not a version 1 channel file");
  }
  for (const channel of Object.values(parsed.channels)) if (!isChannel(channel)) throw unreadable("holds a channel record this client cannot read");
  for (const entry of parsed.trajectory) if (!isEntry(entry)) throw unreadable("holds a trajectory entry this client cannot read");
  return parsed as unknown as StoreFile;
}

/** Whole file, mode 0600, through a temp file in the same directory. The directory is created 0700 when missing. */
function write(path: string, file: StoreFile): void {
  const dir = dirname(path);
  if (!existsSync(dir)) mkdirSync(dir, { recursive: true, mode: 0o700 });
  const tmp = `${path}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(file, null, 2) + "\n", { mode: 0o600 });
  // `mode` on creation is subject to the umask; make it 0600 regardless.
  chmodSync(tmp, 0o600);
  renameSync(tmp, path);
  if ((statSync(path).mode & 0o777) !== 0o600) chmodSync(path, 0o600);
}

/**
 * The channel file as an object. Every method re-reads the file, so two wrappers in
 * one process see each other's writes; two processes do not coordinate (v1 runs
 * one buyer process, the MCP server or a script).
 */
export class LocalChannelStore {
  constructor(readonly path: string = defaultStorePath()) {}

  get(buyer: string, vendor: string, mint: string): LocalChannel | undefined {
    return read(this.path).channels[channelKey(buyer, vendor, mint)];
  }

  put(channel: LocalChannel): void {
    const file = read(this.path);
    file.channels[channelKey(channel.buyer, channel.vendor, channel.mint)] = channel;
    write(this.path, file);
  }

  /** The channels this buyer holds. */
  channels(buyer: string): readonly LocalChannel[] {
    return Object.values(read(this.path).channels).filter((c) => c.buyer === buyer);
  }

  appendTrajectory(entry: TrajectoryEntry): void {
    const file = read(this.path);
    file.trajectory.push(entry);
    write(this.path, file);
  }

  trajectory(): readonly TrajectoryEntry[] {
    return read(this.path).trajectory;
  }
}
