# @wakeless/facilitator

Status: devnet alpha, unaudited

The Wakeless facilitator: the x402 V2 facilitator endpoints (`GET /supported`, `POST /verify`, `POST /settle`) for the `batch-settlement-shielded` scheme, over channel and operation stores with an in-memory and a Redis implementation. A Hono app; the process entry serves it with `@hono/node-server` on `127.0.0.1`.

```bash
pnpm --filter @wakeless/facilitator start
```

Reads `.env` at the repo root: `SOLANA_RPC_URL` (Helius devnet), `USDC_MINT`, `ESCROW_KEYPAIR` (default `keys/escrow.json`, never under `keys/mainnet/`), optional `MAGICBLOCK_TEE_RPC`, `MAGICBLOCK_PAYMENTS_API`, `REDIS_URL` (memory stores when unset), `FACILITATOR_PORT` (default 4020), `ATTESTATION_REPORT_PATH` (default `docs/attestation-facilitator.json`, written on every start; `docs/attestation-devnet.json` is the spike's report and keeps the raw quote). Devnet only: a mainnet RPC hostname or `MAINNET_ENABLED=true` refuses to start.

Starting builds the MagicBlock binding, which verifies TEE attestation first. If attestation fails the process still serves, so a vendor learns why instead of a refused connection: `/supported` has `kinds: []` and `extra.error: "shielded_attestation_failed"`, and `/verify` and `/settle` answer 503 with that code. Nothing is settled without an attested binding, and nothing is ever simulated.

## Endpoints

`GET /supported` returns the spec's `{kinds, extensions, signers}` with one kind, `{x402Version: 2, scheme: "batch-settlement-shielded", network: "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1", extra: {escrowAddress, binding: "magicblock", teeValidator, privacyFeeBps: 10, maxIdleSecs: 604800}}`. `escrowAddress` and `teeValidator` come from the binding's attestation, not from configuration. `signers["solana:*"]` lists the receipt signer once a later task adds one.

`POST /verify` and `POST /settle` take the standard envelope `{x402Version: 2, paymentPayload, paymentRequirements}`, with `paymentPayload.accepted` equal to `paymentRequirements`. The inner `payload` is `voucher` or `deposit` (`docs/SCHEME.md` §4.3).

- **`/verify` reads and never writes payment state.** For a voucher it recomputes the channel id from `channelConfig` and `extra.escrowAddress`, checks the voucher names it and the buyer signed it, loads the channel and applies `nextWatermark` to the record as stored. For a deposit it validates the deposit object (signature shape, positive amount) and checks the first voucher against the claimed deposit plus any confirmed deposit, without confirming anything; `minDeposit` is not enforced by the facilitator (`docs/SCHEME.md` §1.2). A valid payload enters a short-lived verified set keyed by the payload hash for `maxTimeoutSeconds`. The response is the spec's `{isValid, payer, extra: {channelId, balance, totalClaimed, withdrawRequestedAt}}`.
- **`/settle` of a voucher** requires a valid `/verify` of the same payload within `maxTimeoutSeconds` (the authorization flow); without one it fails with `shielded_verify_required`. It then moves the watermark inside the store's atomic per-channel update, running the same checks on the record as stored, and stores `latestVoucher`. The response is `{success: true, transaction: "", network, payer, extra: {commitmentId: "<channelId>:<watermark>", chargedAmount, channelState}}`.
- **`/settle` of a deposit** confirms the buyer's private transfer through the binding (`createDepositHandler`, `src/deposit.ts`). The buyer has already made it: a private ephemeral transfer from its own private balance to the escrow with `clientRefId = clientRefOf(channelId)`, built and submitted by `@wakeless/client` `deposit()`. The handler re-derives the channel id and reference from `channelConfig`, checks the record as stored (same buyer, vendor and mint; open; the voucher acceptable once the deposit counts), reserves the deposit signature as a `deposit` operation on the channel so it is credited once, then calls `binding.readDeposit(depositSignature, {clientRef, buyer, amount, transaction})`, which decodes `deposit.transaction` to check that this buyer paid the escrow exactly this amount with no Memo, that the signature landed inside the rollup with `err: null`, and that the escrow's private balance grew. On a match it records the channel with `deposit = amount` (a top-up adds to the existing deposit) and accepts the voucher inside the store's atomic update; the response is `{success: true, transaction: depositSignature, network, payer, amount, extra: {commitmentId, chargedAmount, channelState}}`. The binding answering `null` is `invalid_transaction_state` (not retryable; the operation goes back to `failed` and a later payload for the same signature is tried again); a signature already credited is `duplicate_settlement`; a confirmation of the same signature in flight is `settlement_pending` with the signature in `transaction`; a record under another buyer, vendor or mint is `invalid_batch_settlement_svm_channel_state`. A server without a handler answers 500 `unexpected_settle_error` and settles nothing. Nothing is ever simulated: the unit tests run the handler over a binding fake that answers `readDeposit` from a list of transfers the test "made"; the privacy claim is `test/deposit.devnet.test.ts`.
- **Idempotent `/settle`.** Results are stored by payload hash (sha256 of the canonical JSON of `{paymentPayload, paymentRequirements}`, key order independent). A repeated identical payload gets the stored result with `extra.replayed: true` and moves nothing; two identical requests in flight settle once. The same voucher sent in a different envelope is not a replay and fails on the watermark as `invalid_batch_settlement_svm_cumulative_amount_mismatch`.

The verified set and the stored results are in memory and per process: with several facilitator processes, a vendor must reach the same one for verify and settle until a hardening task shares them.

## Errors

Every refused request carries `{error, code, retryable}`: `code` is a scheme error code (`docs/SCHEME.md` §1.5), `error` a short message that never echoes a signature, a token, a key or a channel amount, and `retryable` is true only for `unexpected_verify_error`, `unexpected_settle_error` and `settlement_pending`.

| What | Status | Body |
| --- | --- | --- |
| A verdict on the payment (bad signature, unknown channel, stale cumulative, closing channel, wrong payload type, deposit object malformed, settle without verify, deposit not confirmed by the binding, deposit signature reused, binding refusal) | 200 | The spec's own shape, `{isValid: false, invalidReason, invalidMessage, payer}` or `{success: false, errorReason, errorMessage, transaction: "", network, payer}`, plus `error`, `code` and `retryable` beside it. `settlement_pending` alone carries the deposit signature in `transaction` |
| A malformed envelope or requirements (not JSON, `x402Version` not 2, another scheme or network, `accepted` differs from `paymentRequirements`, another escrow, `withdrawDelay` out of range, server mode) | 400 | `{error, code, retryable}` |
| No attested binding | 503 | `{error, code: "shielded_attestation_failed", retryable: false}` |
| Unknown route | 404 | `{error, code, retryable}` |
| A facilitator fault | 500 | `{error: "internal error", code: "unexpected_verify_error" \| "unexpected_settle_error", retryable: true}` |

Stock x402 facilitator clients accept both: a 200 verdict is parsed as the spec's response, and a non-2xx body is surfaced with its status.

## Stores

Both interfaces are modelled on `ChannelStore` and `BatchOperationStore` in `@x402/svm`'s batch-settlement server, and both have an in-memory and a Redis implementation that pass one shared test suite.

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
- **Operation types.** `deposit` holds a credited deposit signature (op id `deposit:<sha256 of the signature>`, so no store message names the signature; the signature itself is in the record's `signature`); `claim`, `settle` and `refund` are the redemption worker's.
- **Operation lifecycle.** `pending` goes to `confirmed`, `failed` or `rejected`; `failed` goes back to `pending`, and entering `failed` adds one to `attempts`. `confirmed` and `rejected` are terminal, so a rejected private transfer cannot be retried through the store. `pending` means a transfer may be in flight: a worker moves an operation to `pending` before it calls the binding, and at startup reconciles every `pending` operation against the binding before sending anything. A `failed` record is at rest, so it is the only state a retry starts from.
- **What Redis holds.** Channel amounts and voucher signatures, unencrypted, under the facilitator's own trust boundary: the facilitator is one of the three operators who see inside (with MagicBlock's enclave and NEAR's private shard). Point it at a server only the facilitator can reach. Store errors name fields and ids, never amounts or signatures.

## Logs

One line per request: method, path, status, error code and the payload hash, sometimes a channel id. Never a payload field, a signature, a token or an amount; the HTTP tests scan the captured lines for 87- and 88-character base58 strings.

## Tests

`test/http.test.ts` runs the app in process over a binding fake that answers only `network()` and `escrowAddress()` (nothing is transferred in a unit test; the privacy primitive is never simulated). `test/deposit.test.ts` runs `confirmDeposit` over a fake whose `readDeposit` matches only the signature, reference, buyer, amount and transaction of transfers the test recorded, and never twice. `test/request.fuzz.test.ts` fuzzes the envelope and payload parsers with fast-check. `test/deposit.devnet.test.ts` (`pnpm test:devnet`, needs `.env` and a buyer private balance of at least 0.01 USDC) makes a real private deposit through `@wakeless/client` and the real binding and settles it in process.

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
