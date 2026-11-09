# Evidence captures for the slide deck

Status: devnet alpha, unaudited

Every PNG is 1760 × 1000 px (2× of 4.4 × 2.5 in at 200 dpi), no shadow, no rounded corners. Terminal frames are rendered from the saved text with `pnpm shots:render` (background `#171819`, foreground `#F6F5F1`, monospace, 100 columns × 28 rows filling the frame, headless Chrome) rather than photographed from a window: the size is exact, there is no title bar or scrollbar to crop, and nothing can be in frame that is not in the text file beside it. The renderer refuses text wider than 100 columns, taller than 28 rows, or carrying a signature or a token. Web captures are headless Chrome screenshots of the page at 1760 px wide, cropped to the 1000 px window named below.

Nothing here carries a private key, an `.env` value, an API key, a signature or a `DEMO_CONFIRM` string. Addresses are the devnet keys of the repo's own buyer, escrow and synthetic vendors.

The privacy claim is against the public ledger. Three operators see inside: the facilitator (vouchers), MagicBlock's enclave (private transfers) and NEAR's private shard (funding origin and route).

## Files

| File | What it shows | Command | Date | Network | Commit |
| --- | --- | --- | --- | --- | --- |
| `agent.png` | The agent buys data over x402: one request answered `402` with `PAYMENT-REQUIRED` (scheme `batch-settlement-shielded`), the resend with `PAYMENT-SIGNATURE` carrying a buyer-signed voucher, the `200` with the vendor's JSON, and run-3's summary line | `pnpm shots:render docs/shots/agent-frame.txt docs/shots/agent.png` over `agent-frame.txt` | 2026-11-09 | Solana devnet | `f00e8c6` |
| `agent-frame.txt` | The text of `agent.png`: the second traced exchange with vendor1 from `trace-output.txt` and the `[agent-run]` line `pnpm agent-run finish run-3` printed | composed by hand from the two files below; nothing in it is typed from memory | 2026-11-09 | Solana devnet | `f00e8c6` |
| `trace-output.txt` | Two paid calls to vendor1 through the unchanged client, with a tracing `fetch` around it that prints the wire: the first call opens the channel (payload `deposit` + `voucher`), the second carries a voucher only. Amounts for the channel and the voucher signature are not printed | `ATTESTATION_REPORT_PATH=docs/shots/trace-attestation.json pnpm shots:trace SOL`, against the facilitator and vendors of run-3 | 2026-11-09 | Solana devnet | `f00e8c6` |
| `trace-attestation.json` | The TEE attestation the traced client verified at construction | written by the command above | 2026-11-09 | Solana devnet | `f00e8c6` |
| `agent-transcript.txt` | The full run-3 session: tool calls, tool results verbatim, the agent's market view, then the traced exchange and the record line. Asserted free of signatures, tokens and keys | the `claude -p` command of `scripts/agent-run.md` step 3 (`--output-format stream-json`), flattened to text | 2026-11-09 | Solana devnet | `f00e8c6` |
| `watcher.png` | The public-ledger observer on both rails: transactions per call and vendors recovered for each rail, the four checks per signature (public rail fails them, Wakeless passes), and "What an observer rebuilt" for Wakeless: nothing, no vendor, no spend, no order | `pnpm watcher:web`, then headless Chrome at 1760 px wide, cropped to the 1000 px window from the column headings down | 2026-11-09 | Solana devnet (the recorded `docs/side-by-side.json` run of 2026-11-07) | `f00e8c6` |
| `watcher-output.txt` | The same four checks, `reconstruct()` and `compare()` as text, over run-3's three deposit signatures read from devnet next to the public rail's recorded run: public rail 1 / 1 vendors, 100% spend; Wakeless 0 / 3, nothing recovered, every check passes | `pnpm shots:watch run-3 > docs/shots/watcher-output.txt` | 2026-11-09 | Solana devnet | `f00e8c6` |

The run behind `agent.png`: `docs/runs/run-3.md` and `run-3-trajectory.json` (9 paid requests, 3 deposits, 0 on the base layer, 0.6 USDC into escrow), recorded with `scripts/agent-run.md` on 2026-11-09. The `402 → PAYMENT-SIGNATURE → 200` lines are the traced exchange with vendor1 on the same facilitator and vendors, not lines from the agent session itself: the client has no verbose flag and the MCP stream carries tool results, not HTTP headers. `watcher.png` renders the side-by-side run of 2026-11-07, which is what the page loads; run-3's own signatures are checked in `watcher-output.txt`.

## Mainnet funding evidence (task 10.3, `docs/FUNDING-RUNS.md`)

| File | What it shows | Command | Date | Network | Commit |
| --- | --- | --- | --- | --- | --- |
| `aurora-fund.png` | Run 1 of `wakeless fund`: the confidential quote, the deposit address, the status changes to `SUCCESS`, the module's warning that Aurora's confidential status carries no transaction, then the arrival read back from the recipient's address (signature shortened, full in `docs/FUNDING-RUNS.md`) and the Base origin transaction | `pnpm shots:render docs/shots/aurora-fund-frame.txt docs/shots/aurora-fund.png` over `aurora-fund-frame.txt`, composed from the run's output and the read-only RPC reads the document quotes | 2026-11-09 | Base → Solana mainnet | `f00e8c6` |
| `aurora-fund-frame.txt` | The text of `aurora-fund.png` | the run's output as printed, wrapped at 100 columns, plus the two read-back lines | 2026-11-09 | Base → Solana mainnet | `f00e8c6` |
| `aurora-arrival.png` | solana.fm's page of run 1's arrival transaction: the recipient `Cng3ux9iYH8M…` and 1.765033 USD Coin visible, the signer Aurora's relayer, the origin wallet absent | headless Chrome at 1760 × 1000 on `https://solana.fm/tx/64rqQTiM…LThdc?cluster=mainnet-alpha` | 2026-11-09 | Solana mainnet | `f00e8c6` |
| `aurora-refund.png` | Run 3, the deliberate refund: the 2 USDC quote, `INCOMPLETE_DEPOSIT` after the 1 USDC underpayment, `REFUNDED`, then the two Base transactions, the deposit and the 0.9976 USDC refund to `refundTo` | `pnpm shots:render docs/shots/aurora-refund-frame.txt docs/shots/aurora-refund.png` over `aurora-refund-frame.txt` | 2026-11-09 | Base → Solana mainnet | `f00e8c6` |
| `aurora-refund-frame.txt` | The text of `aurora-refund.png` | the run's output as printed, wrapped at 100 columns, plus the two Base transactions | 2026-11-09 | Base | `f00e8c6` |

Mainnet spend for the three runs: 5 USDC sent from the operator's wallet, 0.9976 USDC returned, 3.529971 USDC landed on the two buyer addresses, the rest Aurora's fees. Transaction links on both sides are in `docs/FUNDING-RUNS.md`. The operator's wallet address appears in these frames as `refundTo`; it is a public address, not a key.
