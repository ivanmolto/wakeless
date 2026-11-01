# Public rail log: Solana devnet

Two baselines on the public rail: `batch-settlement` (this section through "What an observer rebuilds") and the `exact` scheme (section "exact, per call").

Task 2.3. The "before" picture: the stock x402 `batch-settlement` facilitator, server and client examples from `vendor/x402/examples/typescript` (checkout `e208bd3`, unmodified) run against Solana devnet, CAIP-2 `solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1`, on 2026-10-31 between 22:59:21 and 22:59:41 UTC. Ten paid requests to `GET /weather` at `$0.01` each (`10000` atomic USDC, mint `4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU`), then the server's redemption worker claimed and settled. Every fact below was read back from the devnet ledger through `getTransaction` (`jsonParsed`) and `getAccountInfo`; the raw responses are in `docs/public-rail-observed.json`. Nothing here is from the facilitator's, server's or client's logs.

Roles, all devnet:

| Role | Address | Key |
| --- | --- | --- |
| Payer (client) | `94BRf9UjVLdNUBGGeKuFqWSk4sA67EDtAmS9pm6RTjzT` | the CLI keypair, `~/.config/solana/devnet.json` |
| payTo (server receiver) | `9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy` | fresh, `keys/public-rail/payto.json` |
| Facilitator fee payer (`extra.feePayer`, channel `payee` and `rent_payer`) | `7re7bveMuceHWqgFum4Ncq1NKAYjyxKCQJbFY2C6QFNt` | fresh, `keys/public-rail/facilitator.json` |
| Receiver authorizer (`extra.receiverAuthorizer`) | `BgNduYkRLcfyScrbKpd5FVd9o9heJ5uUbizrhmDdGAWM` | fresh, `keys/public-rail/receiver-authorizer.json` |
| Channel PDA | `B3vHFnqZTLHXcvczbzhTv2enAsg6CjmvmtjqvyPiukSQ` | derived (salt `0`, open slot `517292432`) |
| Payment-channels program | `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` | canonical, same id on devnet and mainnet |

The 402 advertised `amount: "10000"`, `minDeposit: "100000"`, `withdrawDelay: 900`, `voucherSigner` client (default). The client deposited `minDeposit` exactly, so the ten requests fit one channel with no top-up.

## Signatures

### The rail: three on-chain transactions for ten calls

| # | Role | Signature | Slot | Time (UTC) | Fee (lamports) |
| --- | --- | --- | --- | --- | --- |
| 1 | `open` (deposit, request 1) | `4CjgcqkYFVk5g1o92b67VL73FnxhJo4eyz56nBSHzyqmYHu7KqoW5rjYf7qxELTUrTpeixWJwRxrSifLynjwshjz` | 517292446 | 22:59:21 | 10001 |
| 2 | `settle` (claim of the latest voucher) | `4UkRoSZNzxCsJxGYsuRJxuYWpQrbBbXNHwD8bR9W4P4h2XgpV8XmRRQbfwwQjZsZW3rnxcSa53MC6B4KHHjnZSVX` | 517292520 | 22:59:39 | 10001 |
| 3 | `distribute` (settle, payout to payTo) | `4gQrESh5wjKkMBqzymEpbbXKXE9ksFHAuHULoEYVJdoVdmPxeAQ3U85mZBtfP18sSzHrv1ubrm1TpRf8ayUbqszM` | 517292528 | 22:59:41 | 5001 |

Requests 2 to 10 produced no transaction: each was a client-signed cumulative voucher sent in the `PAYMENT-SIGNATURE` header and accepted off-chain by the server. The claim and the payout ran in the server's first redemption pass, 60 s after start, and settled the whole `100000` in one voucher.

### Setup, outside the rail

These funded the roles and are not part of the baseline. They are listed because an observer who widens the window sees them too, and they link the payer to the project's other devnet keys.

| Signature | What it is | Who signed | Public link it creates |
| --- | --- | --- | --- |
| `4RC7UvaUK5SeZGcB7t684rrwPgX3QJmLLU61FiKMFxXoRyP9q9ps75isKiA427YVPiTvJzq9J1hHsH6imgJAPNWh` | 1 SOL to the facilitator fee payer | payer `94BR…TjzT` | payer funds the facilitator |
| `3DqHfD8cRnNTG9HFUgBeckv1H5CKMwqZwUr377RHx2k5hns7hAeaW3sexYQRCg89LQTesmFLavZGvn7abqkMEo2h` | 1 USDC to the payer, creating its ATA `E8YR…u2sj` | `keys/buyer.json` `3sWw…npba` | buyer key funds the payer |
| `2C9fTFrk8bJzU5n6JRfdcpBboaerYxxUdixSzBgq2zyM6r6SZNTuHVe2HFuFFvsm35ZKjsSviVqGPaR1m4gvxjh5` | payTo's USDC ATA `GFLE…eNto` created | `keys/buyer.json` `3sWw…npba` | the same key that funded the payer created the vendor's token account |

The ATA was needed because the facilitator refuses an `open` whose payTo has no token account (`invalid_batch_settlement_svm_settlement_simulation: missing recipient ATA`); the first attempt at ten requests failed that way and put nothing on chain.

## What is public, per transaction

Program ids are listed in invocation order, top-level then inner. Amounts are atomic USDC (6 decimals).

| # | Program ids | Payer | payTo | Deposit | Cumulative settled | Also readable |
| --- | --- | --- | --- | --- | --- | --- |
| 1 `open` | `CHNLx…yGsX`, `MemoSq…fcHr` ×2, `1111…1111`, `AToken…8knL`, `Tokenkeg…Q5DA` | `94BRf9UjVLdNUBGGeKuFqWSk4sA67EDtAmS9pm6RTjzT` signs; it is the `transferChecked` authority and the channel's `payer` and `authorized_signer` | `9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy`, the sole recipient at `bps 10000` in the `open` arguments | `100000` (0.10 USDC) in the instruction data and in the `transferChecked` from the payer's ATA `E8YR…u2sj` to the new escrow ATA `6GLY…iAaD`; token balances go payer 1000000 → 900000, channel 0 → 100000 | `0` | the facilitator `7re7…QFNt` pays the fee and 1950720 + 1488440 lamports of rent; Memo 1 is the seller nonce `2e605fad87e25cba41109890f2c25008`; Memo 2 is `x402:batch-settlement:svm:rcvauth:v1:BgNduYkRLcfyScrbKpd5FVd9o9heJ5uUbizrhmDdGAWM`; salt `0`, grace period `900`, open slot `517292432`, mint `4zMM…ncDU`, and a 56-byte `emitEvent` CPI |
| 2 `settle` | `Ed25519SigVerify…1111`, `CHNLx…yGsX` | `94BRf9UjVLdNUBGGeKuFqWSk4sA67EDtAmS9pm6RTjzT` is the public key the Ed25519 instruction verifies | not named in this transaction; reached through the channel account `B3vH…ukSQ` | none moved | `100000` in clear: the Ed25519 instruction carries the 50-byte voucher message `0x56 0x01 ‖ channelId B3vH…ukSQ ‖ cumulativeAmount 100000 ‖ expiresAt 0` | only the facilitator signs; no token balance changes; the voucher's Ed25519 signature is also in the instruction data |
| 3 `distribute` | `CHNLx…yGsX`, `MemoSq…fcHr`, `Tokenkeg…Q5DA` | `94BR…TjzT` is not a signer; it is still readable as the channel's `payer` and as the owner of a token account listed in the balances | `9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy` as recipient `bps 10000` in the instruction data and as owner of the destination ATA `GFLE…eNto` | escrow 100000 → 0 | `100000` paid: `transferChecked` of 100000 from the escrow ATA `6GLY…iAaD` (authority: the channel PDA) to payTo's ATA; payTo's balance 0 → 100000 | Memo `x402:batch:7c585c91-6c3d-4433-b4f6-f32f2f9a0809`; the devnet treasury owner `4zTe…spap` appears in the balances with 20611093 unchanged |

After the run the channel account (owner `CHNLx…yGsX`, 256 bytes, 1950720 lamports) reads, to anyone: status `0` (open), salt `0`, deposit `100000`, settled `100000`, payout watermark `100000`, grace period `900`, payer `94BR…TjzT`, payee and rent payer `7re7…QFNt`, authorized signer `94BR…TjzT`, mint `4zMM…ncDU`, open slot `517292432`.

## Transaction count per call

| Call | On-chain transactions | What landed |
| --- | --- | --- |
| 1 | 1 | `open` with the 0.10 USDC deposit and the first voucher (off-chain) |
| 2 | 0 | voucher, off-chain |
| 3 | 0 | voucher, off-chain |
| 4 | 0 | voucher, off-chain |
| 5 | 0 | voucher, off-chain |
| 6 | 0 | voucher, off-chain |
| 7 | 0 | voucher, off-chain |
| 8 | 0 | voucher, off-chain |
| 9 | 0 | voucher, off-chain |
| 10 | 0 | voucher, off-chain |
| redemption (after the ten) | 2 | `settle` then `distribute` |

Total: 3 on-chain transactions for 10 paid calls, 0.3 per call; 1 per call for the first call of a relationship and 0 after it until redemption. The plan's test expected at least ten signatures in this log; the rail produced three, and three is the number. See `docs/DEVIATIONS.md`.

## What an observer rebuilds

From the three rail signatures alone, with nothing but the ledger and the public program layout:

- **Payer:** `94BRf9UjVLdNUBGGeKuFqWSk4sA67EDtAmS9pm6RTjzT`. It signs the open, is the token transfer authority, is written into the channel as `payer` and `authorized_signer`, and its public key is the one the claim's Ed25519 instruction verifies.
- **Vendor set:** one vendor, `9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy`. It is the sole recipient (`bps 10000`) in the open and in the distribute, and the owner of the account that receives the payout.
- **First-contact order:** `9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy` first, at slot 517292446 (2026-10-31 22:59:21 UTC), the open. With one vendor the order is trivial; the open is what dates a relationship.
- **Cumulative spend per vendor:** `9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy`: `100000` atomic USDC (0.10 USDC). Read twice: as `cumulativeAmount` in the voucher the claim verifies, and as the 100000 paid out by the distribute. Deposit 0.10, settled 0.10, paid 0.10; nothing unspent.
- **Also recovered, beyond the four fields:** the facilitator `7re7…QFNt` (fee payer, rent payer, channel payee), the receiver authorizer `BgNd…GAWM` (from the binding Memo), the seller nonce Memo, the channel's lifetime so far (open 22:59:21, first and only claim 22:59:39, payout 22:59:41), and that the relationship is still open (status 0, grace period 900 s).
- **Not recovered:** the number of requests (ten) and the per-request price. The ledger shows one deposit and one cumulative amount; ten calls at 0.01 and one call at 0.10 look the same. Anyone holding the 402 (price `10000`) can divide and get ten, but that is not in the signatures.

This block is the expected output of the watcher's `reconstruct()` on these three signatures (Day 9): `payer` as above, `vendors = [9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy]`, `firstContactOrder` the same single address, `spendPerVendor = { 9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy: 100000n }`, `settlementTimes = [1793487579]` (the claim's block time; the distribute at 1793487581 is the payout of that claim).

## exact, per call

Task 2.4. The "every call hits the chain" baseline: the official `x402-template` from `create-solana-dapp` 4.8.5 (`x402-next` 1.2.0), source unmodified and configured only through `.env.local`, per its README: network `solana-devnet`, facilitator `https://x402.org/facilitator`, receiver the payTo above. Five paid requests to `GET /content/cheap` at `$0.01` each (`10000` atomic USDC, same mint), made by the stock `x402-fetch` 1.2.0 client with the same payer, on 2026-11-01 between 01:16:34 and 01:16:58 UTC. Each returned HTTP 200 with its signature in `X-PAYMENT-RESPONSE`; every fact below was then read back from the devnet ledger through `getTransaction` (`jsonParsed`), and the responses are in `docs/public-rail-observed.json`.

| Call | Signature | Slot | Time (UTC) | Fee (lamports) | Payer USDC after | payTo USDC after |
| --- | --- | --- | --- | --- | --- | --- |
| 1 | `5bxitJ36Wjfb63gUhEVnQzwsizqPksUBY1y5wtgKNp3HRMa5JoDAM7bF6Dup9jKrM4ZqnGhH2YfnibMudM2ddmsA` | 517326743 | 01:16:34 | 10001 | 890000 | 110000 |
| 2 | `5CqnwNoAp4H1y8sRfZNLiy5iqpS4seHfeK1bPZ3sJyrJ4sezCeidJka9oXs5TyUmUDx43xvWyTQK8YDvmUJJMiHS` | 517326813 | 01:16:51 | 10001 | 880000 | 120000 |
| 3 | `2p1MZ1ut7bfrmjmRFejpsB4xFQLFMM3f92XHtKJMyDGfVyNhifJ4rRQJr5PKTBVMkRNmDWFj83hqALD9NFfvL2Su` | 517326823 | 01:16:53 | 10001 | 870000 | 130000 |
| 4 | `5iV5NSXVK39BfviiPhb4W9N1k4FiAEVziTvWFkQRHAq3vLLWLhEHk4nW2aTAkNeaVQ9SXoXUEx62XYNc5Yb61JFj` | 517326832 | 01:16:55 | 10001 | 860000 | 140000 |
| 5 | `4XSSG6tKdaic3KUDfANcZzHxjHXfkHTn1DUj1nfi4VGNtJA5ca4aFcrGmSUHbaSn2DaCwcFGLVms42WyNsWd5k11` | 517326841 | 01:16:58 | 10001 | 850000 | 150000 |

Total: 5 on-chain transactions for 5 paid calls, 1 per call, against 0.3 per call for `batch-settlement` above. Sample size: five calls, one payer, one vendor, one route.

The payer and payTo are the task 2.3 keys, so the two baselines are one payer-vendor pair on the ledger: an observer who widens the window sees eight transactions between `94BR…TjzT` and `9JD9…fPgy` across both rails. When the watcher's `reconstruct()` (Day 9) is checked against this document, it must take each rail's signatures separately; the payer's whole history is not either rail's baseline.

Every transaction has the same shape: two Compute Budget instructions and one top-level `transferChecked` of `10000` from the payer's ATA `E8YR…u2sj` to payTo's ATA `GFLE…eNto`, authority the payer. The payer `94BR…TjzT` and the x402.org fee payer `CKPK…WYp5` both sign; the fee payer pays the fee. No Memo instruction, no channel, no program beyond Compute Budget and Token.

What this rail gives an observer that `batch-settlement` does not: the number of requests and the per-request price, both of which the section above lists as not recovered. Five transfers of `10000` mean five calls at 0.01 USDC, each with its own timestamp, so the ledger holds the buyer's call pattern as well as the relationship.

## Reproduce

Explorer: `https://explorer.solana.com/tx/<signature>?cluster=devnet`, or `https://solscan.io/tx/<signature>?cluster=devnet`. The program id is given in full above. The channel account can be read with `getAccountInfo` until the facilitator's rent cleanup seals and reclaims it.
