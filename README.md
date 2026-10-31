<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="brand/wordmark-light.svg">
  <img alt="Wakeless" src="brand/wordmark-light.svg" width="416">
</picture>

Wakeless is a shielded sibling of the x402 `batch-settlement` scheme on Solana: same 402 envelope, same headers, same facilitator endpoints, same voucher shape and lifecycle, with escrow and redemption inside a MagicBlock Private Ephemeral Rollup instead of the public payment-channels program, and channels fundable from any chain through Aurora Intents in confidential mode. The privacy claim is against the public ledger; three operators see inside: the facilitator (vouchers), MagicBlock's enclave (private transfers) and NEAR's private shard (funding origin and route).

Status: devnet alpha, unaudited

## What the devnet spike showed (31 Oct 2026)

`scripts/spike-magicblock.ts` ran the full private flow on devnet through MagicBlock's Private Payments API and the devnet TEE validator; the record is in [`docs/spike-log.md`](docs/spike-log.md) and the attestation in [`docs/attestation-devnet.json`](docs/attestation-devnet.json).

- The escrow → vendor private transfer executed inside the TEE validator and left no transaction on the base layer. In the run window no base transaction named the escrow together with the vendor, and none carried the payment amount. The base layer shows deposits into the Global Vault and withdrawals out of it; a vendor's withdrawal is public, with the vault as counterparty.
- `clientRefId` is not readable by the recipient: the private-balance endpoint returns only the balance and delegation status, and the TEE RPC returns an ephemeral transaction without accounts, logs or balances. A vendor's evidence of payment is its private-balance delta plus the facilitator-signed receipt.
- A `memo` would be appended to the ephemeral transaction, not the base layer. Wakeless never sets it.
- A recipient must hold a delegated ephemeral token account before it can be paid privately; it creates one with a deposit of its own. That onboarding is one public base transaction naming the recipient and the vault.
- On devnet the API's `cluster` must be `devnet-private` to reach the TEE validator (`devnet` is the public devnet validator). The API's login token is separate from the TEE RPC's, and transactions are confirmed on the layer `sendTo` names, not through the API's send endpoint.

Three operators still see inside: the facilitator, MagicBlock's enclave, and NEAR's private shard for funding. MagicBlock's own documentation says private transfers reduce linkability, not observability.

## How the scheme relates to the x402 standard

Wakeless keeps the x402 V2 envelope, the three transport headers, the facilitator endpoints and the standard 50-byte voucher, and advertises them under the scheme id `batch-settlement-shielded`. The SVM `batch-settlement` binding requires the canonical payment-channels program, so a shielded channel cannot use that id. [`docs/SCHEME.md`](docs/SCHEME.md) records, with spec line numbers, what is reused verbatim (fields, payload variants, the `invalid_batch_settlement_svm_*` error codes and `settlement_pending`), the exact voucher byte layout, every place the standard names the program, and the `accepts[]` entry with `extra.escrowAddress`, `extra.binding`, `extra.teeValidator` and `extra.privacyFeeBps`. New error codes take the `shielded_` prefix.
