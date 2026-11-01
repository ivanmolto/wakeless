import {
  SCHEME_ERROR_CODES,
  decodeBase58Exact,
  isChannelId,
  parseBatchVoucher,
  parseU64,
  type BatchVoucher,
} from "@wakeless/scheme";
import {
  StoreError,
  type ChannelLifecycle,
  type ChannelRecord,
  type JsonObject,
  type OperationRecord,
  type OperationStatus,
  type OperationType,
  type StoreErrorCode,
} from "./types.js";

/**
 * Records as JSON, amounts as decimal u64 strings. Every record passes through
 * one validator on the way in (`invalid_record`) and on the way out
 * (`corrupt_record`). Errors name the field, never its value: these records hold
 * voucher signatures and channel amounts.
 */

const CHANNEL_STATES: readonly ChannelLifecycle[] = ["open", "closing", "closed"];
const OPERATION_TYPES: readonly OperationType[] = ["deposit", "claim", "settle", "refund"];
const OPERATION_STATUSES: readonly OperationStatus[] = ["pending", "confirmed", "failed", "rejected"];

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isText(value: unknown): value is string {
  return typeof value === "string" && value.length > 0;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isOneOf<T extends string>(allowed: readonly T[], value: unknown): value is T {
  return allowed.includes(value as T);
}

class Reader {
  constructor(
    private readonly code: StoreErrorCode,
    private readonly what: string,
    private readonly source: Record<string, unknown>,
  ) {}

  fail(field: string): StoreError {
    return new StoreError(this.code, `${this.what}: field ${field} is invalid`);
  }

  check<T>(field: string, guard: (value: unknown) => value is T): T {
    const value = this.source[field];
    if (!guard(value)) throw this.fail(field);
    return value;
  }

  u64(field: string): bigint {
    const parsed = parseU64(this.source[field], field, SCHEME_ERROR_CODES.invalidPayload);
    if (!parsed.ok) throw this.fail(field);
    return parsed.value;
  }
}

function readChannel(code: StoreErrorCode, wire: unknown): ChannelRecord {
  if (!isObject(wire)) throw new StoreError(code, "channel: not an object");
  const read = new Reader(code, "channel", wire);
  const channelId = read.check("channelId", isChannelId);
  read.u64("clientRef");

  let latestVoucher: BatchVoucher | null = null;
  if (wire.latestVoucher !== null) {
    const parsed = parseBatchVoucher(wire.latestVoucher);
    if (!parsed.ok || parsed.value.channelId !== channelId) throw read.fail("latestVoucher");
    latestVoucher = parsed.value;
  }

  return {
    channelId,
    clientRef: wire.clientRef as string,
    buyer: read.check("buyer", isText),
    vendor: read.check("vendor", isText),
    mint: read.check("mint", isText),
    deposit: read.u64("deposit"),
    settled: read.u64("settled"),
    accepted: read.u64("accepted"),
    latestVoucher,
    state: read.check("state", (value): value is ChannelLifecycle => isOneOf(CHANNEL_STATES, value)),
    lastActivityAt: read.check("lastActivityAt", isCount),
  };
}

function readOperation(code: StoreErrorCode, wire: unknown): OperationRecord {
  if (!isObject(wire)) throw new StoreError(code, "operation: not an object");
  const read = new Reader(code, "operation", wire);
  const isJsonObject = (value: unknown): value is JsonObject => isObject(value);
  const isSignature = (value: unknown): value is string => decodeBase58Exact(value, 64) !== null;
  return {
    opId: read.check("opId", isText),
    channelId: read.check("channelId", isChannelId),
    type: read.check("type", (value): value is OperationType => isOneOf(OPERATION_TYPES, value)),
    payload: read.check("payload", isJsonObject),
    status: read.check("status", (value): value is OperationStatus => isOneOf(OPERATION_STATUSES, value)),
    ...(wire.signature !== undefined ? { signature: read.check("signature", isSignature) } : {}),
    ...(wire.receipt !== undefined ? { receipt: read.check("receipt", isJsonObject) } : {}),
    attempts: read.check("attempts", isCount),
  };
}

/** `JSON.stringify` writes a bigint as nothing it can: amounts become decimal strings first. */
function stringify(what: string, wire: unknown): string {
  try {
    return JSON.stringify(wire);
  } catch {
    throw new StoreError("invalid_record", `${what}: not JSON-serialisable`);
  }
}

function parse(what: string, raw: string): unknown {
  try {
    return JSON.parse(raw);
  } catch {
    throw new StoreError("corrupt_record", `${what}: not JSON`);
  }
}

/** Throws `invalid_record` when the record is malformed or is not the channel `channelId`. */
export function encodeChannel(channelId: string, record: ChannelRecord): string {
  if (!isObject(record)) throw new StoreError("invalid_record", "channel: not an object");
  if (record.channelId !== channelId) throw new StoreError("invalid_record", "channel: field channelId is invalid");
  const amount = (value: unknown): unknown => (typeof value === "bigint" ? value.toString() : value);
  const wire = {
    channelId: record.channelId,
    clientRef: record.clientRef,
    buyer: record.buyer,
    vendor: record.vendor,
    mint: record.mint,
    deposit: amount(record.deposit),
    settled: amount(record.settled),
    accepted: amount(record.accepted),
    latestVoucher: record.latestVoucher,
    state: record.state,
    lastActivityAt: record.lastActivityAt,
  };
  readChannel("invalid_record", wire);
  return stringify("channel", wire);
}

export function decodeChannel(raw: string): ChannelRecord {
  return readChannel("corrupt_record", parse("channel", raw));
}

export function encodeOperation(record: OperationRecord): string {
  const encoded = stringify("operation", record);
  readOperation("invalid_record", JSON.parse(encoded));
  return encoded;
}

export function decodeOperation(raw: string): OperationRecord {
  return readOperation("corrupt_record", parse("operation", raw));
}
