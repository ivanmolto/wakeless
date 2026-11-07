# Recording an agent run

Status: devnet alpha, unaudited

A fresh Claude Code session asks the paid tools for a short market view, and the run leaves a transcript, a trajectory and a count of base-layer transactions in `docs/runs/`. Devnet only. Spends 0.6 devnet USDC from the buyer's private balance into escrow (one deposit per vendor, 100 × the route's price) and needs that much there first; `pnpm e2e` documents the same requirement.

Each step runs from the repo root, with `RUN` set to a new name (`run-1`, `run-2`, ...). The channel file and the budget file belong to the run, so the trajectory holds this run and nothing else, and the facilitator's memory stores start empty like the channels.

```bash
export RUN=run-1
```

## 0. Pick the CLI

Name the binary, do not let `PATH` pick it: in run-1 the `claude` on `PATH` was 1.0.126 and hung with no output. The desktop app ships a current one. Check the version and the login before any service starts:

```bash
export CLAUDE_BIN="$HOME/Library/Application Support/Claude/claude-code/2.1.309/5af865b9901c/claude.app/Contents/MacOS/claude"
```

```bash
"$CLAUDE_BIN" --version && "$CLAUDE_BIN" auth status
```

A version below 2.x, or `"loggedIn": false`, stops here. Renew with `"$CLAUDE_BIN" auth login` (bare `login` is not a subcommand: it opens a session and sends the word as a prompt), or `/login` inside a session; pick the Claude account with subscription.

## 1. Start the services

In two terminals, with the run's own attestation report. The facilitator's log is the run's evidence, so keep it:

```bash
ATTESTATION_REPORT_PATH=docs/runs/$RUN-attestation-facilitator.json pnpm --filter @wakeless/facilitator start | tee ~/.wakeless/agent-$RUN-facilitator.log
```

```bash
pnpm vendors
```

Wait for `listening on` with `ready`, not `attestation_failed`. An attestation failure stops the run.

## 2. Note the state before

```bash
pnpm agent-run before $RUN
```

This records the newest signature of the buyer, the escrow, the three vendors and their token accounts, and the buyer's private balance. It refuses a run name that has been used.

## 3. Run the agent

`--strict-mcp-config` gives the session the repo's `.mcp.json` and nothing else, `-p` makes it a new session with no earlier context, and `--allowedTools` leaves out `set_limits`, which is the owner's. The session starts its own MCP server.

```bash
WAKELESS_CHANNEL_STORE=$HOME/.wakeless/agent-$RUN-channels.json WAKELESS_BUDGET_FILE=$HOME/.wakeless/agent-$RUN-budget.json ATTESTATION_REPORT_PATH=docs/runs/$RUN-attestation-mcp.json "$CLAUDE_BIN" -p "$(cat scripts/agent-run-prompt.txt)" --mcp-config .mcp.json --strict-mcp-config --allowedTools mcp__wakeless__get_price,mcp__wakeless__get_sentiment,mcp__wakeless__get_news,mcp__wakeless__budget_status --output-format stream-json --verbose < /dev/null > ~/.wakeless/agent-$RUN-stream.jsonl
```

Close stdin (`< /dev/null`): from a non-interactive shell the old CLI waited on it. Run-1 could not take this path (step 0 would have caught both the stale binary and the expired login) and went the way below.

**From the desktop app instead.** Start a new session in this folder (its project `.mcp.json` must be approved), give it the prompt in `scripts/agent-run-prompt.txt`, and let it finish. It cannot be given the variables above, so the server uses its defaults: `~/.wakeless/channels.json`, `~/.wakeless/mcp-budget.json` and `docs/attestation-mcp.json`. Move any older channel file aside first; `finish` refuses a trajectory with requests older than the run. The stream in step 4 is then the session's file, `~/.claude/projects/<project>/<session id>.jsonl`, whose first message also carries whatever background the app added.

## 4. Save the record

```bash
pnpm agent-run finish $RUN ~/.wakeless/agent-$RUN-stream.jsonl ~/.wakeless/agent-$RUN-facilitator.log
```

This exports `getTrajectory()` to `docs/runs/$RUN-trajectory.json`, writes `docs/runs/$RUN.md`, and keeps the private-balance reading it took in `~/.wakeless/agent-$RUN-after.json` (beside `-before.json`), so the owner's view in `@wakeless/watcher` has a reading on each side of the run. It stops, writing neither, if the facilitator's confirmed deposits or the private balance's movement disagree with the trajectory, if the session's server was not connected or the session failed, or if the text carries a signature, a token or a key.

The published trajectory is the owner's entries without `depositSignature`; the signatures stay in the run's channel file under `~/.wakeless/`, where the watcher reads them. Two counts go in the file. The **base-layer transaction count** is the conservative bound of `pnpm e2e`: every transaction the run emitted, which is the deposits only. **On the public ledger** is the measured one: new signatures on the watched addresses. Deposits execute inside the MagicBlock rollup, so it is expected to be 0; anything else is a finding to report, not a number to tune.

`pnpm test` checks the saved files (`docs/test/runs.test.ts`). Stop both services afterwards. The facilitator's memory stores go with them, so after an app session move `~/.wakeless/channels.json` to `~/.wakeless/agent-$RUN-channels.json`: left in place, the next server would offer vouchers on channels the new facilitator does not know.
