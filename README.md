<picture>
  <source media="(prefers-color-scheme: dark)" srcset="brand/wordmark-dark.svg">
  <source media="(prefers-color-scheme: light)" srcset="brand/wordmark-light.svg">
  <img alt="Wakeless" src="brand/wordmark-light.svg" width="416">
</picture>

Wakeless is a shielded sibling of the x402 `batch-settlement` scheme on Solana: same 402 envelope, same headers, same facilitator endpoints, same voucher shape and lifecycle, with escrow and redemption inside a MagicBlock Private Ephemeral Rollup instead of the public payment-channels program, and channels fundable from any chain through Aurora Intents in confidential mode. The privacy claim is against the public ledger; three operators see inside: the facilitator (vouchers), MagicBlock's enclave (private transfers) and NEAR's private shard (funding origin and route).

Status: devnet alpha, unaudited
