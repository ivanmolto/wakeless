# @wakeless/client

Status: devnet alpha, unaudited

The buyer side of the `batch-settlement-shielded` scheme: a `fetch` that pays. On a 402 whose `accepts[]` lists a shielded entry, the first call to a vendor makes one private deposit into the facilitator's escrow and opens a channel; every call after it signs the next cumulative voucher and touches no chain. `deposit()`, the buyer half of task 4.1, is what the wrapper calls to open or top up a channel.

```ts
import { wrapFetchWithWakeless } from "@wakeless/client";

const pay = wrapFetchWithWakeless(fetch, {
  buyerKeypair,                       // 64-byte Solana keypair (or 32-byte seed); signs vouchers, never sent
  paymentsApi: "https://payments.magicblock.app",
  teeRpc: "https://devnet-tee.magicblock.app",
  baseRpc: process.env.SOLANA_RPC_URL, // Helius devnet; the binding asserts the cluster
  channelStoreLocal: "~/.wakeless/channels.json", // the default; mode 0600
});

const res = await pay("http://127.0.0.1:4021/price/SOL"); // 402 → deposit → 200; then 402 → voucher → 200
pay.getTrajectory(); // [{ vendor, route, amount, cumulative, timestamp, fundingSource?, deposit?, depositSignature? }, ...]
pay.getChannels();   // the channels this buyer holds, as the local file records them
const outcome = await pay.close(channelId); // needs facilitatorUrl; { state: "closing" | "closed", refundAfter, refund?, withdraw? }
```

## What the wrapper does on a 402

1. Reads `PAYMENT-REQUIRED` (base64 JSON) and keeps the well-formed `batch-settlement-shielded` entries on devnet; anything else, or a 402 with none, is returned as it came. The parser never throws and drops an entry with a bad field rather than repairing it (`test/parse.fuzz.test.ts`).
2. Builds the rail once per session. With no `rail` given it constructs `MagicBlockBuyer` from `paymentsApi`, `teeRpc` and `baseRpc`; that construction is the TEE attestation (`verifyTeeRpcIntegrity` plus `getIdentity`), done once and written to `attestationReportPath` when set. Every accept's `extra.teeValidator` is then compared with the attested identity; a vendor naming another identity is not paid (`shielded_attestation_failed` is thrown, nothing is sent).
3. Takes the lock for `(payTo, asset)`: one request in flight per channel, so concurrent first calls to a vendor make one deposit and vouchers are signed in watermark order.
4. No channel: deposits `extra.minDeposit` (or `defaultDeposit`, or 100 × the price), at least the first voucher's cumulative, with a fresh random salt, and sends the `deposit` payload with the first voucher. Channel: signs a voucher at `accepted + amount + feeShare`, where `feeShare = ceil(amount × privacyFeeBps / 10000)`, so the vendor nets the price. When the local state already shows the voucher would exceed the deposit, it tops up first instead of being refused.
5. On a 2xx, reads `PAYMENT-RESPONSE`, adopts the facilitator's `chargedCumulativeAmount` and `balance` as the watermark and deposit, writes the channel file, and appends the trajectory entry. On a corrective 402 (`invalid_batch_settlement_svm_cumulative_exceeds_deposit`, `invalid_batch_settlement_svm_cumulative_amount_mismatch`) it verifies `extra.voucherState.signature` as its own over the quoted cumulative, adopts `extra.channelState`, and retries once: a top-up of the corrective `extra.minDeposit` when the voucher exceeds the deposit, a re-signed voucher otherwise. At most one top-up and three paid attempts per request; a snapshot it cannot verify, or any other refusal, comes back as the 402 it is.
6. A deposit made for a request that was then not served (the vendor answered 4xx or 5xx, nothing charged) is kept in the channel file as `pendingDeposit` and presented again with the next request's voucher, never remade. `duplicate_settlement` on that resend means the facilitator had credited it already; the client counts it and pays with a voucher.

## Closing a channel

`pay.close(channelId)` (task 8.1) sends a `refund` payload to the facilitator's `/settle` at `facilitatorUrl`, not through a vendor: the channel's latest voucher signed by the buyer, plus a second buyer signature over the close message (`signCloseRequest` in `@wakeless/scheme`), so nothing a vendor holds can close a channel. The facilitator answers where the close stands and the client records it under the channel's `close`:

1. `state: "closing"`, `refundAfter`: the vendor may still present its latest voucher until then (`extra.withdrawDelay` seconds, 900 in the demo); nothing is refunded yet. Calling `close()` again polls.
2. `state: "closed"` with `refund: {amount, signature}` once the worker has paid the vendor what was owed and sent `deposit − settled` back to the buyer's **private balance** as a private transfer. The outcome now carries a `withdraw` offer: `{amount, note, perform()}`. The client performs nothing by itself. `perform()` makes the rail's withdrawal (`POST /v1/spl/withdraw`, the buyer's private balance to its base token account) and records it; it is refused a second time. The channel file keeps the offer with its note, `withdrawal is a public base-layer transaction: it names the buyer and the vault, and its amount is in clear`, which is what the owner's view shows beside it.

A closing or closed channel takes no more vouchers; paying that vendor again opens a new channel, and the closed record stays in the file. `close()` needs the accept the channel last paid under (kept in the file since this task) and no deposit pending; otherwise it throws `shielded_client_close_unconfigured`, and a facilitator refusal is `shielded_client_close_refused` with the facilitator's code in the message.

## The channel file

`~/.wakeless/channels.json` by default (`channelStoreLocal`), written whole through a temp file and rename, mode 0600, directory 0700. Keyed by `channelId` (files written before task 8.1 keyed records by `buyer:vendor:mint` and read the same): `salt`, `channelId`, `escrowAddress`, the confirmed `deposit`, the `accepted` watermark, a `pendingDeposit` when one exists, the `accept` last paid under, the `close` state once a close was requested, and the trajectory of paid requests. An entry that carried a deposit keeps the private transfer's signature (`depositSignature`), so the watcher's four checks can run on a recorded run later; it stays in this file, out of every log line, and `scripts/agent-run.ts` strips it from the trajectory it publishes under `docs/runs/`. No key material and no tokens. A file that is not this format is refused with `shielded_client_store_unreadable` and never overwritten. One buyer process at a time: two processes over one file do not coordinate.

## Options

| Option | Meaning |
| --- | --- |
| `buyerKeypair` | 64 bytes (seed then public key, Solana CLI format) or a 32-byte seed. Signs vouchers here and the deposit inside the rail. Never sent anywhere; a test asserts no request, header, rail call, log line or the channel file carries it in any encoding |
| `rail` | A `BuyerBinding`, or a function that builds one on the first 402. Default: `MagicBlockBuyer` from `paymentsApi`, `teeRpc`, `baseRpc`, `mint` (devnet USDC) |
| `channelStoreLocal` | Path of the channel file |
| `facilitatorUrl` | The facilitator's base URL, for `close()`: a close request goes to the facilitator, not through a vendor |
| `defaultDeposit` | Opening deposit when the accept names no `minDeposit`. Default 100 × the price |
| `fundingSource` | Recorded on each trajectory entry (channels funded through Aurora, task 8.3) |
| `beforePayment` | A spend policy, run once per paid request after the 402 is read and before any deposit or voucher: `{vendor, route, asset, amount, charge, privacyFeeBps}`. Throw to refuse; nothing is signed or sent and the error reaches the caller. The MCP server's caps live here |
| `log` | One line per event: channel ids, codes, statuses. Never an amount, a signature or a token |
| `network` | Devnet only; anything else is refused at construction |

## Trust boundary

The deposit and every voucher are private against the public ledger. Three operators see inside: the facilitator (it receives the vouchers, the signed deposit transaction and the amounts), MagicBlock's enclave (it executes the private transfer) and, for channels funded through Aurora Confidential Intents, NEAR's private shard (origin and route). The buyer's own vault deposit (`POST /v1/spl/deposit`) that creates its private balance is a base-layer transaction naming the buyer and the vault; it is not made here.

## Proof on devnet

`pnpm client:20` runs the facilitator (real MagicBlock binding) and the three vendors in process and pays twenty requests across them: three deposits (one per vendor, 100 × each route's price, 0.6 USDC in all), seventeen vouchers, three signatures emitted, none on the base layer. 1 Nov 2026: 20 served, 8 s. The buyer's private balance must hold the 0.6 USDC first: `pnpm fund:private --role buyer --usdc 1` moves devnet USDC from its base token account into its private balance with one public vault deposit.

## Dependencies

`@solana/kit` 8.6.0 (`createKeyPairFromBytes` for the rail, the `Address` type), `@wakeless/binding` (`BuyerBinding`), `@wakeless/binding-magicblock` (`MagicBlockBuyer`, the default rail), `@wakeless/scheme`. Tests run the real `@wakeless/vendor` middleware over the real `@wakeless/facilitator` app on a local port with a fake rail.
