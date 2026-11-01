import { randomBytes, randomUUID } from "node:crypto";
import { setImmediate as nextTick } from "node:timers/promises";
import { clientRefOf, encodeBase58, nextWatermark, type BatchVoucher } from "@wakeless/scheme";
import { Redis } from "ioredis";
import { afterAll, beforeEach, describe, expect, it } from "vitest";
import { skipUnless } from "../../../scripts/lib/skip-unless.js";
import {
  StoreError,
  createMemoryStores,
  createRedisStores,
  type ChannelRecord,
  type NewOperation,
  type Stores,
} from "../src/index.js";

function channelId(): string {
  return encodeBase58(randomBytes(32));
}

function signature(): string {
  return encodeBase58(randomBytes(64));
}

function channel(id: string, overrides: Partial<ChannelRecord> = {}): ChannelRecord {
  return {
    channelId: id,
    clientRef: clientRefOf(id),
    buyer: "buyer-address",
    vendor: "vendor-address",
    mint: "mint-address",
    deposit: 1_000_000n,
    settled: 0n,
    accepted: 0n,
    latestVoucher: null,
    state: "open",
    lastActivityAt: 1_700_000_000,
    ...overrides,
  };
}

function voucher(id: string, cumulative: bigint): BatchVoucher {
  return { channelId: id, maxClaimableAmount: cumulative.toString(), expiresAt: 0, signature: signature() };
}

function operation(id: string, opId = "op-1"): NewOperation {
  return { opId, channelId: id, type: "settle", payload: { period: 1, amount: "250" } };
}

async function codeOf(work: Promise<unknown>): Promise<string> {
  const error: unknown = await work.then(
    () => new Error("expected a rejection"),
    (rejected: unknown) => rejected,
  );
  if (error instanceof StoreError) return error.code;
  throw error;
}

function shuffled<T>(items: readonly T[]): T[] {
  const out = [...items];
  for (let i = out.length - 1; i > 0; i -= 1) {
    const j = Math.floor(Math.random() * (i + 1));
    [out[i], out[j]] = [out[j] as T, out[i] as T];
  }
  return out;
}

/**
 * The one suite both stores must pass. `open` returns two handles on the same
 * data: for Redis they are separate clients, standing in for two facilitator
 * processes, so their writes really do collide on WATCH.
 */
function contract(name: string, open: () => [Stores, Stores]) {
  let stores: Stores;
  let other: Stores;

  beforeEach(() => {
    [stores, other] = open();
  });

  it(`store contract: channel create, read, update, close (${name})`, async () => {
    const id = channelId();
    expect(await stores.channels.get(id)).toBeUndefined();

    const created = channel(id);
    await stores.channels.put(created);
    expect(await stores.channels.get(id)).toEqual(created);
    expect(await other.channels.get(id)).toEqual(created);
    expect((await stores.channels.list()).map((record) => record.channelId)).toContain(id);

    const latestVoucher = voucher(id, 400n);
    const updated = await stores.channels.update(id, (current) => {
      if (current === undefined) throw new Error("channel is missing");
      return { ...current, accepted: 400n, latestVoucher, lastActivityAt: 1_700_000_060 };
    });
    expect(updated).toEqual({ ...created, accepted: 400n, latestVoucher, lastActivityAt: 1_700_000_060 });
    expect(await stores.channels.get(id)).toEqual(updated);

    await stores.channels.update(id, (current) => ({ ...(current as ChannelRecord), state: "closing" }));
    expect((await stores.channels.get(id))?.state).toBe("closing");
    await stores.channels.update(id, (current) => ({ ...(current as ChannelRecord), state: "closed", settled: 400n }));
    const closed = await stores.channels.get(id);
    expect(closed?.state).toBe("closed");
    expect(closed?.settled).toBe(400n);
  });

  it("update creates a channel the store does not hold", async () => {
    const id = channelId();
    const seen: unknown[] = [];
    await stores.channels.update(id, (current) => {
      seen.push(current);
      return channel(id);
    });
    expect(seen).toEqual([undefined]);
    expect(await stores.channels.get(id)).toEqual(channel(id));
  });

  it("amounts round-trip at the top of the u64 range", async () => {
    const id = channelId();
    const max = (1n << 64n) - 1n;
    await stores.channels.put(channel(id, { deposit: max, accepted: max, settled: max }));
    const read = await other.channels.get(id);
    expect([read?.deposit, read?.accepted, read?.settled]).toEqual([max, max, max]);
  });

  it("a throwing updater writes nothing and does not block the channel", async () => {
    const id = channelId();
    await stores.channels.put(channel(id));
    await expect(
      stores.channels.update(id, () => {
        throw new Error("refused");
      }),
    ).rejects.toThrow("refused");
    expect(await stores.channels.get(id)).toEqual(channel(id));
    const next = await stores.channels.update(id, (current) => ({ ...(current as ChannelRecord), accepted: 1n }));
    expect(next.accepted).toBe(1n);
  });

  it("an updater cannot write a different channel or a malformed record", async () => {
    const id = channelId();
    await stores.channels.put(channel(id));
    expect(await codeOf(stores.channels.update(id, () => channel(channelId())))).toBe("invalid_record");
    expect(await codeOf(stores.channels.put(channel(id, { deposit: 1n << 64n })))).toBe("invalid_record");
    expect(await codeOf(stores.channels.put(channel(id, { accepted: -1n })))).toBe("invalid_record");
    expect(await codeOf(stores.channels.put(channel(id, { latestVoucher: voucher(channelId(), 1n) })))).toBe(
      "invalid_record",
    );
    expect(await stores.channels.get(id)).toEqual(channel(id));
  });

  it("a record handed out is a copy", async () => {
    const id = channelId();
    await stores.channels.put(channel(id));
    const read = (await stores.channels.get(id)) as { accepted: bigint };
    read.accepted = 999n;
    expect((await stores.channels.get(id))?.accepted).toBe(0n);
  });

  it("store contract: operation lifecycle pending, confirmed, failed, rejected", async () => {
    const id = channelId();
    const ops = stores.operations;
    expect(await ops.get(id, "op-1")).toBeUndefined();
    expect(await ops.list(id)).toEqual([]);

    const reserved = await ops.reserve(operation(id));
    expect(reserved.created).toBe(true);
    expect(reserved.operation).toEqual({ ...operation(id), status: "pending", attempts: 0 });
    expect(await other.operations.get(id, "op-1")).toEqual(reserved.operation);

    // Reserving again returns the record as it stands, whatever the new payload says.
    const again = await ops.reserve({ ...operation(id), type: "refund", payload: {} });
    expect(again).toEqual({ created: false, operation: reserved.operation });

    // pending → failed → pending → confirmed, counting each failure.
    const failed = await ops.transition(id, "op-1", { status: "failed" });
    expect([failed.status, failed.attempts]).toEqual(["failed", 1]);
    const retried = await ops.transition(id, "op-1", { status: "pending" });
    expect([retried.status, retried.attempts]).toEqual(["pending", 1]);
    const sig = signature();
    const confirmed = await ops.transition(id, "op-1", {
      status: "confirmed",
      signature: sig,
      receipt: { period: 1, cumulative: "250" },
    });
    expect(confirmed).toEqual({
      ...operation(id),
      status: "confirmed",
      attempts: 1,
      signature: sig,
      receipt: { period: 1, cumulative: "250" },
    });
    expect(await ops.get(id, "op-1")).toEqual(confirmed);

    // pending → rejected. Terminal, like confirmed: no retry of a rejected transfer.
    await ops.reserve(operation(id, "op-2"));
    const rejected = await ops.transition(id, "op-2", { status: "rejected" });
    expect([rejected.status, rejected.attempts]).toEqual(["rejected", 0]);
    for (const status of ["pending", "confirmed", "failed", "rejected"] as const) {
      expect(await codeOf(ops.transition(id, "op-2", { status }))).toBe("illegal_transition");
      expect(await codeOf(ops.transition(id, "op-1", { status }))).toBe("illegal_transition");
    }
    expect((await ops.get(id, "op-2"))?.status).toBe("rejected");

    // failed cannot jump straight to an outcome.
    await ops.reserve(operation(id, "op-3"));
    await ops.transition(id, "op-3", { status: "failed" });
    expect(await codeOf(ops.transition(id, "op-3", { status: "confirmed" }))).toBe("illegal_transition");

    expect(await codeOf(ops.transition(id, "no-such-op", { status: "failed" }))).toBe("unknown_operation");
    expect((await ops.list(id)).map((op) => op.opId).sort()).toEqual(["op-1", "op-2", "op-3"]);
    expect(await ops.list(channelId())).toEqual([]);
  });

  it("operation ids are scoped to their channel, and a bad signature is refused", async () => {
    const [a, b] = [channelId(), channelId()];
    await stores.operations.reserve(operation(a));
    expect((await stores.operations.reserve(operation(b))).created).toBe(true);
    expect(await codeOf(stores.operations.transition(a, "op-1", { status: "confirmed", signature: "nope" }))).toBe(
      "invalid_record",
    );
    expect((await stores.operations.get(a, "op-1"))?.status).toBe("pending");
  });

  it("parallel reserves of one id create exactly one operation", async () => {
    const id = channelId();
    const results = await Promise.all(
      Array.from({ length: 20 }, (_, i) => (i % 2 === 0 ? stores : other).operations.reserve(operation(id))),
    );
    expect(results.filter((result) => result.created)).toHaveLength(1);
  });

  it("parallel failures of one operation each count", async () => {
    const id = channelId();
    await stores.operations.reserve(operation(id));
    let refused = 0;
    await Promise.all(
      Array.from({ length: 10 }, (_, i) =>
        (i % 2 === 0 ? stores : other).operations.transition(id, "op-1", { status: "failed" }).catch(() => {
          refused += 1;
        }),
      ),
    );
    // Only the first leaves pending; the others find it failed and are refused.
    expect(refused).toBe(9);
    expect((await stores.operations.get(id, "op-1"))?.attempts).toBe(1);
  });

  it("concurrent nextWatermark updates never lose an update", async () => {
    const id = channelId();
    await stores.channels.put(channel(id));

    // 100 distinct cumulatives, arriving in any order. Whichever runs, a later
    // lower voucher is refused; if a write were lost the maximum could be too.
    const cumulatives = Array.from({ length: 100 }, (_, i) => BigInt(i + 1) * 10n);
    const maximum = 1000n;
    await Promise.all(
      shuffled(cumulatives).map((cumulative, i) =>
        (i % 2 === 0 ? stores : other).channels.update(id, async (current) => {
          const record = current as ChannelRecord;
          // Yield mid-update, so an unserialised store interleaves here.
          await nextTick();
          const next = nextWatermark(record.accepted, voucher(id, cumulative), 1n, record.deposit);
          if (!next.ok) return record;
          return { ...record, accepted: next.watermark, latestVoucher: voucher(id, next.watermark) };
        }),
      ),
    );

    const final = await stores.channels.get(id);
    expect(final?.accepted).toBe(maximum);
    expect(final?.latestVoucher?.maxClaimableAmount).toBe(maximum.toString());
  }, 30_000);

  it("100 parallel increments on one channel all land", async () => {
    const id = channelId();
    await stores.channels.put(channel(id));
    await Promise.all(
      Array.from({ length: 100 }, (_, i) =>
        (i % 2 === 0 ? stores : other).channels.update(id, async (current) => {
          const record = current as ChannelRecord;
          await nextTick();
          return { ...record, accepted: record.accepted + 1n };
        }),
      ),
    );
    expect((await stores.channels.get(id))?.accepted).toBe(100n);
  }, 30_000);

  it("a slow update on one channel does not hold up another", async () => {
    const [slow, quick] = [channelId(), channelId()];
    await stores.channels.put(channel(slow));
    await stores.channels.put(channel(quick));
    let release = (): void => undefined;
    const gate = new Promise<void>((resolve) => {
      release = resolve;
    });
    const held = stores.channels.update(slow, async (current) => {
      await gate;
      return current as ChannelRecord;
    });
    await stores.channels.update(quick, (current) => ({ ...(current as ChannelRecord), accepted: 1n }));
    release();
    await held;
    expect((await stores.channels.get(quick))?.accepted).toBe(1n);
  });
}

describe("stores (memory)", () => {
  contract("memory", () => {
    const stores = createMemoryStores();
    return [stores, stores];
  });
});

skipUnless("REDIS_URL", "the Redis store contract needs a Redis server")("stores (redis)", () => {
  const url = process.env.REDIS_URL as string;
  // Never flush: this may be someone's server. Every key sits under a prefix unique to this run.
  const prefix = `wakeless-test:${randomUUID()}:`;
  const opened: Stores[] = [];
  const openStores = (options = {}): Stores => {
    const stores = createRedisStores(url, { prefix, ...options });
    opened.push(stores);
    return stores;
  };
  const admin = new Redis(url);

  afterAll(async () => {
    await Promise.all(opened.map((stores) => stores.close()));
    const keys = await admin.keys(`${prefix}*`);
    if (keys.length > 0) await admin.del(keys);
    await admin.quit();
  });

  describe("contract", () => {
    contract("redis", () => [openStores(), openStores()]);
  });

  describe("WATCH/MULTI", () => {
    it("re-runs the updater when another client writes during the transaction", async () => {
      const [a, b] = [openStores(), openStores()];
      const id = channelId();
      await a.channels.put(channel(id));

      const seen: bigint[] = [];
      const final = await a.channels.update(id, async (current) => {
        const record = current as ChannelRecord;
        seen.push(record.accepted);
        if (seen.length === 1) {
          await b.channels.update(id, (inner) => ({ ...(inner as ChannelRecord), accepted: 7n }));
        }
        return { ...record, accepted: record.accepted + 1n };
      });

      expect(seen).toEqual([0n, 7n]);
      expect(final.accepted).toBe(8n);
      expect((await b.channels.get(id))?.accepted).toBe(8n);
    });

    it("gives up with write_conflict when every attempt loses", async () => {
      const [a, b] = [openStores({ maxAttempts: 3 }), openStores()];
      const id = channelId();
      await a.channels.put(channel(id));
      let runs = 0;
      const work = a.channels.update(id, async (current) => {
        const record = current as ChannelRecord;
        runs += 1;
        await b.channels.update(id, (inner) => ({
          ...(inner as ChannelRecord),
          accepted: (inner as ChannelRecord).accepted + 1n,
        }));
        return { ...record, settled: 1n };
      });
      expect(await codeOf(work)).toBe("write_conflict");
      expect(runs).toBe(3);
      const final = await b.channels.get(id);
      expect([final?.accepted, final?.settled]).toEqual([3n, 0n]);
    });

    it("a connection lost mid-transaction fails the write rather than losing the WATCH", async () => {
      const [a, b] = [openStores(), openStores()];
      const id = channelId();
      await a.channels.put(channel(id));
      const work = a.channels.update(id, async (current) => {
        const record = current as ChannelRecord;
        await b.channels.update(id, (inner) => ({ ...(inner as ChannelRecord), accepted: 7n }));
        // Kill the connection holding this WATCH. A reconnect-and-EXEC would overwrite the 7.
        const clients = (await admin.client("LIST")) as string;
        for (const line of clients.split("\n")) {
          if (line.includes(` name=${prefix}tx `)) {
            await admin.client("KILL", "ID", /(?:^| )id=(\d+)/.exec(line)?.[1] as string);
          }
        }
        await new Promise((resolve) => setTimeout(resolve, 20));
        return { ...record, settled: 1n };
      });
      await expect(work).rejects.toThrow();
      const final = await b.channels.get(id);
      expect([final?.accepted, final?.settled]).toEqual([7n, 0n]);
      // The store recovers on a fresh connection.
      await a.channels.update(id, (current) => ({ ...(current as ChannelRecord), settled: 2n }));
      expect((await b.channels.get(id))?.settled).toBe(2n);
    });

    it("more channels than connections all complete", async () => {
      const stores = openStores({ maxConnections: 2 });
      const ids = Array.from({ length: 20 }, () => channelId());
      await Promise.all(ids.map((id) => stores.channels.put(channel(id))));
      const records = await Promise.all(ids.map((id) => stores.channels.get(id)));
      expect(records.map((record) => record?.channelId)).toEqual(ids);
    });
  });
});
