# @wakeless/vendor

Status: devnet alpha, unaudited

The seller side of the `batch-settlement-shielded` scheme: a Hono middleware that puts a price on a route and leaves the payment to a Wakeless facilitator.

```ts
import { Hono } from "hono";
import { x402Shielded } from "@wakeless/vendor";

const app = new Hono();
app.use(
  "*",
  x402Shielded({
    facilitatorUrl: "http://127.0.0.1:4020",
    payTo: vendorAddress,
    amountPerRoute: { "/price/:symbol": "1000" }, // atomic units; :name is one segment, * the rest
    maxTimeoutSeconds: 60,
    alsoAcceptPublic: false,
  }),
);
app.get("/price/:symbol", (c) => c.json({ price: 1 }));
```

`asset` (devnet USDC), `tokenProgram` (SPL Token), `withdrawDelay` (3600), `minDeposit` (100 times the route's price) and `facilitatorTimeoutMs` (15000) are optional and have those defaults. A path that matches no key in `amountPerRoute` passes through free.

## What it does

| Request | Response |
| --- | --- |
| No `PAYMENT-SIGNATURE` | `402` with a base64 `PAYMENT-REQUIRED`: the shielded entry of `accepts[]`, with `escrowAddress`, `binding`, `teeValidator`, `privacyFeeBps` and `maxIdleSecs` copied from the facilitator's `/supported` |
| Malformed `PAYMENT-SIGNATURE` | `400`, `invalid_payload` or `invalid_x402_version`; the facilitator is not asked |
| `accepted` is not an entry this route offers | `402`, `invalid_payment_requirements`; the facilitator is not asked. Price and `payTo` are always the route's own |
| `/verify` refuses | `402` with the facilitator's code, the resource does not run |
| `/verify` passes | The resource runs. A response of 400 or above is returned as it is and nothing settles. Otherwise `/settle`: on success the response goes out with a base64 `PAYMENT-RESPONSE`; on failure it is withheld and replaced by a `402` carrying the code and the failed `PAYMENT-RESPONSE` |
| Facilitator unreachable, timed out, or answering 5xx, at any step | `402` with code `shielded_facilitator_unavailable`, `retryable: true`, and an empty `accepts[]`, so no client deposits into a channel it cannot use. No resource |
| Facilitator's binding failed attestation | `402` with code `shielded_attestation_failed`, `retryable: false`, and an empty `accepts[]` |
| Facilitator advertises no devnet kind | `402` with code `shielded_facilitator_unavailable`. A mainnet kind is refused |

A refusal's body is `{error, code, retryable}`, the same triple the facilitator uses; `PaymentRequired.error` in the header holds the same code. Match on the code, never on the message. `shielded_facilitator_unavailable` is a Wakeless code that the x402 specification does not define.

`/supported` is reused for 5 seconds. Only an answer is kept; a failure is asked again on the next request. So an unpaid request can still list the entry for a few seconds after the facilitator goes away, but a paid one always reaches `/verify` and fails closed there.

## `alsoAcceptPublic`

The standard requires a plain `batch-settlement` entry to copy `feePayer` and `receiverAuthorizer` from the facilitator's `/supported`. The entry is therefore listed only when the facilitator advertises that kind on the same network. The Wakeless facilitator does not, since it settles only the shielded scheme, so against it `alsoAcceptPublic: true` adds nothing. A plain entry is a public rail: the buyer, the vendor and the amounts are readable on the ledger.

## What this protects

The privacy claim is against the public ledger. Three operators see inside in v1: the facilitator (vouchers), MagicBlock's enclave (private transfers) and NEAR's private shard (funding origin and route). The vendor sees its own buyers' addresses in `PAYMENT-SIGNATURE`, and the middleware logs nothing.
