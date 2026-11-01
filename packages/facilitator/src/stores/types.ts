import type { BatchVoucher } from "@wakeless/scheme";

/**
 * The facilitator's two stores, modelled on `ChannelStore` and
 * `BatchOperationStore` in `@x402/svm`'s batch-settlement server
 * (`typescript/packages/mechanisms/svm/src/batch-settlement/server/`). Same
 * shape: `get`, `list`, `put`, a per-channel `update`, and an operation
 * `reserve` that returns an existing record unchanged. The operation record
 * is Wakeless's: claim, settle and refund work, not x402's request ids.
 */

export type ChannelLifecycle = "open" | "closing" | "closed";

export interface ChannelRecord {
  /** Base58, decodes to 32 bytes (`deriveChannelId`). */
  readonly channelId: string;
  /** `clientRefOf(channelId)`, decimal u64. */
  readonly clientRef: string;
  readonly buyer: string;
  readonly vendor: string;
  readonly mint: string;
  /** Confirmed private deposit, base units, u64. */
  readonly deposit: bigint;
  /** Cumulative redeemed to the vendor, base units, u64. */
  readonly settled: bigint;
  /** The watermark: highest accepted voucher cumulative, base units, u64. */
  readonly accepted: bigint;
  readonly latestVoucher: BatchVoucher | null;
  readonly state: ChannelLifecycle;
  /** Unix seconds. */
  readonly lastActivityAt: number;
}

/**
 * Receives the channel as stored and returns what to store. To refuse a change
 * without an error, return `current`; to abort, throw, and nothing is written.
 *
 * May run more than once: the Redis store re-runs it when another process wrote
 * the channel first. Keep it free of side effects (`nextWatermark` is).
 * It must not call `update` on the same store and channel: that call would wait
 * for this one.
 */
export type ChannelUpdater = (current: ChannelRecord | undefined) => ChannelRecord | Promise<ChannelRecord>;

export interface ChannelStore {
  get(channelId: string): Promise<ChannelRecord | undefined>;
  /** Every channel held. A weakly consistent snapshot, for the redemption worker. */
  list(): Promise<ChannelRecord[]>;
  /** Insert or overwrite, in turn with any `update` on that channel. */
  put(record: ChannelRecord): Promise<void>;
  /** Atomic read-modify-write of one channel. Returns the record as stored. */
  update(channelId: string, updater: ChannelUpdater): Promise<ChannelRecord>;
}

export type JsonValue = string | number | boolean | null | JsonValue[] | { [key: string]: JsonValue };
export type JsonObject = { [key: string]: JsonValue };

export type OperationType = "claim" | "settle" | "refund";

/**
 * `pending` to `confirmed`, `failed` or `rejected`; `failed` back to `pending`
 * for another attempt. `confirmed` and `rejected` are terminal: a rejected
 * private transfer is never retried (`CLAUDE.md`, Privacy rules).
 *
 * `pending` means a transfer may be in flight. A worker moves an operation to
 * `pending` before it calls the binding, and at startup reconciles every
 * `pending` operation against the binding before sending anything. `failed` is
 * at rest, the only state a retry starts from.
 */
export type OperationStatus = "pending" | "confirmed" | "failed" | "rejected";

export interface OperationRecord {
  readonly opId: string;
  readonly channelId: string;
  readonly type: OperationType;
  readonly payload: JsonObject;
  readonly status: OperationStatus;
  /** Base58 transaction signature, once there is one. */
  readonly signature?: string;
  readonly receipt?: JsonObject;
  /** How many times this operation has failed. */
  readonly attempts: number;
}

export type NewOperation = Pick<OperationRecord, "opId" | "channelId" | "type" | "payload">;

export interface OperationChange {
  readonly status: OperationStatus;
  readonly signature?: string;
  readonly receipt?: JsonObject;
}

export interface BatchOperationStore {
  get(channelId: string, opId: string): Promise<OperationRecord | undefined>;
  list(channelId: string): Promise<OperationRecord[]>;
  /**
   * Atomically create a `pending` operation unless the id exists on the channel.
   * An existing operation is returned unchanged, whatever its status.
   */
  reserve(operation: NewOperation): Promise<{ created: boolean; operation: OperationRecord }>;
  /**
   * Atomically move an operation along its lifecycle. Entering `failed` adds one
   * to `attempts`. Throws `illegal_transition` or `unknown_operation`.
   */
  transition(channelId: string, opId: string, change: OperationChange): Promise<OperationRecord>;
}

export interface Stores {
  readonly channels: ChannelStore;
  readonly operations: BatchOperationStore;
  close(): Promise<void>;
}

export type StoreErrorCode =
  | "invalid_record"
  | "corrupt_record"
  | "unknown_operation"
  | "illegal_transition"
  | "write_conflict";

/** Messages name fields, ids and statuses; never an amount or a signature. */
export class StoreError extends Error {
  readonly code: StoreErrorCode;

  constructor(code: StoreErrorCode, message: string) {
    super(message);
    this.name = "StoreError";
    this.code = code;
  }
}
