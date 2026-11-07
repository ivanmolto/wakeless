# @wakeless/vendors

Status: devnet alpha, unaudited

Three synthetic data vendors behind [`@wakeless/vendor`](../vendor), each with its own port and keypair. The data is made up and every body says `synthetic: true`. Not published.

| Vendor | Route | Price (USDC atomic units) | Port | Keypair |
| --- | --- | --- | --- | --- |
| `vendor1` | `GET /price/:symbol` | 1000 | 4021 (`VENDOR1_PORT`) | `keys/vendor1.json` (`VENDOR1_KEYPAIR`) |
| `vendor2` | `GET /sentiment/:symbol` | 2000 | 4022 (`VENDOR2_PORT`) | `keys/vendor2.json` (`VENDOR2_KEYPAIR`) |
| `vendor3` | `GET /news/:symbol` | 3000 | 4023 (`VENDOR3_PORT`) | `keys/vendor3.json` (`VENDOR3_KEYPAIR`) |

```bash
pnpm keys
pnpm --filter @wakeless/facilitator start
pnpm vendors
curl -i http://127.0.0.1:4021/price/SOLX
```

`FACILITATOR_URL` defaults to `http://127.0.0.1:4020`. Without a facilitator the vendors still start, and every paid route answers `402` with code `shielded_facilitator_unavailable` and an empty `accepts[]`.

## Before a vendor can be paid

A vendor must make one private deposit of its own into the rail before the enclave will accept a transfer to it. Until it has, every redemption to that vendor is refused with `shielded_binding_rejected` (the Payments API's code `TEE_INGRESS`); the facilitator records the refusal as terminal, never retries it, never sends it as a public transfer, and the amount stays owed in escrow. Nothing reaches the base layer, so this is not a privacy failure, but the vendor does not get paid.

```bash
pnpm fund:private --role vendor2 --usdc 0.01
```

The vendor's base token account needs the USDC first (and the key some SOL for the fee). The deposit is one public base-layer transaction that names the vendor and the vault, with the amount in clear: onboarding, not a payment, and the watcher lists it as such. This is observed behaviour (31 Oct spike, confirmed 7 Nov when onboarding `vendor2` and `vendor3` turned two refusals into two landed transfers); MagicBlock does not document it, so treat the explanation as the best reading of what the rail does, not as a specification.

Each vendor passes `alsoAcceptPublic: false`. Against the Wakeless facilitator `true` would change nothing: a plain `batch-settlement` entry needs `feePayer` and `receiverAuthorizer` from the facilitator's `/supported`, and this facilitator advertises only the shielded kind. There is no public fallback in the demo.

## Receipt reader

```bash
pnpm vendor:receipts --vendor 1
```

A vendor's own report of what it has been paid (`src/receipts.ts`, CLI in `scripts/vendor-receipts.ts`). It logs in to the attested TEE RPC and the Payments API with `keys/vendorN.json` (`MagicBlockPayee`; the attestation report goes to `docs/attestation-vendor.json`), reads the vendor's private balance and any reference ids the rail exposes (none: the rail returns no `clientRefId` to a recipient), lists the vendor's channels from `GET /admin/channels?vendor=…` (`FACILITATOR_ADMIN_TOKEN`; loopback only), fetches each channel's receipts from `GET /receipts/:channelId` with the vendor's entry in `FACILITATOR_RECEIPT_TOKENS`, verifies the facilitator's signature on each against the signer `/supported` advertises, and asks the rail, under the vendor's own login, whether each private transfer landed. It prints one row per receipt, `channel, period, cumulative, received, transfer, rail, verified`, one line per channel with the facilitator's `accepted`, `settled`, owed and settle-operation counts, and a `MISMATCH <code>` line for each disagreement:

| Code | Means |
| --- | --- |
| `receipts_unavailable` | `/admin/channels` lists the channel but `/receipts` will not serve it to this vendor |
| `receipt_malformed` | A receipt does not parse |
| `signer_unadvertised` | The receipts name a signer `/supported` does not advertise |
| `unverified` | The facilitator signature does not verify against an advertised signer |
| `channel_id`, `vendor` | A receipt or the listing names another channel or vendor |
| `receipt_count` | Receipts differ in number from confirmed settle operations (a reconciled operation has no signed receipt) |
| `period_sequence` | Periods are not 1, 2, 3, … |
| `amount_exceeds_period` | A receipt pays more than its period's increase in cumulative |
| `cumulative_settled` | The last receipt's cumulative differs from the channel's `settled` |
| `duplicate_transfer` | Two receipts name the same transfer |
| `transfer_not_landed` | The rail answers `not_found` or `failed` for the transfer under the vendor's login |

`test/receipts.devnet.test.ts` (`pnpm test:devnet`) is the definition of done: five paid calls to vendor1 through the real client, middleware and facilitator, one `POST /admin/redeem`, then the reader logged in to the attested TEE with `keys/vendor1.json`; the table equals the facilitator's stores, the receipt verifies, the rail answers `landed` for the transfer under vendor1's own login, and nothing is flagged. It needs the buyer's private balance at 0.6 USDC (`pnpm fund:private --role buyer --usdc 1` moves devnet USDC from the buyer's base token account into its private balance; one public base-layer vault deposit).

It exits 1 on any mismatch or unverified receipt. Amounts are base units of USDC. The report is the vendor's own terminal output, not a log: it carries amounts, but transfer signatures are shortened to `first8…last8` unless `--full-signatures` is given (to look one up on the TEE RPC), and tokens and keys are never printed (every line is scrubbed of both and of any long base58 run other than the signatures asked for). Every report carries the line "rail confirms only that each transfer exists and succeeded; amount, period and cumulative are the facilitator's signed claim", so `verified: yes` is read for what it is: the facilitator's signature checks out, not an independent audit of the amount. Devnet only: a mainnet RPC hostname, a key under `keys/mainnet/` or `MAINNET_ENABLED=true` refuses to start. What the vendor can confirm on the rail is that a transfer exists and succeeded; the amount and the period come from the facilitator's signed receipt. The facilitator, MagicBlock's enclave and NEAR's private shard still see inside; the report says nothing about the public ledger.

Each response is a function of `VENDORS_SEED` (default `wakeless`), the symbol and how many times that symbol was asked for: the same seed gives the same sequence. `/price` is a random walk moving at most 1.5% a step. There is no wall clock in the data; `asOf` is a logical time, one minute per step. The servers bind 127.0.0.1, read only the public key of each keypair, and refuse a key under `keys/mainnet/` and `MAINNET_ENABLED=true`.
