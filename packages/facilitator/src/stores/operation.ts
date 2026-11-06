import {
  StoreError,
  type NewOperation,
  type OperationChange,
  type OperationRecord,
  type OperationStatus,
} from "./types.js";

const NEXT: Record<OperationStatus, readonly OperationStatus[]> = {
  pending: ["confirmed", "failed", "rejected"],
  failed: ["pending"],
  confirmed: [],
  rejected: [],
};

export function pendingOperation(operation: NewOperation): OperationRecord {
  const { opId, channelId, type, payload } = operation;
  return { opId, channelId, type, payload, status: "pending", attempts: 0 };
}

/** The record after `change`. Pure; both stores call it inside their per-channel write. */
export function applyChange(current: OperationRecord, change: OperationChange): OperationRecord {
  if (!NEXT[current.status].includes(change.status)) {
    throw new StoreError(
      "illegal_transition",
      `operation ${current.opId} cannot go from ${current.status} to ${change.status}`,
    );
  }
  const { signature: previous, ...rest } = current;
  const signature = change.signature === undefined ? previous : change.signature;
  return {
    ...rest,
    status: change.status,
    attempts: change.status === "failed" ? current.attempts + 1 : current.attempts,
    ...(signature !== null && signature !== undefined ? { signature } : {}),
    ...(change.receipt !== undefined ? { receipt: change.receipt } : {}),
  };
}

export function unknownOperation(channelId: string, opId: string): StoreError {
  return new StoreError("unknown_operation", `no operation ${opId} on channel ${channelId}`);
}
