import { decodeChannel, decodeOperation, encodeChannel, encodeOperation } from "./codec.js";
import { KeyedMutex } from "./keyed-mutex.js";
import { applyChange, pendingOperation, unknownOperation } from "./operation.js";
import type {
  BatchOperationStore,
  ChannelRecord,
  ChannelStore,
  ChannelUpdater,
  NewOperation,
  OperationChange,
  OperationRecord,
  Stores,
} from "./types.js";

/**
 * Records are held encoded, through the codec the Redis store uses: the two
 * stores validate alike, and a caller can never hold a reference into the store.
 */
export class MemoryChannelStore implements ChannelStore {
  private readonly records = new Map<string, string>();
  private readonly mutex = new KeyedMutex();

  get(channelId: string): Promise<ChannelRecord | undefined> {
    const raw = this.records.get(channelId);
    return Promise.resolve(raw === undefined ? undefined : decodeChannel(raw));
  }

  list(): Promise<ChannelRecord[]> {
    return Promise.resolve([...this.records.values()].map(decodeChannel));
  }

  put(record: ChannelRecord): Promise<void> {
    return this.mutex.run(record.channelId, () => {
      this.records.set(record.channelId, encodeChannel(record.channelId, record));
    });
  }

  update(channelId: string, updater: ChannelUpdater): Promise<ChannelRecord> {
    return this.mutex.run(channelId, async () => {
      const raw = this.records.get(channelId);
      const encoded = encodeChannel(channelId, await updater(raw === undefined ? undefined : decodeChannel(raw)));
      this.records.set(channelId, encoded);
      return decodeChannel(encoded);
    });
  }
}

export class MemoryBatchOperationStore implements BatchOperationStore {
  /** channelId → opId → encoded record. */
  private readonly channels = new Map<string, Map<string, string>>();
  private readonly mutex = new KeyedMutex();

  get(channelId: string, opId: string): Promise<OperationRecord | undefined> {
    const raw = this.channels.get(channelId)?.get(opId);
    return Promise.resolve(raw === undefined ? undefined : decodeOperation(raw));
  }

  list(channelId: string): Promise<OperationRecord[]> {
    return Promise.resolve([...(this.channels.get(channelId)?.values() ?? [])].map(decodeOperation));
  }

  reserve(operation: NewOperation): Promise<{ created: boolean; operation: OperationRecord }> {
    return this.mutex.run(operation.channelId, () => {
      const ops = this.opsOf(operation.channelId);
      const raw = ops.get(operation.opId);
      if (raw !== undefined) return { created: false, operation: decodeOperation(raw) };
      const encoded = encodeOperation(pendingOperation(operation));
      ops.set(operation.opId, encoded);
      return { created: true, operation: decodeOperation(encoded) };
    });
  }

  transition(channelId: string, opId: string, change: OperationChange): Promise<OperationRecord> {
    return this.mutex.run(channelId, () => {
      const ops = this.opsOf(channelId);
      const raw = ops.get(opId);
      if (raw === undefined) throw unknownOperation(channelId, opId);
      const encoded = encodeOperation(applyChange(decodeOperation(raw), change));
      ops.set(opId, encoded);
      return decodeOperation(encoded);
    });
  }

  private opsOf(channelId: string): Map<string, string> {
    let ops = this.channels.get(channelId);
    if (ops === undefined) {
      ops = new Map();
      this.channels.set(channelId, ops);
    }
    return ops;
  }
}

export function createMemoryStores(): Stores {
  return {
    channels: new MemoryChannelStore(),
    operations: new MemoryBatchOperationStore(),
    close: () => Promise.resolve(),
  };
}
