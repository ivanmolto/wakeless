# @wakeless/watcher-web

Status: devnet alpha, unaudited

One static page (Vite, no framework) that shows `docs/side-by-side.json`: what the chain sees on each rail, what an observer rebuilt from it, and what the owner sees. Private package, not published.

```bash
pnpm watcher:web
```

```bash
pnpm --filter @wakeless/watcher-web build
```

## What it shows

- **What the chain sees**, one column per rail: the two headlines large (base-layer transactions per call; vendors recovered / actual), then the observer's rows (on the base layer or not, amounts in clear, recipients named, memos, which of the four checks fail).
- **What an observer rebuilt**, under each chain column: on the public rail, the vendor list in first-contact order with spend; on Wakeless, nothing, with the vault edges `reconstruct()` returned (readable, unlinked to any payer).
- **What the owner sees**: each rail's actual trajectory (payer, paid calls and their window, vendors in first-contact order with spend, total), and one line on how much of it the observer's panel holds.
- **The difference** and the **trust boundary** at the bottom, both read from the JSON (`difference`, `trustBoundary`, written by `sideBySideJson()` in `scripts/lib/side-by-side-doc.ts`), so the page and `docs/side-by-side.md` cannot drift: the claim is against the public ledger; the facilitator, MagicBlock's enclave and NEAR's private shard each see inside.
- **On mainnet today**, a strip at the top, only when a `docs/leak/snapshot-YYYY-MM-DD.json` exists. The snapshot's schema is the indexer's (`packages/watcher/src/leak/snapshot.schema.ts`, task 11.3, `wakeless-leak-snapshot@1`); `src/data.ts` imports its `LeakHeadline`, `parseLeakHeadline` and `latestLeakHeadline` rather than defining them. The strip reads the latest snapshot's `headline` for `relationships` (distinct payer and payTo pairs) and `signaturesScanned` (the sample size), plus `channels`, `payers` and `payTo`. A snapshot without both required fields shows no strip: no number without its sample size.

The tests render the committed `docs/side-by-side.json`, not a fixture. Every address on the page is truncated to its first four and last four characters. Data and brand assets (`brand/wordmark-*.svg`, `brand/favicon.svg`) are read at build time; the page fetches nothing at runtime.
