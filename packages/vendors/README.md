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

Each vendor passes `alsoAcceptPublic: false`. Against the Wakeless facilitator `true` would change nothing: a plain `batch-settlement` entry needs `feePayer` and `receiverAuthorizer` from the facilitator's `/supported`, and this facilitator advertises only the shielded kind. There is no public fallback in the demo.

Each response is a function of `VENDORS_SEED` (default `wakeless`), the symbol and how many times that symbol was asked for: the same seed gives the same sequence. `/price` is a random walk moving at most 1.5% a step. There is no wall clock in the data; `asOf` is a logical time, one minute per step. The servers bind 127.0.0.1, read only the public key of each keypair, and refuse a key under `keys/mainnet/` and `MAINNET_ENABLED=true`.
