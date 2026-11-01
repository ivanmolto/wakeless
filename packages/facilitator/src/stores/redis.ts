import { setTimeout as sleep } from "node:timers/promises";
import { Redis, type ChainableCommander } from "ioredis";
import { decodeChannel, decodeOperation, encodeChannel, encodeOperation } from "./codec.js";
import { KeyedMutex } from "./keyed-mutex.js";
import { applyChange, pendingOperation, unknownOperation } from "./operation.js";
import {
  StoreError,
  type BatchOperationStore,
  type ChannelRecord,
  type ChannelStore,
  type ChannelUpdater,
  type NewOperation,
  type OperationChange,
  type OperationRecord,
  type Stores,
} from "./types.js";

export interface RedisStoresOptions {
  /** Prepended to every key. Default `wakeless:`. */
  readonly prefix?: string;
  /** Connections dedicated to transactions; one per channel being written. Default 8. */
  readonly maxConnections?: number;
  /** Tries per write before `write_conflict`. Default 32. */
  readonly maxAttempts?: number;
}

const ignore = (): void => undefined;

/**
 * WATCH belongs to a connection, so a transaction needs one to itself: on a
 * shared connection another EXEC would clear this WATCH. These connections never
 * reconnect and never queue: a reconnect drops the WATCH, and the EXEC that
 * followed would write without it. A lost connection fails the write instead.
 */
class ConnectionPool {
  private readonly idle: Redis[] = [];
  private readonly waiters: (() => void)[] = [];
  private open = 0;

  constructor(
    private readonly base: Redis,
    private readonly max: number,
    private readonly name: string,
  ) {}

  async acquire(): Promise<Redis> {
    for (;;) {
      const idle = this.idle.pop();
      if (idle === undefined) break;
      if (idle.status === "ready") return idle;
      this.discard(idle);
    }
    if (this.open >= this.max) {
      await new Promise<void>((resolve) => this.waiters.push(resolve));
      return this.acquire();
    }
    this.open += 1;
    const connection = this.base.duplicate({
      connectionName: this.name,
      lazyConnect: true,
      enableOfflineQueue: false,
      maxRetriesPerRequest: 0,
      retryStrategy: () => null,
    });
    connection.on("error", ignore);
    try {
      await connection.connect();
    } catch (error) {
      this.discard(connection);
      throw error;
    }
    return connection;
  }

  release(connection: Redis): void {
    this.idle.push(connection);
    this.waiters.shift()?.();
  }

  discard(connection: Redis): void {
    connection.disconnect();
    this.open -= 1;
    this.waiters.shift()?.();
  }

  close(): void {
    for (const connection of this.idle.splice(0)) this.discard(connection);
  }
}

interface TransactionPlan<T> {
  readonly result: T;
  /** Absent when there is nothing to write. */
  readonly write?: (multi: ChainableCommander) => void;
}

/**
 * WATCH/MULTI on one key per channel. The mutex queues writers inside this
 * process, so only other processes make a WATCH fail.
 */
class Transactions {
  private readonly mutex = new KeyedMutex();

  constructor(
    private readonly pool: ConnectionPool,
    private readonly maxAttempts: number,
  ) {}

  run<T>(key: string, attempt: (connection: Redis) => Promise<TransactionPlan<T>>): Promise<T> {
    return this.mutex.run(key, async () => {
      for (let tries = 0; tries < this.maxAttempts; tries += 1) {
        const outcome = await this.once(key, attempt);
        if (outcome !== null) return outcome.result;
        await sleep(Math.random() * Math.min(2 ** tries, 50));
      }
      throw new StoreError("write_conflict", `gave up on ${key} after ${this.maxAttempts} attempts`);
    });
  }

  /** `null` when another writer got there first. */
  private async once<T>(
    key: string,
    attempt: (connection: Redis) => Promise<TransactionPlan<T>>,
  ): Promise<{ result: T } | null> {
    const connection = await this.pool.acquire();
    let replies: [Error | null, unknown][] | null;
    let result: T;
    try {
      await connection.watch(key);
      const plan = await attempt(connection);
      result = plan.result;
      if (plan.write === undefined) {
        await connection.unwatch();
        replies = [];
      } else {
        const multi = connection.multi();
        plan.write(multi);
        replies = await multi.exec();
      }
    } catch (error) {
      // Dropping the connection is what guarantees no WATCH outlives this attempt.
      this.pool.discard(connection);
      throw error;
    }
    this.pool.release(connection);
    if (replies === null) return null;
    for (const [error] of replies) {
      if (error !== null) throw error;
    }
    return { result };
  }
}

class RedisChannelStore implements ChannelStore {
  constructor(
    private readonly client: Redis,
    private readonly transactions: Transactions,
    private readonly prefix: string,
  ) {}

  private key(channelId: string): string {
    return `${this.prefix}channel:${channelId}`;
  }

  private get index(): string {
    return `${this.prefix}channels`;
  }

  async get(channelId: string): Promise<ChannelRecord | undefined> {
    const raw = await this.client.get(this.key(channelId));
    return raw === null ? undefined : decodeChannel(raw);
  }

  async list(): Promise<ChannelRecord[]> {
    const ids = await this.client.smembers(this.index);
    if (ids.length === 0) return [];
    const raws = await this.client.mget(ids.map((id) => this.key(id)));
    return raws.filter((raw) => raw !== null).map(decodeChannel);
  }

  put(record: ChannelRecord): Promise<void> {
    const key = this.key(record.channelId);
    return this.transactions.run(key, async () => {
      const encoded = encodeChannel(record.channelId, record);
      return { result: undefined, write: (multi) => multi.set(key, encoded).sadd(this.index, record.channelId) };
    });
  }

  update(channelId: string, updater: ChannelUpdater): Promise<ChannelRecord> {
    const key = this.key(channelId);
    return this.transactions.run(key, async (connection) => {
      const raw = await connection.get(key);
      const encoded = encodeChannel(channelId, await updater(raw === null ? undefined : decodeChannel(raw)));
      const result = decodeChannel(encoded);
      if (encoded === raw) return { result };
      return { result, write: (multi) => multi.set(key, encoded).sadd(this.index, channelId) };
    });
  }
}

/** One hash per channel, so a write to any operation conflicts with all of that channel's. */
class RedisBatchOperationStore implements BatchOperationStore {
  constructor(
    private readonly client: Redis,
    private readonly transactions: Transactions,
    private readonly prefix: string,
  ) {}

  private key(channelId: string): string {
    return `${this.prefix}ops:${channelId}`;
  }

  async get(channelId: string, opId: string): Promise<OperationRecord | undefined> {
    const raw = await this.client.hget(this.key(channelId), opId);
    return raw === null ? undefined : decodeOperation(raw);
  }

  async list(channelId: string): Promise<OperationRecord[]> {
    return (await this.client.hvals(this.key(channelId))).map(decodeOperation);
  }

  reserve(operation: NewOperation): Promise<{ created: boolean; operation: OperationRecord }> {
    const key = this.key(operation.channelId);
    return this.transactions.run<{ created: boolean; operation: OperationRecord }>(key, async (connection) => {
      const raw = await connection.hget(key, operation.opId);
      if (raw !== null) return { result: { created: false, operation: decodeOperation(raw) } };
      const encoded = encodeOperation(pendingOperation(operation));
      return {
        result: { created: true, operation: decodeOperation(encoded) },
        write: (multi) => multi.hset(key, operation.opId, encoded),
      };
    });
  }

  transition(channelId: string, opId: string, change: OperationChange): Promise<OperationRecord> {
    const key = this.key(channelId);
    return this.transactions.run(key, async (connection) => {
      const raw = await connection.hget(key, opId);
      if (raw === null) throw unknownOperation(channelId, opId);
      const encoded = encodeOperation(applyChange(decodeOperation(raw), change));
      return { result: decodeOperation(encoded), write: (multi) => multi.hset(key, opId, encoded) };
    });
  }
}

export function createRedisStores(url: string, options: RedisStoresOptions = {}): Stores {
  const prefix = options.prefix ?? "wakeless:";
  const client = new Redis(url);
  // Failures reach callers as rejected commands. Without a listener ioredis prints them.
  client.on("error", ignore);
  const pool = new ConnectionPool(client, options.maxConnections ?? 8, `${prefix}tx`);
  const transactions = new Transactions(pool, options.maxAttempts ?? 32);
  return {
    channels: new RedisChannelStore(client, transactions, prefix),
    operations: new RedisBatchOperationStore(client, transactions, prefix),
    close: async () => {
      pool.close();
      await client.quit();
    },
  };
}
