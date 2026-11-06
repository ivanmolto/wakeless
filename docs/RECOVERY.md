# Recovery: what a client retains, and what it retries

Status: devnet alpha, unaudited. Task 6.3.

What a buyer (the `@wakeless/client` wrapper or any client of the `batch-settlement-shielded` scheme) and a seller (the `@wakeless/vendor` middleware or any caller of the facilitator) must keep, and what each sends again, after a `settlement_pending`, a `duplicate_settlement`, a rate limit, or a response that never arrived. It mirrors the recovery rules of the x402 V2 specification and the `batch-settlement` SVM binding, which are the reference (`CLAUDE.md`, Standards and specs); where Wakeless differs, `docs/SCHEME.md` and the facilitator README say how. Line numbers cite `vendor/x402/specs` at the commit `docs/VERSIONS.md` records.

## 1. The rules the spec sets

- **A settlement response is never replayed by the scheme, and a duplicate never executes twice.** The watermark and the per-channel lock are the replay defence for client-mode vouchers; a client-supplied transaction (a deposit) goes through a short-lived in-flight cache keyed by its signature, and concurrent `/settle` calls for it are coalesced to one result or refused with `duplicate_settlement` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L1802`-`L1823`). "Core x402 requests are single-shot; scheme state prevents a duplicate request from executing but is not an HTTP response-recovery protocol" (`:L1804`-`L1805`).
- **`settlement_pending` is non-terminal.** A `SettlementResponse` carrying it must carry a non-empty `transaction` and the `network`, "so the caller can reconcile on chain before deciding whether to retry" (`specs/x402-specification-v2.md:L612`).
- **The client advances only from its local confirmed watermark.** "Clients keep one request in flight per channel and only advance from their local confirmed watermark" (`scheme_batch_settlement_svm.md:L2085`-`L2088`); a stale cumulative is answered with a corrective 402 carrying `channelState` and the server's last accepted voucher, and the client resynchronises from it (`:L1216`-`L1269`).
- **A transport retry is a new request.** It must not reuse a server-mode `requestId` (`:L1573`-`L1575`); in client mode, which is the only mode Wakeless offers, it is a new voucher at the right cumulative.

## 2. What Wakeless does with them

The facilitator (`packages/facilitator`) adds one thing the spec allows and does not require: **`/settle` is idempotent by payload hash**. The hash is sha256 over the canonical JSON of `{paymentPayload, paymentRequirements}` (key order does not matter), and a successful result is stored under it for `DEFAULT_SETTLED_TTL_SECS` (one day). A second request with the same bytes gets the stored result with `extra.replayed: true` and moves nothing; two identical requests in flight settle once. This is what makes "send the exact same thing again" safe for a seller whose answer was lost.

Three codes name the states a caller recovers from. All carry `{error, code, retryable}` beside the spec's shape.

| Code | Where | `retryable` | Meaning |
| --- | --- | --- | --- |
| `settlement_pending` | `/settle` of a deposit, 200 | `true` | A confirmation of this deposit signature is already in flight in the facilitator (`transaction` holds the signature). Send the same payload again after a short wait |
| `duplicate_settlement` | `/settle` of a deposit, 200 | `false` | This deposit signature was already credited to the channel. The deposit counted; do not make it again. Pay the next request with a voucher |
| `shielded_rate_limited` | any endpoint, 429 | `true` | Over the per-IP or per-channel limit. Wait `Retry-After` seconds and send the same request |
| `shielded_verify_required` | `/settle` of a voucher, 200 | `false` | No valid `/verify` of this payload within `maxTimeoutSeconds`. Verify again, then settle |
| `invalid_batch_settlement_svm_cumulative_amount_mismatch` | `/verify`, `/settle`, 200 | `false` | The cumulative is not the facilitator's watermark plus the amount. The verdict on `/verify` is corrective: resynchronise and sign a new voucher |

A `shielded_facilitator_unavailable` from a seller (402, `retryable: true`, empty `accepts[]`) means the seller could not reach the facilitator at all; nothing was settled on the buyer's behalf unless the lost answer was the settle's, which section 4 covers.

## 3. The buyer

### 3.1 What to retain

Per channel, durably, before the request goes out:

- **The channel record**: `salt`, `channelId`, `escrowAddress`, `network`, the confirmed `deposit` and the confirmed `accepted` cumulative. The client writes this to `~/.wakeless/channels.json` (`channelStoreLocal`), whole, through a temp file and rename, mode 0600.
- **Every deposit until it is credited**: the exact `depositSignature`, the exact base64 `transaction` as submitted, and the `amount`, as `pendingDeposit` on the channel record. The private transfer is already made; losing these three fields means a transfer the buyer cannot prove and cannot present again. The facilitator's binding confirms a deposit only against the signature and the transaction the buyer submitted (`binding.readDeposit`), so an approximation does not do.
- **The last voucher signed** is not needed: Ed25519 is deterministic and the voucher is a pure function of `channelId`, `maxClaimableAmount` and `expiresAt = 0`, so a voucher is re-signed, never recalled. The facilitator's corrective verdict returns the buyer's own last accepted voucher in `voucherState` when a resynchronisation needs it.

Never retain, and never log, the buyer's secret key beside the channel file; it comes from the keypair file at every start.

### 3.2 What to retry, and with what

| What happened | The buyer's next move |
| --- | --- |
| The vendor answered 402 `settlement_pending` | The deposit is being confirmed. Keep `pendingDeposit`. On the next request present the **same** deposit (same signature, same transaction, same amount) with a voucher at the current cumulative. The client does this itself ("deposit resent" in its log) |
| The vendor answered 402 `duplicate_settlement` while a deposit was pending | The deposit was credited by an earlier settle whose answer did not reach the buyer. Add its amount to the local `deposit`, drop `pendingDeposit`, and pay with a voucher. The client does this itself and retries at once |
| The vendor answered 402 `shielded_rate_limited` or `shielded_facilitator_unavailable` | Nothing was charged. Wait (`Retry-After` when present), then send the request again unchanged: same deposit if one is pending, else a fresh voucher at the same cumulative |
| No response at all (timeout, connection reset) after a deposit was sent | Treat as `settlement_pending`: the deposit stays `pendingDeposit` and is presented again. If it was credited meanwhile, the answer is `duplicate_settlement` and the row above applies |
| No response at all after a voucher was sent | The resource may or may not have been served, and the voucher may or may not have been accepted. Sign the next voucher from the local watermark as usual. If the facilitator accepted the lost one, the next `/verify` answers `cumulative_amount_mismatch` with a corrective 402 carrying `channelState.chargedCumulativeAmount`; adopt it and sign again. The lost resource body is not recovered by the scheme (`scheme_batch_settlement_svm.md:L1811`-`L1813`); the application asks again, which is one more paid request |
| A corrective 402 (`cumulative_exceeds_deposit`, `cumulative_amount_mismatch`) | Adopt `channelState.balance` and `channelState.chargedCumulativeAmount`, and `voucherState.signedMaxClaimable` when it is higher, as the local deposit and watermark; sign a new voucher; retry. Never go below what the buyer already signed: that is the rule that keeps a corrective 402 from refunding a charge |
| `shielded_binding_rejected`, `invalid_transaction_state` | Not retried, and never retried publicly (`CLAUDE.md`, Privacy rules). The deposit stays pending in the channel file for an operator to look at; the client does not remake it |

The client keeps **at most one request in flight per channel** (a per-channel mutex), so the local watermark is exact when the next voucher is signed. Two requests to the same vendor at once queue, they do not race.

## 4. The seller

### 4.1 What to retain

For every `/settle` it sends, until the answer is in hand and the response to the buyer has been written: **the exact request envelope** `{x402Version, paymentPayload, paymentRequirements}` as posted, byte for byte or as the same JSON value (the facilitator hashes canonical JSON, so field order is free but every field counts, including `paymentPayload.resource`).

The middleware keeps it in memory for the life of the request. A seller that wants to survive its own restart between the handler and the settle keeps it durably; the middleware does not.

### 4.2 What to retry, and with what

| What happened | The seller's next move |
| --- | --- |
| `/settle` answered 200 `success: false` with `settlement_pending` | The deposit is being confirmed, on another request or in another process. Send the **same** envelope again after a short wait, until the answer is `success: true` (first time) or `extra.replayed: true` (the result was already stored), or `duplicate_settlement`, which means the same deposit was credited through another envelope and this request's voucher must be re-verified |
| `/settle` got no answer (timeout, 5xx, connection reset) | The settle may have happened. Send the **same** envelope again: within `DEFAULT_SETTLED_TTL_SECS` a settle that happened answers the stored result with `extra.replayed: true`, and one that did not happen settles now (still inside `maxTimeoutSeconds` of the verify) or answers `shielded_verify_required` (outside it). Both are safe: nothing settles twice |
| `/settle` answered 429 `shielded_rate_limited` | Wait `Retry-After` seconds and send the same envelope. The verify window keeps running; past it the answer is `shielded_verify_required` and the seller withholds the resource and answers 402 so the buyer verifies again |
| `/settle` answered `shielded_verify_required` | Too slow between verify and settle (`maxTimeoutSeconds`, 60 s in the vendors' terms). Withhold the resource and answer 402 with the code; the buyer sends again |
| `/verify` passed, the handler failed (4xx or 5xx) | Nothing to settle, nothing was charged. Return the handler's response |

The current middleware (`packages/vendor`) does not retry a `/settle` itself: a lost settle answer becomes a 402 `shielded_facilitator_unavailable` to the buyer, the resource is withheld, and the buyer recovers on its next request through the rows of section 3.2 (the facilitator's watermark is authoritative; a corrective 402 brings the buyer level). That is the conservative reading of "not an HTTP response-recovery protocol": the seller never serves twice for one voucher, and the buyer is never charged for a response it did not get, since a withheld resource is a 402 and the next voucher is checked against the real watermark.

## 5. The facilitator

What the facilitator keeps, so the rows above hold:

- **Stored results by payload hash**, one day, in memory and per process (`SettledResults`). With several processes a seller must reach the same one for verify and settle, or results must be shared (a later hardening task). Past the TTL a replay is refused by the watermark as `cumulative_amount_mismatch`, never settled twice.
- **The verified set** by payload hash for `maxTimeoutSeconds`, in memory and per process (`VerifiedSet`).
- **One `deposit` operation per deposit signature** on the channel (`deposit:<sha256 of the signature>`), in the operation store: `pending` while a confirmation is in flight (this is what answers `settlement_pending`), `confirmed` once credited (this is what answers `duplicate_settlement`), `failed` after a confirmation that did not match, from which the same payload may be tried again. The store is the memory or the Redis one; Redis survives a restart.
- **The channel record** with `deposit`, `accepted` and `latestVoucher`, atomically updated per channel.
- **One `settle` operation per channel period** (`settle:<period>`) for the redemption worker, with the transfer's signature kept on a `failed` operation when the binding submitted the transfer and did not see it confirmed. That operation is what `GET /receipts/:channelId` lists under `pending` as `settlement_pending` with the signature in `transaction`; the worker never resends it on that signature alone, but once the backoff has passed asks the rail for it (`binding.transferStatus`) and, when the rail does not know it, settles its fate against the escrow's private balance, and only then confirms it or retries the same period and amount (`packages/facilitator/README.md`, Redemption; `docs/FAILURES.md` row 5).

What it never keeps or logs: a payload as sent, a voucher signature, a bearer token, a key, or an amount for a channel in a log line. Logs name requests by payload hash and channel id (`packages/facilitator/README.md`, Logs).

## 6. Checklist

For a buyer:

1. Write the channel record, with `pendingDeposit`, before the request leaves.
2. Present a pending deposit again, unchanged, until it is `confirmed` or `duplicate_settlement`.
3. Sign every voucher from the local confirmed watermark; adopt a corrective 402's state, never a lower one.
4. One request in flight per channel.

For a seller:

1. Keep the exact envelope until the settle answer is in hand.
2. On `settlement_pending`, 429, or no answer: the same envelope again.
3. On `shielded_verify_required`: withhold the resource, 402, the buyer verifies again.
4. Never serve the handler twice for one voucher.
