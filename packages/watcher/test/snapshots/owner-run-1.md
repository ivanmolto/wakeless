Amounts are USDC base units (6 decimals). Only the owner holds this view. Inside the rail, the facilitator sees the vouchers and deposits, MagicBlock's enclave sees the private transfers, and NEAR's private shard sees a funding's origin and route; the public ledger shows none of it.

- **Payer:** `3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba`

### Paid calls

| # | Time (UTC) | Vendor | Route | Amount | Cumulative |
| ---: | --- | --- | --- | ---: | ---: |
| 1 | 2026-11-01 19:24:33.493Z | `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` | /price/SOL | 1000 | 1001 |
| 2 | 2026-11-01 19:24:51.696Z | `3Qdg6oJAoe6uHE7zeDGz9TNvmrQRRWAYrMEqJyPZm9Sc` | /sentiment/SOL | 2000 | 2002 |
| 3 | 2026-11-01 19:25:10.032Z | `5Vckjt8WpuA4gWv13qqHKe4jnA5BQyUedrGUZhSLKFtJ` | /news/SOL | 3000 | 3003 |
| 4 | 2026-11-01 19:25:10.054Z | `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` | /price/BTC | 1000 | 2002 |
| 5 | 2026-11-01 19:25:10.071Z | `3Qdg6oJAoe6uHE7zeDGz9TNvmrQRRWAYrMEqJyPZm9Sc` | /sentiment/BTC | 2000 | 4004 |
| 6 | 2026-11-01 19:25:10.088Z | `5Vckjt8WpuA4gWv13qqHKe4jnA5BQyUedrGUZhSLKFtJ` | /news/BTC | 3000 | 6006 |
| 7 | 2026-11-01 19:25:10.104Z | `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` | /price/ETH | 1000 | 3003 |
| 8 | 2026-11-01 19:25:10.119Z | `3Qdg6oJAoe6uHE7zeDGz9TNvmrQRRWAYrMEqJyPZm9Sc` | /sentiment/ETH | 2000 | 6006 |
| 9 | 2026-11-01 19:25:10.135Z | `5Vckjt8WpuA4gWv13qqHKe4jnA5BQyUedrGUZhSLKFtJ` | /news/ETH | 3000 | 9009 |

### Fundings, deposits and refunds

| Time (UTC) | Kind | Vendor | Amount | Note |
| --- | --- | --- | ---: | --- |
| 2026-11-01 19:24:33Z | deposit | `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` | 100000 | private transfer to the escrow, with /price/SOL |
| 2026-11-01 19:24:51Z | deposit | `3Qdg6oJAoe6uHE7zeDGz9TNvmrQRRWAYrMEqJyPZm9Sc` | 200000 | private transfer to the escrow, with /sentiment/SOL |
| 2026-11-01 19:25:10Z | deposit | `5Vckjt8WpuA4gWv13qqHKe4jnA5BQyUedrGUZhSLKFtJ` | 300000 | private transfer to the escrow, with /news/SOL |

### Totals per vendor

| Vendor | Paid calls | Net to vendor | Spend, fees included | Deposited | Refunded | Unspent in escrow |
| --- | ---: | ---: | ---: | ---: | ---: | ---: |
| `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` | 3 | 3000 | 3003 | 100000 | 0 | 96997 |
| `3Qdg6oJAoe6uHE7zeDGz9TNvmrQRRWAYrMEqJyPZm9Sc` | 3 | 6000 | 6006 | 200000 | 0 | 193994 |
| `5Vckjt8WpuA4gWv13qqHKe4jnA5BQyUedrGUZhSLKFtJ` | 3 | 9000 | 9009 | 300000 | 0 | 290991 |
| **Total** | 9 | 18000 | 18018 | 600000 | 0 | 581982 |

### Private balance

Read through the attested TEE RPC. The rail returns the current balance only; these are the readings the owner took.

| Time (UTC) | Reading | Balance | USDC |
| --- | --- | ---: | ---: |
| 2026-11-01 19:13:18Z | before run-1 (agent-run) | 3990000 | 3.990000 |

Expected after the last movement (2026-11-01 19:25:10Z): 3990000 − deposits 600000 + refunds 0 − withdrawals 0 = **3390000** (3.390000 USDC).
No reading after the last movement to compare with.
