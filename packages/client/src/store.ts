// The buyer's local channel state: one JSON file, mode 0600, under ~/.wakeless/ by
// default. It is the owner's view (`packages/watcher/src/owner.ts` reads it later):
// which channels this buyer holds, their watermark and deposit as last confirmed, a
// deposit made but not yet credited, and the trajectory of paid requests. No key
// material, no tokens. Writes are whole-file and atomic (temp file, then rename).
import { chmodSync, existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import type { PaymentRequirements } from "@wakeless/scheme";
import { CLIENT_ERROR_CODES, WakelessClientError } from "./errors.js";
import { parseShieldedAccept } from "./parse.js";

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

/** The note the owner's view carries beside a withdrawal offer or a performed withdrawal (task 8.1). */
export const WITHDRAW_NOTE = "withdrawal is a public base-layer transaction: it names the buyer and the vault, and its amount is in clear";

/** Where a channel's close stands, as the facilitator last reported it (task 8.1). ISO 8601 times. */
export interface LocalChannelClose {
  readonly state: "closing" | "closed";
  readonly requestedAt: string;
  /** The vendor's latest voucher is accepted until then; the refund follows. */
  readonly refundAfter: string;
  /** The refund once confirmed: `deposit − settled`, and the private transfer's signature (null when the facilitator reconciled it without one). */
  readonly refund?: { readonly amount: string; readonly signature: string | null; readonly confirmedAt: string };
  /** The withdrawal to the buyer's base token account: offered after the refund, performed only when the owner says so. */
  readonly withdraw?: { readonly note: typeof WITHDRAW_NOTE; readonly offeredAt: string; readonly performed?: { readonly amount: string; readonly signature: string; readonly at: string } };
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
  /** The shielded accept this channel last paid under, kept so the buyer can close without a fresh 402. */
  readonly accept?: PaymentRequirements;
  readonly close?: LocalChannelClose;
}

/**
 * A channel funding through Aurora Confidential Intents (`wakeless fund`, task 8.3):
 * the origin chain, the amount that arrived (smallest units) and the Solana arrival
 * transaction. The arrival is public; the origin wallet and the route are not.
 */
export interface FundingSource {
  readonly originChain: string;
  readonly amount: string;
  readonly solanaArrivalSignature: string;
}

/**
 * One paid request, as `getTrajectory()` returns it. `amount` is the price the vendor nets;
 * `cumulative` includes the fee shares. A funding writes one entry too: `vendor: "aurora"`,
 * `route: "fund"`, `cumulative: "0"`, with the `FundingSource`.
 */
export interface TrajectoryEntry {
  readonly vendor: string;
  /** The request's path. */
  readonly route: string;
  readonly amount: string;
  readonly cumulative: string;
  /** ISO 8601. */
  readonly timestamp: string;
  readonly fundingSource?: string | FundingSource;
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

/** Records are keyed by channel id (a closed channel stays beside the one that replaced it); files written before task 8.1 keyed them `buyer:vendor:mint`, and both read alike. */
function channelKey(channel: LocalChannel): string {
  return channel.channelId;
}

function sameChannel(a: LocalChannel, b: LocalChannel): boolean {
  return a.channelId === b.channelId;
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
  if (value.accept !== undefined && parseShieldedAccept(value.accept) === undefined) return false;
  if (value.close !== undefined && !isClose(value.close)) return false;
  return true;
}

function isClose(value: unknown): value is LocalChannelClose {
  if (!isObject(value) || (value.state !== "closing" && value.state !== "closed") || typeof value.requestedAt !== "string" || typeof value.refundAfter !== "string") return false;
  const refund = value.refund;
  if (refund !== undefined) {
    if (!isObject(refund) || typeof refund.amount !== "string" || !U64.test(refund.amount) || (refund.signature !== null && typeof refund.signature !== "string") || typeof refund.confirmedAt !== "string") return false;
  }
  const withdraw = value.withdraw;
  if (withdraw !== undefined) {
    if (!isObject(withdraw) || withdraw.note !== WITHDRAW_NOTE || typeof withdraw.offeredAt !== "string") return false;
    const performed = withdraw.performed;
    if (performed !== undefined && (!isObject(performed) || typeof performed.amount !== "string" || !U64.test(performed.amount) || typeof performed.signature !== "string" || typeof performed.at !== "string")) return false;
  }
  return true;
}

function isEntry(value: unknown): value is TrajectoryEntry {
  if (!isObject(value) || typeof value.vendor !== "string" || typeof value.route !== "string" || typeof value.amount !== "string" || typeof value.cumulative !== "string" || typeof value.timestamp !== "string") return false;
  if (value.depositSignature !== undefined && (typeof value.depositSignature !== "string" || value.deposit === undefined)) return false;
  if (value.fundingSource !== undefined && typeof value.fundingSource !== "string" && !isFundingSource(value.fundingSource)) return false;
  return true;
}

function isFundingSource(value: unknown): value is FundingSource {
  return isObject(value) && typeof value.originChain === "string" && typeof value.amount === "string" && U64.test(value.amount) && typeof value.solanaArrivalSignature === "string";
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

  /** The channel to pay `vendor` with: the one not closing or closed, if any. */
  get(buyer: string, vendor: string, mint: string): LocalChannel | undefined {
    return Object.values(read(this.path).channels).find((c) => c.buyer === buyer && c.vendor === vendor && c.mint === mint && c.close === undefined);
  }

  put(channel: LocalChannel): void {
    const file = read(this.path);
    // Replace the record under whichever key it was written (an older file keyed by buyer:vendor:mint), else add it under its id.
    const existing = Object.entries(file.channels).find(([, c]) => sameChannel(c, channel));
    file.channels[existing === undefined ? channelKey(channel) : existing[0]] = channel;
    write(this.path, file);
  }

  /** The channels this buyer holds. */
  channels(buyer: string): readonly LocalChannel[] {
    return Object.values(read(this.path).channels).filter((c) => c.buyer === buyer);
  }

  /** One of this buyer's channels by id, open, closing or closed. */
  byId(buyer: string, channelId: string): LocalChannel | undefined {
    return this.channels(buyer).find((c) => c.channelId === channelId);
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
