# Funding a channel from another chain

`wakeless fund` (task 8.3) funds a Wakeless buyer address on Solana with USDC held on Base, NEAR, Arbitrum or another chain Aurora lists, through Aurora Intents in confidential mode. The operator never bridges by hand, and the Solana ledger cannot link the channel to the operator's origin wallet. This leg runs on mainnet only: Aurora has no devnet. It is off by default and guarded three ways (below).

The privacy claim is against the public ledger. Three operators see inside in v1: the facilitator (vouchers), MagicBlock's enclave (private transfers), and NEAR's private shard (funding origin and route).

## What Confidential Intents hides

Aurora's confidential mode executes the swap inside a separate, permissioned NEAR shard with no public RPC, mempool or explorer, bridged to NEAR mainnet through TEEs. The same quote endpoint as a public swap, with `confidentiality: "advanced"`. Hidden from anyone reading public chains:

- the origin wallet: which address on Base or NEAR paid;
- the routing path through NEAR;
- the link between the origin deposit and the Solana arrival.

## What it does not hide

- **The Solana arrival is public.** The destination transaction names the recipient, the asset and the amount. Anyone watching the buyer address sees USDC arrive from Aurora's side.
- **The origin deposit is public on the origin chain.** The operator's wallet sends USDC to a deposit address Aurora issued. That transaction is on Base or NEAR in clear; what is hidden is the path from there to Solana.
- **The shard's operators see inside.** No user-side zero-knowledge proof: NEAR's private shard sees origin, route and destination. NEAR runs selective disclosure for audits and a screening layer at ingress. No independent audit of the shard was published as of July 2026.
- **Aurora holds the API key's account.** The quote carries a `referral` naming the Widget Studio account behind the key; the module never prints it.

## The edge-correlation caveat

The two public edges of a confidential swap are an origin deposit of X USDC at time T and a Solana arrival of about X minus fees at time T plus a few minutes. Anyone who sees both chains can pair them by amount and timing, and once paired, the channel deposit that follows the arrival is linked to the origin wallet. Confidential mode hides the path, not the endpoints.

Mitigations the module applies, and their limits:

1. **Round amounts.** `--amount` is whole USDC by default; a fraction is accepted with a warning. A round input is one of many round inputs that day, not a unique fingerprint. The arrival amount is the input less Aurora's fee (about 5% on a 5 USDC quote, `docs/aurora-dry-run.md`), which is itself a near-unique number; nothing here changes that.
2. **A randomised delay before the channel deposit.** On SUCCESS the module waits a uniform 2 to 10 minutes before the deposit step, so the arrival and the deposit are not back to back. `--no-wait` skips it for tests and for runs where the deposit is made by hand later. A delay of minutes defeats a naive "next transaction" pairing and nothing stronger.
3. **A fresh buyer address per channel.** The recipient should be an address that has received nothing before and funds one channel; then the arrival links to one channel, not to a buyer's whole history.

What a careful observer can still do: pair the origin deposit with the arrival by amount and the few-minute window, then wait for the private deposit from that address. The private deposit itself (`POST /v1/spl/deposit` into the MagicBlock vault) is a base-layer transaction naming the buyer and the vault; the channel deposit inside the PER after it is not visible. So the observer learns "this origin wallet funded a Wakeless buyer", not which vendors that buyer pays.

## Guards

The module runs only when all three hold, and refuses with a message naming every one that does not:

| Guard | Meaning |
| --- | --- |
| `FUNDING=aurora` | The funding module is enabled. Unset, `wakeless fund` is off |
| `MAINNET_ENABLED=true` | Mainnet is a human decision for the day (`CLAUDE.md`, Networks and funds) |
| `DEMO_CONFIRM=<value>` in `.env`, repeated as `--confirm <value>` | A human set the value for the day and typed it again on the command |
| `AURORA_API_KEY` | From Widget Studio; goes into request URLs and nowhere else. Every printed or thrown line is scrubbed of it |
| `FUND_MAX_USDC` (default 5) | `--amount` above it is refused before anything is sent |

The module loads no keypair and makes no Solana RPC call. The recipient is `--to <address>` or the public half of `MAINNET_BUYER_KEYPAIR` (default `keys/mainnet/buyer.json`), read as bytes 32 to 64 of the file; the seed is not decoded. `keys/mainnet/` is never read by devnet code paths, and `pnpm test` runs this module over recorded fixtures only.

## Commands

A human sets the flags for the day in `.env`:

```
FUNDING=aurora
MAINNET_ENABLED=true
DEMO_CONFIRM=fund-2026-11-10
AURORA_API_KEY=<from studio.aurora.dev>
FUND_REFUND_TO=0x<the operator's wallet on the origin chain>
MAINNET_BUYER_KEYPAIR=keys/mainnet/buyer.json
```

Then, 2 USDC from Base into the demo buyer:

```bash
pnpm fund --from base --amount 2 --confirm fund-2026-11-10
```

From NEAR, to an explicit fresh address, with the refund to a NEAR account:

```bash
pnpm fund --from near --amount 2 --to <fresh solana address> --refund-to <account>.near --confirm fund-2026-11-10
```

Without the delay before the deposit step (tests, or when the deposit is made by hand later):

```bash
pnpm fund --from base --amount 2 --confirm fund-2026-11-10 --no-wait
```

From the published package: `npx wakeless fund ...` with the same flags, run from the directory holding `.env`.

What the command prints, in order:

1. `confidential quote: 2 USDC on base to <recipient> on Solana, 1.745238 USDC after Aurora's fees`
2. `send exactly 2 USDC on base to the deposit address: <address>` (and a memo when the chain needs one): the operator pays this from the origin wallet.
3. The refund deadline sent with the quote (now plus 20 minutes: if the swap is not done by then the refund begins, to `refundTo`), and the time the deposit address goes inactive as Aurora states it.
4. `status: PENDING_DEPOSIT`, `status: PROCESSING`, ... as they change. Polling backs off from 5 s to 30 s and stops at the refund deadline plus five minutes.
5. One of:
   - `SUCCESS: 1.745238 USDC arrived at <recipient>, Solana transaction <first8…last8> (in full in the channel file's trajectory)`, then `channel deposit scheduled for <time>, a randomised N s after the arrival`. Exit 0. The funding is recorded in the owner's channel file as a trajectory entry `{vendor: "aurora", route: "fund", fundingSource: {originChain, amount, solanaArrivalSignature}}`.
   - `REFUNDED: 0.9976 USDC returned to <refundTo> on base (PARTIAL_DEPOSIT)`. Exit 0. Nothing arrived on Solana; nothing recorded.
   - `FAILED: <the API's message>`. Exit 1.
   - `stopped polling: the refund deadline passed five minutes ago and the swap is <last status>`. Exit 1. The deposit address is printed again so the operator can check it with Aurora before sending anything else.

Exit 2 means the command refused before sending anything (flags, amount, chain or address); the message says what to set.

## After the arrival

The USDC lands in the recipient's base token account on Solana. The channel deposit is the first paid request's (`wrapFetchWithWakeless`, one private transfer into the escrow): it needs the buyer's private balance to hold the amount, which means one public vault deposit from that account first (`POST /v1/spl/deposit`, a base-layer transaction naming the buyer and the vault; on devnet `pnpm fund:private` does it, on mainnet the demo runner of task 13.1 does). `wakeless fund` makes neither: when the randomised delay ends it hands over with a line saying so, and the mainnet demo runner picks up from the recorded `fundingSource`. Keep the delay honest: do not make the vault deposit the second the command returns.

## Fixtures and what was not recorded

`packages/client/test/fixtures/aurora/` holds the tokens and quote shapes recorded on 31 Oct 2026 (`docs/aurora-dry-run.md`) and one status body per terminal state in the shape of the NEAR Intents 1Click reference that Aurora's API wraps. The status bodies were not recorded from Aurora: the dry run made no swap, so no status beyond "deposit address not found" has been observed. The first live run (task 10.1) re-records them, and `docs/FUNDING-RUNS.md` will carry the transaction links on both sides.
