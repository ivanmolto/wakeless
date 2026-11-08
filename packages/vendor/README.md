# @wakeless/vendor

Status: devnet alpha, unaudited

The seller side of the `batch-settlement-shielded` scheme: a Hono middleware that puts a price on a route and leaves the payment to a Wakeless facilitator.

```ts
import { Hono } from "hono";
import { x402Shielded } from "@wakeless/vendor";

const app = new Hono();
app.use("*", x402Shielded({
  facilitatorUrl: process.env.FACILITATOR_URL ?? "http://127.0.0.1:4020",
  payTo: vendorAddress, // base58; needs one private deposit of its own on the rail (below)
  amountPerRoute: { "/price/:symbol": "1000" }, // atomic units; :name is one segment, * the rest
  maxTimeoutSeconds: 60,
}));
app.get("/price/:symbol", (c) => c.json({ symbol: c.req.param("symbol"), price: 1 }));
```

`npm install @wakeless/vendor@0.1.0-alpha.0 hono@4.13.14`. ESM only, Node 22 or later. Serve `app` with any Hono adapter (`@hono/node-server` in this repo).

`asset` (devnet USDC), `tokenProgram` (SPL Token), `withdrawDelay` (3600), `minDeposit` (100 times the route's price) and `facilitatorTimeoutMs` (15000) are optional and have those defaults. A path that matches no key in `amountPerRoute` passes through free.

## What it does

| Request | Response |
| --- | --- |
| No `PAYMENT-SIGNATURE` | `402` with a base64 `PAYMENT-REQUIRED`: the shielded entry of `accepts[]`, with `escrowAddress`, `binding`, `teeValidator`, `privacyFeeBps` and `maxIdleSecs` copied from the facilitator's `/supported` |
| Malformed `PAYMENT-SIGNATURE` | `400`, `invalid_payload` or `invalid_x402_version`; the facilitator is not asked |
| `accepted` is not an entry this route offers | `402`, `invalid_payment_requirements`; the facilitator is not asked. Price and `payTo` are always the route's own. The match ignores `extra.minDeposit`, `extra.channelState` and `extra.voucherState`, which are a target and corrective state, not terms, so a buyer may echo a corrective entry; the entry forwarded to the facilitator as `accepted` is the route's own |
| `/verify` refuses | `402` with the facilitator's code, the resource does not run |
| `/verify` refuses the cumulative: `invalid_batch_settlement_svm_cumulative_exceeds_deposit` or `invalid_batch_settlement_svm_cumulative_amount_mismatch` | A corrective `402` (spec section 4.6): the shielded entry carries `extra.channelState` (the channel as the facilitator holds it, with `chargedCumulativeAmount`) and, once a voucher was accepted, `extra.voucherState` (the buyer's own last voucher, for the buyer to verify before adopting the watermark). Above the deposit, `extra.minDeposit` becomes the route's target or the shortfall, whichever is larger, so one top-up makes the refused voucher fit. Nothing of this reaches the ledger |
| `/verify` passes | The resource runs. A response of 400 or above is returned as it is and nothing settles. Otherwise `/settle`: on success the response goes out with a base64 `PAYMENT-RESPONSE`; on failure it is withheld and replaced by a `402` carrying the code and the failed `PAYMENT-RESPONSE` |
| Facilitator unreachable, timed out, or answering 5xx, at any step | `402` with code `shielded_facilitator_unavailable`, `retryable: true`, and an empty `accepts[]`, so no client deposits into a channel it cannot use. No resource |
| Facilitator's binding failed attestation | `402` with code `shielded_attestation_failed`, `retryable: false`, and an empty `accepts[]` |
| Facilitator answers 429 `shielded_rate_limited` at `/verify` or `/settle` | `402` with that code and `retryable: true`; the resource is withheld (after `/settle`, replaced). The buyer sends the same request again after a wait; `docs/RECOVERY.md` has the rows |
| Facilitator advertises no devnet kind | `402` with code `shielded_facilitator_unavailable`. A mainnet kind is refused |

| `RELATIONSHIP_TERMS=true` only: `accepted` is the route's standard entry and this buyer's terms differ | `402`, `shielded_terms_quoted`, `retryable: true`, with the buyer's entry and its signed `extra.termsReceipt`; the facilitator is not asked. The buyer pays once more against that entry (`@wakeless/client` does) |

A refusal's body is `{error, code, retryable}`, the same triple the facilitator uses; `PaymentRequired.error` in the header holds the same code. Match on the code, never on the message. `shielded_facilitator_unavailable` is a Wakeless code that the x402 specification does not define.

`/supported` is reused for 5 seconds. Only an answer is kept; a failure is asked again on the next request. So an unpaid request can still list the entry for a few seconds after the facilitator goes away, but a paid one always reaches `/verify` and fails closed there.

## `alsoAcceptPublic`

The standard requires a plain `batch-settlement` entry to copy `feePayer` and `receiverAuthorizer` from the facilitator's `/supported`. The entry is therefore listed only when the facilitator advertises that kind on the same network. The Wakeless facilitator does not, since it settles only the shielded scheme, so against it `alsoAcceptPublic: true` adds nothing. A plain entry is a public rail: the buyer, the vendor and the amounts are readable on the ledger.

## Before the vendor can be paid

The `payTo` key must have made one private deposit of its own into the rail (`pnpm fund:private --role <vendor> --usdc 0.01` in this repo, or any `POST /v1/spl/deposit` with `private: true` signed by that key) before the enclave accepts a transfer to it. Without one the facilitator's redemption is refused with `shielded_binding_rejected` (`TEE_INGRESS`), recorded as terminal and left owed in escrow; `GET /receipts/:channelId` lists it under `rejected`. The deposit is a public base-layer transaction naming the vendor and the vault. Observed behaviour of the devnet rail, not documented by MagicBlock; see `@wakeless/vendors` for the account.

## Relationship terms (experimental, off by default)

With `RELATIONSHIP_TERMS=true` and a `terms` option, the middleware quotes each buyer from this vendor's own private history with it (briefing §3c; [`docs/TERMS.md`](../../docs/TERMS.md), generated): `amountPerRoute` becomes the standard price, and the entry a buyer gets carries its price as `amount`, its funding requirement as `extra.minDeposit`, and a vendor-signed `extra.termsReceipt` the buyer keeps. Policy `terms@1`: relationship capital of 250 bps per clean period (a redeemed period with nothing owed) up to 2500; a risk premium of 2000 bps for `close_with_unpaid` and 1000 bps for `repeated_exceeds_deposit`; 20 calls' funding for an unknown buyer, down to 5 with capital, 50 with an incident. An unknown buyer, including a rotated address, gets standard terms and never better.

```ts
import { FileTermsHistory, termsIfEnabled, x402Shielded } from "@wakeless/vendor";

x402Shielded({
  facilitatorUrl, payTo, amountPerRoute: { "/price/:symbol": "1000" },
  terms: termsIfEnabled(process.env, () => ({ signer: { secretKey: vendorKeyBytes }, history: new FileTermsHistory("~/.wakeless/terms-vendor1.json") })),
});
```

The history is this vendor's state: one JSON file, never sent to the facilitator (the receipt is stripped from the forwarded entry), never shared between vendors, never on chain. It is fed by the middleware's own `/verify` outcomes (`history.corrective`), by the facilitator receipts the vendor reads (`history.redeemed`) and by closes (`history.closed`). With the flag off (anything but the string `true`) `termsIfEnabled` returns `undefined` and the middleware is byte-for-byte what it was. `pnpm terms:demo` in this repo shows two buyers, one route, two receipt cards and an empty observer table. Vocabulary is locked ([`docs/VOCABULARY.md`](../../docs/VOCABULARY.md)).

## What this protects

The privacy claim is against the public ledger. Three operators see inside in v1: the facilitator (vouchers), MagicBlock's enclave (private transfers) and NEAR's private shard (funding origin and route). The vendor sees its own buyers' addresses in `PAYMENT-SIGNATURE`, and the middleware logs nothing.
