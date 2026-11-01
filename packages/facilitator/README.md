# @wakeless/facilitator

Status: devnet alpha, unaudited

The facilitator's state. This task adds the two stores; the HTTP endpoints follow. Both interfaces are modelled on `ChannelStore` and `BatchOperationStore` in `@x402/svm`'s batch-settlement server, and both have an in-memory and a Redis implementation that pass one shared test suite.

```ts
const { channels, operations, close } = createMemoryStores();
// or createRedisStores(process.env.REDIS_URL, { prefix: "wakeless:" })

await channels.update(channelId, (current) => {
  const next = nextWatermark(current.accepted, voucher, amount, current.deposit);
  return next.ok ? { ...current, accepted: next.watermark, latestVoucher: voucher } : current;
});
```

- **Atomic per channel.** Memory queues writers per channel. Redis does the same inside a process and uses WATCH/MULTI between processes, each transaction on its own connection, because WATCH belongs to a connection. These connections never reconnect: a reconnect would drop the WATCH, so a lost connection fails the write instead.
- **An updater may run more than once.** On Redis it re-runs when another process wrote the channel first, so keep it free of side effects. It runs exactly once in x402's in-memory store; code written against that must not count on it here. A channel write and an operation write are two separate atomic writes, not one.
- **Operation lifecycle.** `pending` goes to `confirmed`, `failed` or `rejected`; `failed` goes back to `pending`, and entering `failed` adds one to `attempts`. `confirmed` and `rejected` are terminal, so a rejected private transfer cannot be retried through the store. `pending` means a transfer may be in flight: a worker moves an operation to `pending` before it calls the binding, and at startup reconciles every `pending` operation against the binding before sending anything. A `failed` record is at rest, so it is the only state a retry starts from.
- **What Redis holds.** Channel amounts and voucher signatures, unencrypted, under the facilitator's own trust boundary: the facilitator is one of the three operators who see inside (with MagicBlock's enclave and NEAR's private shard). Point it at a server only the facilitator can reach. Store errors name fields and ids, never amounts or signatures.

## Tests

The Redis half of `test/stores.contract.test.ts` skips with a printed reason unless `REDIS_URL` is set. It writes only under a per-run key prefix, deletes those keys afterwards, and never flushes.

```bash
docker run -d --rm --name wakeless-test-redis -p 127.0.0.1:16399:6379 redis:7-alpine redis-server --save "" --appendonly no
```

```bash
REDIS_URL=redis://127.0.0.1:16399 pnpm exec vitest run packages/facilitator
```

```bash
docker stop wakeless-test-redis
```
