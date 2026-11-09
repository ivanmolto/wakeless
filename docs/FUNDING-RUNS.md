# Funding runs on mainnet

Status: devnet alpha, unaudited. Task 10.3, run on 2026-11-09 with `MAINNET_ENABLED=true` and `DEMO_CONFIRM` set for the day, then reset. Three `wakeless fund` runs through Aurora Intents in confidential mode (`confidentiality: "advanced"`, `docs/FUNDING.md`): two successes, one deliberate refund. Total sent from the operator's wallet: 5 USDC gross, about 4 USDC net after the refund, under the task's 10 USDC ceiling; `FUND_MAX_USDC` stayed at its default of 5.

The privacy claim is against the public ledger. Three operators see inside in v1: the facilitator (vouchers), MagicBlock's enclave (private transfers) and NEAR's private shard (funding origin and route). What confidential mode hides is the path from the origin deposit to the Solana arrival; both endpoints are public on their own chains, and the edge-correlation caveat in `docs/FUNDING.md` applies in full.

| Run | Origin chain | Amount sent | Quote (deposit address) | Origin tx | Solana arrival signature | Amount received | Buyer address | Result | Time (UTC) |
| --- | --- | --- | --- | --- | --- | --- | --- | --- | --- |
| 1 | Base | 2 USDC | `0x10a8…Aa5E` | `0x7e44…ccc3` | `64rqQTiM…LThdc` | 1.765033 USDC | `Cng3…KUqZ` | `SETTLED` (SUCCESS) | deposit 02:05:27, arrival 02:07:03 |
| 2 | Arbitrum | 2 USDC | `0x6ABA…D8e6` | `0x1ca5…9593` | `QXQVALf5…E5wv` | 1.764938 USDC | `ApSE…ztrX` | `SETTLED` (SUCCESS) | deposit 02:13:32, arrival 02:15:05 |
| 3 | Base | 1 USDC against a 2 USDC quote | `0x8E61…361C` | `0x935b…224b` | none | 0 | `Cng3…KUqZ` | `REFUNDED` | deposit 02:20:12, refund 02:39:14 |

Aurora identifies an intent by its deposit address; the module keeps no separate quote id. Full values and explorer links are in the run sections. The three origin transactions were paid by hand from the operator's wallet `0x7904667C340601AaB73939372C016dC5102732A2`, which is also `refundTo` on every quote.

## Run 1: 2 USDC from Base, SUCCESS

Command: `pnpm fund --from base --amount 2 --confirm <DEMO_CONFIRM> --no-wait`. Quote at 02:04:25 UTC: 2 USDC on Base to `Cng3ux9iYH8Mzq16NaP13wjXCyuBK811YTDQB7spKUqZ`, 1.764763 USDC promised after Aurora's fees, refund deadline 02:24:25 UTC, deposit address `0x10a8E8b4Be37a5ad93B90AE6CdAF46196442Aa5E`.

- Origin transaction, Base: [0x7e44dd4feccb4fd1f31ee2cb44097e4d1ce35a95ab998671cc2864dce0a4ccc3](https://basescan.org/tx/0x7e44dd4feccb4fd1f31ee2cb44097e4d1ce35a95ab998671cc2864dce0a4ccc3), block 54997757 at 02:05:27 UTC, 2 USDC from the operator's wallet to the deposit address.
- Status seen by the module: `PENDING_DEPOSIT`, `PROCESSING`, `SUCCESS`.
- Solana arrival: [64rqQTiMauJgbx6CopLaX6qxCWow1x9BsQXjmfcF1LFCBLDmHkbRhJrQMuoN7uWA3t3YB2Zk4uvYbnobEN6LThdc](https://solana.fm/tx/64rqQTiMauJgbx6CopLaX6qxCWow1x9BsQXjmfcF1LFCBLDmHkbRhJrQMuoN7uWA3t3YB2Zk4uvYbnobEN6LThdc?cluster=mainnet-alpha), slot 467143897 at 02:07:03 UTC, 98 s after the origin deposit. 1.765033 USDC received at the buyer's USDC account `8repsh7isb31rqS5L6pgbEuEH7K8d5n8wSJnkbvY7rrg`, created in the same transaction, so the recipient needed no SOL.
- The origin wallet does not appear on the Solana side, verified by reading the arrival transaction's accounts (`getTransaction`, read-only): 21 account keys, one signer `DuSs7rCr7oTLHjM29QQ8NwDViaahTU58qqxaJVyAkgbn` (Aurora's relayer), the transfer made by authority `FvULawNPGBbuwYus74ECaQoV1oH9Tk6XPN7VPN51NYds` through the OMFT bridge program `dahPEoZGXfyV58JqqH85okdHmpN8U2q8owgPUXSCPxe` with Wormhole, no Memo instruction, and no byte of `0x7904…32A2` anywhere in the transaction.
- Delay before the channel deposit: none in this task. `--no-wait` was passed because 10.3 makes no channel deposit; the mainnet demo runner of task 13.1 picks the funds up with its own randomised delay.

## Run 2: 2 USDC from Arbitrum, SUCCESS

Command: `pnpm fund --from arbitrum --amount 2 --to ApSESVmGtn8vN2dM6pZQi5e3Mb4be1VRpKwzHVszztrX --confirm <DEMO_CONFIRM> --no-wait`. A fresh buyer address, as `docs/FUNDING.md` advises, so each arrival links to one address. Quote at 02:10:54 UTC: 2 USDC on Arbitrum, 1.765404 USDC promised, refund deadline 02:30:54 UTC, deposit address `0x6ABA4037Fe62c0fE71EA8BE837a68A03625DD8e6`.

- Origin transaction, Arbitrum: [0x1ca54a65dd05da49055cb4b1d1597aecd69d1fc4af2adf76b239662a57e59593](https://arbiscan.io/tx/0x1ca54a65dd05da49055cb4b1d1597aecd69d1fc4af2adf76b239662a57e59593), block 522540833 at 02:13:32 UTC, 2 USDC (native USDC) from the operator's wallet to the deposit address.
- Status seen by the module: `PENDING_DEPOSIT`, `PROCESSING`, `SUCCESS`.
- Solana arrival: [QXQVALf5MFr9rpFfU4wcthcmtXZeY6kMCPEZMWiixNYNEsd7goEcAVhysmoSL74qu55pHrCJjP7TfRn5FAFE5wv](https://solana.fm/tx/QXQVALf5MFr9rpFfU4wcthcmtXZeY6kMCPEZMWiixNYNEsd7goEcAVhysmoSL74qu55pHrCJjP7TfRn5FAFE5wv?cluster=mainnet-alpha), slot 467146144 at 02:15:05 UTC, 93 s after the origin deposit. 1.764938 USDC received at `HG5tvAQWEKJ58brsUYipwWh8rPzfXuF8MzmCMvXki6J2`, created in the same transaction.
- The origin wallet does not appear on the Solana side, verified the same way: 21 account keys, the same relayer signer and bridge program, no Memo, no trace of `0x7904…32A2`.

## Run 3: 1 USDC against a 2 USDC quote from Base, REFUNDED

Command: `pnpm fund --from base --amount 2 --confirm <DEMO_CONFIRM> --no-wait`, then a deliberate underpayment. Quote at 02:18:35 UTC: 2 USDC on Base to `Cng3ux9iYH8Mzq16NaP13wjXCyuBK811YTDQB7spKUqZ`, 1.98879 USDC promised (the buyer's USDC account exists since run 1, so Aurora no longer prices its creation into the fee), refund deadline 02:38:35 UTC, `refundTo` `0x7904667C340601AaB73939372C016dC5102732A2`, deposit address `0x8E612f3251B8236e9e1687b59a83ee11e716361C`.

- Origin transaction, Base: [0x935ba7c47949f60c290a54b8dbbdfba9a8004b3b77d818b6664c94caf1d6224b](https://basescan.org/tx/0x935ba7c47949f60c290a54b8dbbdfba9a8004b3b77d818b6664c94caf1d6224b), block 55002185 at 02:20:12 UTC, 1 USDC from the operator's wallet to the deposit address: half the quoted amount.
- Status seen by the module: `PENDING_DEPOSIT`, `INCOMPLETE_DEPOSIT` (from 02:21 UTC, as soon as the 1 USDC was seen), then `REFUNDED` at 02:39 UTC, 39 s after the refund deadline the quote carried. The module printed `REFUNDED: returned to 0x7904667C340601AaB73939372C016dC5102732A2 on base; nothing arrived on Solana` and exited 0. The status body was `{"status": "REFUNDED"}`, nothing more.
- Refund at `refundTo`: [0x0abf59fbd599bd4fee1d5a3e38ab20294a61acfa8336d249cfec1e856c149fb0](https://basescan.org/tx/0x0abf59fbd599bd4fee1d5a3e38ab20294a61acfa8336d249cfec1e856c149fb0), block 55007894 at 02:39:14 UTC, 0.9976 USDC from Aurora's refund sender `0x2cff890f0378a11913b6129b2e97417a2c302680` to the operator's wallet: the 1 USDC sent minus the 0.0024 USDC `refundFee` the dry-run quote named for Base.
- Nothing arrived on Solana: the recipient's page shows run 1's arrival only, [Cng3ux9iYH8Mzq16NaP13wjXCyuBK811YTDQB7spKUqZ](https://solana.fm/address/Cng3ux9iYH8Mzq16NaP13wjXCyuBK811YTDQB7spKUqZ?cluster=mainnet-alpha).
- Method: a partial deposit, the refund path `docs/FUNDING.md` describes. Nothing about refunds was confirmed at the Aurora workshop (it covered the Swap, Deposit and Intents Connect products), so this is the documented 1Click behaviour the module already reads, not a method agreed with Aurora; recorded in `docs/DEVIATIONS.md`.

## What the module did not record, and why

In confidential mode Aurora's status endpoint answers a bare `{"status": "SUCCESS"}`: no `swapDetails`, no destination or origin transaction hashes, no amounts. The module's SUCCESS branch expects the 1Click `destinationChainTxHashes` field (its fixtures were written from the 1Click schema since no live swap had been observed, `docs/FUNDING.md`), so on both successes it printed `SUCCESS reported without a destination transaction; nothing recorded. Ask Aurora for the Solana arrival before depositing` and exited 1 without writing a `fundingSource` entry. The arrivals above were found by reading each recipient's address on Solana (`getSignaturesForAddress`, `getTransaction`), which is also how the mainnet demo runner will have to find them. The runs are successes on both chains; the module's exit code is the finding, kept in `docs/DEVIATIONS.md` for task 13.1.

Fees observed: a flat withdraw fee of about 0.235 USDC on a 2 USDC swap when the arrival creates the recipient's token account (runs 1 and 2, about 11.8%), and about 0.011 USDC when it does not (run 3's quote, 0.6%). The dry run's 0.2548 USDC at 5 USDC (`docs/aurora-dry-run.md`) was the first case.

## Reproduce the checks

Read-only, no key: `getTransaction` with `jsonParsed` on each arrival signature through any mainnet RPC, and compare the account keys with the operator's wallet; `eth_getLogs` on the USDC contract of the origin chain (`0x833589fCD6eDb6E08f4c7C32D4f71b54bdA02913` on Base, `0xaf88d065e77c8cC2239327C5EDb3A432268e5831` on Arbitrum) filtered on the deposit address finds each origin transfer.
