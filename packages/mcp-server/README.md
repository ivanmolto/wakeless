# @wakeless/mcp-server

Status: devnet alpha, unaudited

An MCP server over stdio whose tools pay the three Wakeless vendors through [`@wakeless/client`](../client). It follows the shape of the x402 "MCP server with x402" guide (an `McpServer` on a `StdioServerTransport`, one tool per paid route, the payment handled by a wrapped `fetch`), with `wrapFetchWithWakeless` in place of the axios wrapper and the owner's spend caps enforced in code before anything is signed. Not published.

| Tool | Who calls it | What it does |
| --- | --- | --- |
| `get_price(symbol)` | the agent | `GET /price/:symbol` on vendor1 (1000 USDC atomic units a request) |
| `get_sentiment(symbol)` | the agent | `GET /sentiment/:symbol` on vendor2 (2000) |
| `get_news(symbol)` | the agent | `GET /news/:symbol` on vendor3 (3000) |
| `budget_status()` | the owner | the caps, what the last 24 hours charged, how many payments, the channels held |
| `set_limits({perPayment, perDay})` | the owner | changes either cap or both, in USDC (`"0.05"`, `1`) |

Each data tool's description names the route's price and says the charge adds the facilitator's privacy fee share (`extra.privacyFeeBps`, 10 bps by default), so an agent reconciling `budget_status` against the listed prices is told where the difference comes from rather than left to notice it, as run-1's agent did. A symbol is 1 to 12 letters or digits (upper-cased first); anything else is refused here and no request is made. Each data tool returns the vendor's JSON body as text; a refusal or failure is an `isError` result whose text says what happened and that nothing was charged.

## The caps

Two caps, both in USDC, both checked **before any deposit is made or voucher signed**, inside the client's `beforePayment` hook, so a refused request leaves no trace: no private transfer, no signature, no channel change, no trajectory entry.

| Cap | Default | Meaning |
| --- | --- | --- |
| per payment | 0.05 USDC | the most one request may charge: the route's price plus the privacy fee share, `price + ceil(price × privacyFeeBps / 10000)` |
| per day | 1 USDC | the most all requests may charge in any rolling 24 hours |

A refusal is a clear message, for example:

> refused: 0.9 USDC was charged in the last 24 hours and this request's 0.3 USDC would take it to 1.2 USDC, above the daily cap of 1 USDC. Nothing was signed. The window frees up at 2026-11-02T12:00:00.000Z. If this is intended, raise the cap with set_limits({ perDay }).

The ledger of approved charges and the caps set through `set_limits` live in `~/.wakeless/mcp-budget.json` (`WAKELESS_BUDGET_FILE`), mode 0600, so a restart does not reset the day. A charge is recorded when it is approved; a request the vendor then fails to serve still counts against the day (nothing was charged on the channel, but the day is bounded by what the agent asked for). Deposits are not spend: the first call to a vendor moves `extra.minDeposit` (100 × the route's price by default: 0.1, 0.2 and 0.3 USDC for the three vendors) from the buyer's private balance into the facilitator's escrow, where it stays the buyer's until vouchers claim it. The caps bound what vouchers claim. The caps are denominated in devnet USDC; a vendor pricing in any other asset is refused.

## Running it

The server runs on devnet only and needs the facilitator and the three vendors reachable, plus a funded buyer:

```bash
pnpm keys                                   # keys/buyer.json and the others, if missing
pnpm --filter @wakeless/facilitator start   # 127.0.0.1:4020, attests the TEE first
pnpm vendors                                # 127.0.0.1:4021, 4022, 4023
pnpm --filter @wakeless/mcp-server start    # the MCP server over stdio
```

The buyer's private balance must hold the deposits (`POST /v1/spl/deposit` with `private: true`, see the client README). The client builds the MagicBlock rail on the first 402; that construction is the TEE attestation and writes `docs/attestation-mcp.json` (`ATTESTATION_REPORT_PATH`).

### Devnet key handling

`BUYER_KEYPAIR` names a Solana CLI keypair file (a JSON array of 64 bytes, seed then public key), relative to the repo root or absolute, default `keys/buyer.json`. **This is devnet key handling**: the file is read in clear from disk, and this server is for a devnet buyer holding devnet USDC and nothing else. The key signs vouchers and, inside the binding, the deposit, and goes nowhere else: not to the vendors, not to the facilitator, not into the channel file, the budget file or a log line. A path under `keys/mainnet/`, a mainnet RPC URL or `MAINNET_ENABLED=true` stops the server before it starts. Mainnet is a human decision after Gate D and would need a different key arrangement.

### Environment

Read from the process environment, then `<repo>/.env` (set variables win, `$NAME` expanded).

| Variable | Default | Meaning |
| --- | --- | --- |
| `BUYER_KEYPAIR` | `keys/buyer.json` | the buyer's keypair file (above) |
| `SOLANA_RPC_URL` | required | Helius devnet; the binding asserts the cluster. Carries an API key: never logged |
| `MAGICBLOCK_TEE_RPC`, `MAGICBLOCK_PAYMENTS_API` | the devnet TEE and the Payments API | the rail |
| `USDC_MINT` | devnet USDC | the channel mint and the caps' asset |
| `VENDOR1_URL`, `VENDOR2_URL`, `VENDOR3_URL` | `http://127.0.0.1:` + `VENDOR1_PORT`… (4021, 4022, 4023) | where the vendors are |
| `WAKELESS_PER_PAYMENT_USDC`, `WAKELESS_PER_DAY_USDC` | `0.05`, `1` | the starting caps; caps set through `set_limits` persist in the budget file and win |
| `WAKELESS_BUDGET_FILE` | `~/.wakeless/mcp-budget.json` | the ledger |
| `WAKELESS_CHANNEL_STORE` | `~/.wakeless/channels.json` | the client's channel file |
| `ATTESTATION_REPORT_PATH` | `docs/attestation-mcp.json` | where the attestation report is written |

stdout is the MCP wire. Every log line goes to stderr with a `[mcp-server]` prefix and names tools, statuses, codes and channel ids, never an amount, a signature, a key or a token.

## Claude Code

`.mcp.json` at the repo root configures the server for Claude Code sessions opened in this repo (Claude Code asks once before using a project server):

```json
{
  "mcpServers": {
    "wakeless": {
      "command": "pnpm",
      "args": ["--silent", "-C", "packages/mcp-server", "start"],
      "env": { "BUYER_KEYPAIR": "keys/buyer.json" }
    }
  }
}
```

With the facilitator and the vendors running, ask: *what is the price of SOLX?* Claude Code calls `get_price`, the server pays vendor1 (a deposit on the first call, a voucher after), and the facilitator's log shows `POST /verify 200 valid <hash>` then `POST /settle 200 settled <hash> <channelId>`.

## Claude Desktop

[`claude_desktop_config.json`](claude_desktop_config.json) is the same server for Claude Desktop; replace the absolute path. Claude Desktop starts the command with a minimal `PATH`, so if it cannot find `pnpm`, give the absolute path `which pnpm` prints as `command`.

## Tests

`pnpm test` runs the package's tests with no network: the caps under a fake clock, `set_limits` through an MCP client, the ledger file, a fast-check property over the USDC parser, and an MCP client over an in-memory transport listing the five tools and paying the real vendor1 (`@wakeless/vendors`) over the real facilitator app on loopback with the client package's fake rail, where the facilitator log shows the verified voucher. Two tests spawn the stdio entry with a throwaway keypair and check that it lists its tools and that it refuses a mainnet RPC URL and a key under `keys/mainnet/`.

## Trust boundary

The same as the client's: the deposit and every voucher are private against the public ledger, and three operators see inside: the facilitator (vouchers, deposit transactions, amounts), MagicBlock's enclave (the private transfers) and, for channels funded through Aurora Confidential Intents, NEAR's private shard (origin and route). The MCP client (Claude) sees the vendors' answers and the tool results, which name the caps and the charges but no signature or key.

## Dependencies

`@modelcontextprotocol/sdk` 1.32.2 (`McpServer`, `StdioServerTransport`; tests use `Client`, `InMemoryTransport` and `StdioClientTransport`), `zod` 4.6.7 (its peer, for the tool input schemas), `@wakeless/client`, `@wakeless/scheme`. Tests add `@wakeless/vendors`, `@wakeless/facilitator`, `hono`, `@hono/node-server` and `fast-check`.
