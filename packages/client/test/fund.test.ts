// Task 8.3: `wakeless fund` over recorded Aurora fixtures and fake timers. Nothing here
// reaches Aurora, Solana or a keypair; the module is run with the flags it needs set in
// a copy of the environment, never in process.env.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import {
  DEFAULT_FUND_MAX_USDC,
  DEPOSIT_DELAY_MAX_MS,
  DEPOSIT_DELAY_MIN_MS,
  FUND_ERROR_CODES,
  FundRefusedError,
  LocalChannelStore,
  POLL_GRACE_MS,
  POLL_MAX_MS,
  POLL_MIN_MS,
  QUOTE_DEADLINE_MS,
  fund,
  type FundDeps,
  type FundInput,
  type FundingSource,
} from "../src/index.js";
import { main, parseArgs } from "../src/cli.js";
import { tempStore } from "./harness.js";

const FIXTURES = join(import.meta.dirname, "fixtures", "aurora");
const fixture = (name: string): unknown => JSON.parse(readFileSync(join(FIXTURES, `${name}.json`), "utf8"));
const TOKENS = fixture("tokens") as { tokens: { assetId: string; blockchain: string; symbol: string }[] };
const QUOTE = fixture("quote") as { quote: { depositAddress: string; amountOut: string } };
const SUCCESS = fixture("status-success") as { swapDetails: { destinationChainTxHashes: { hash: string }[] } };

const API_KEY = "aurora-test-key-6f1c2d3e4a5b";
const NOW = new Date("2026-11-06T10:00:00.000Z");
const RECIPIENT = "D36ojAXRGMaUM4Vpv5phRK5z53vzaLGJrBRzerjK3q4X";
const REFUND_TO = "0xf965bb50729bc0ceaec4da36ab117b345ac5fd74";
const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;

const ENV_ON: Record<string, string> = { FUNDING: "aurora", MAINNET_ENABLED: "true", DEMO_CONFIRM: "yes-2026-11-06", AURORA_API_KEY: API_KEY };
const INPUT: FundInput = { from: "base", amount: "2", recipient: RECIPIENT, refundTo: REFUND_TO, confirm: "yes-2026-11-06", noWait: true };

type Call = { url: string; body?: unknown };

/** Serves the fixtures; the status route answers from a script, one body per poll, the last one repeated. */
function aurora(statuses: unknown[] = [fixture("status-success")]) {
  const calls: Call[] = [];
  let polls = 0;
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    const body = init?.body === undefined ? undefined : JSON.parse(String(init.body));
    calls.push({ url, ...(body === undefined ? {} : { body }) });
    const json = (status: number, value: unknown) => new Response(JSON.stringify(value), { status, headers: { "content-type": "application/json" } });
    if (url.includes("/api/tokens/")) return json(200, TOKENS);
    if (url.includes("/api/quote/")) return json(200, fixture("quote"));
    if (url.includes("/api/status/")) {
      const value = statuses[Math.min(polls, statuses.length - 1)];
      polls += 1;
      return json(200, value);
    }
    return json(404, { message: `no route ${new URL(url).pathname}` });
  }) as typeof globalThis.fetch;
  return { fetch, calls, polls: () => polls };
}

function world(statuses?: unknown[], env: Record<string, string> = ENV_ON) {
  const api = aurora(statuses);
  const lines: string[] = [];
  const deposits: FundingSource[] = [];
  const store = new LocalChannelStore(tempStore());
  const deps: FundDeps = {
    env,
    fetch: api.fetch,
    store,
    print: (line) => lines.push(line),
    deposit: (funding) => {
      deposits.push(funding);
    },
    random: () => 0.5,
  };
  return { api, lines, deposits, store, deps };
}

describe("wakeless fund", () => {
  beforeEach(() => {
    vi.useFakeTimers();
    vi.setSystemTime(NOW);
  });
  afterEach(() => {
    vi.useRealTimers();
  });

  it("SUCCESS records fundingSource and schedules the deposit after a delay", async () => {
    const w = world([fixture("status-pending"), fixture("status-pending"), fixture("status-success")]);
    const run = fund({ ...INPUT, noWait: false }, w.deps);
    // Two pending polls at 5 s and 10 s, then SUCCESS; the deposit waits the randomised delay (midpoint at random 0.5).
    await vi.advanceTimersByTimeAsync(POLL_MIN_MS + 2 * POLL_MIN_MS);
    expect(w.api.polls()).toBe(3);
    const expectedDelay = Math.floor(DEPOSIT_DELAY_MIN_MS + 0.5 * (DEPOSIT_DELAY_MAX_MS - DEPOSIT_DELAY_MIN_MS));
    expect(w.deposits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(expectedDelay - 1);
    expect(w.deposits).toHaveLength(0);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await run;
    expect(outcome.status).toBe("SUCCESS");
    expect(outcome.exitCode).toBe(0);
    const arrival = SUCCESS.swapDetails.destinationChainTxHashes[0]!.hash;
    const funding: FundingSource = { originChain: "base", amount: "1745238", solanaArrivalSignature: arrival };
    expect(outcome.funding).toEqual(funding);
    expect(w.deposits).toEqual([funding]);
    expect(outcome.depositAfter).toBe(new Date(NOW.getTime() + 15_000 + expectedDelay).toISOString());
    // The owner's trajectory holds the funding as its fundingSource, under the aurora/fund entry.
    const [entry] = w.store.trajectory();
    expect(entry).toMatchObject({ vendor: "aurora", route: "fund", amount: "1745238", cumulative: "0", fundingSource: funding });
    expect(w.lines.some((l) => /channel deposit scheduled for .* a randomised \d+ s after the arrival/.test(l))).toBe(true);
    // The deposit address, the amount and the deadline were printed before any poll.
    expect(w.lines.find((l) => l.includes(QUOTE.quote.depositAddress))).toContain("send exactly 2 USDC on base");
    expect(w.lines.some((l) => l.includes("refund deadline") && l.includes(new Date(NOW.getTime() + QUOTE_DEADLINE_MS).toISOString()))).toBe(true);
  });

  it("FAILED prints the API error and exits 1", async () => {
    const w = world([fixture("status-failed")]);
    const outcome = await fund(INPUT, w.deps);
    expect(outcome).toMatchObject({ status: "FAILED", exitCode: 1 });
    expect(w.lines.at(-1)).toContain("FAILED: Swap execution failed: no solver filled the intent before the deadline");
    expect(w.store.trajectory()).toHaveLength(0);
    expect(w.deposits).toHaveLength(0);
  });

  it("REFUNDED prints the refund status and exits 0", async () => {
    const w = world([fixture("status-refunded")]);
    const outcome = await fund(INPUT, w.deps);
    expect(outcome).toMatchObject({ status: "REFUNDED", exitCode: 0 });
    const line = w.lines.at(-1)!;
    expect(line).toContain("REFUNDED: 0.9976 USDC returned to " + REFUND_TO);
    expect(line).toContain("PARTIAL_DEPOSIT");
    expect(line).toContain("2 origin-chain transaction(s)");
    expect(w.store.trajectory()).toHaveLength(0);
    expect(w.deposits).toHaveLength(0);
  });

  it("polling stops at deadline plus five minutes", async () => {
    const w = world([fixture("status-pending")]);
    const run = fund(INPUT, w.deps);
    const stopAt = QUOTE_DEADLINE_MS + POLL_GRACE_MS;
    // Backoff 5, 10, 20, 30, 30, ... seconds: the number of polls before the bound is fixed by it.
    await vi.advanceTimersByTimeAsync(stopAt - 1);
    const before = w.api.polls();
    expect(before).toBeGreaterThan(stopAt / POLL_MAX_MS);
    expect(before).toBeLessThan(stopAt / POLL_MIN_MS);
    await vi.advanceTimersByTimeAsync(1);
    const outcome = await run;
    expect(outcome).toMatchObject({ status: "TIMEOUT", exitCode: 1 });
    expect(w.lines.at(-1)).toMatch(/stopped polling: the refund deadline passed five minutes ago and the swap is PENDING_DEPOSIT/);
    // The gaps between polls never exceed the 30 s cap: calls per second over the whole window.
    expect(w.api.polls()).toBe(before + 1);
    expect(w.store.trajectory()).toHaveLength(0);
  });

  it("refuses without MAINNET_ENABLED and a matching DEMO_CONFIRM", async () => {
    const refusal = async (env: Record<string, string>, confirm: string | undefined) => {
      const w = world(undefined, env);
      const error = await fund({ ...INPUT, confirm }, w.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FundRefusedError);
      expect((error as FundRefusedError).code).toBe(FUND_ERROR_CODES.refused);
      expect(w.api.calls).toHaveLength(0);
      return (error as Error).message;
    };
    // Off by default: no flag at all.
    const bare = await refusal({ AURORA_API_KEY: API_KEY }, undefined);
    expect(bare).toContain("FUNDING");
    expect(bare).toContain("MAINNET_ENABLED");
    expect(bare).toContain("DEMO_CONFIRM");
    // MAINNET_ENABLED missing.
    const noMainnet = await refusal({ FUNDING: "aurora", DEMO_CONFIRM: "x", AURORA_API_KEY: API_KEY }, "x");
    expect(noMainnet).toContain("MAINNET_ENABLED is not `true`");
    expect(noMainnet).toContain("DEMO_CONFIRM");
    // DEMO_CONFIRM set but --confirm does not match.
    const mismatch = await refusal(ENV_ON, "yes-2026-11-05");
    expect(mismatch).toContain("--confirm does not equal DEMO_CONFIRM");
    expect(mismatch).toContain("MAINNET_ENABLED");
    // DEMO_CONFIRM empty in .env.
    const empty = await refusal({ ...ENV_ON, DEMO_CONFIRM: "" }, "");
    expect(empty).toContain("DEMO_CONFIRM is empty");
    // No key, nothing is sent either.
    const noKey = await refusal({ ...ENV_ON, AURORA_API_KEY: "" }, INPUT.confirm);
    expect(noKey).toContain("AURORA_API_KEY");
  });

  it("amount above FUND_MAX_USDC is refused", async () => {
    const over = async (amount: string, env = ENV_ON) => {
      const w = world(undefined, env);
      const error = await fund({ ...INPUT, amount }, w.deps).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(FundRefusedError);
      expect((error as FundRefusedError).code).toBe(FUND_ERROR_CODES.amount);
      expect(w.api.calls).toHaveLength(0);
      return (error as Error).message;
    };
    expect(DEFAULT_FUND_MAX_USDC).toBe(5);
    expect(await over("5.000001")).toContain("above FUND_MAX_USDC (5)");
    expect(await over("6")).toContain("above FUND_MAX_USDC (5)");
    expect(await over("3", { ...ENV_ON, FUND_MAX_USDC: "2" })).toContain("above FUND_MAX_USDC (2)");
    expect(await over("0")).toContain("positive");
    expect(await over("two")).toContain("decimal number");
    // At the cap is accepted; a fraction is warned about, not refused.
    const w = world();
    const outcome = await fund({ ...INPUT, amount: "4.5" }, w.deps);
    expect(outcome.status).toBe("SUCCESS");
    expect(w.lines[0]).toMatch(/^warning: 4\.5 USDC is not a whole number/);
    const w2 = world();
    await fund({ ...INPUT, amount: "5" }, w2.deps);
    expect(w2.lines.some((l) => l.startsWith("warning:"))).toBe(false);
    expect(w2.api.calls[1]!.body).toMatchObject({ amount: "5000000" });
  });

  it("asset ids come from the supported-tokens response, never hand-built", async () => {
    const w = world();
    await fund({ ...INPUT, from: "arbitrum" }, w.deps);
    const [tokens, quote, status] = w.api.calls;
    expect(tokens!.url).toContain("/api/tokens/");
    expect(quote!.url).toContain("/api/quote/");
    expect(status!.url).toContain("/api/status/");
    const byChain = (chain: string) => TOKENS.tokens.find((t) => t.blockchain === chain && t.symbol === "USDC")!.assetId;
    expect(quote!.body).toEqual({
      dry: false,
      confidentiality: "advanced",
      swapType: "EXACT_INPUT",
      originAsset: byChain("arb"),
      destinationAsset: byChain("sol"),
      amount: "2000000",
      depositType: "ORIGIN_CHAIN",
      recipient: RECIPIENT,
      recipientType: "DESTINATION_CHAIN",
      refundTo: REFUND_TO,
      refundType: "ORIGIN_CHAIN",
      slippageTolerance: 100,
      deadline: new Date(NOW.getTime() + QUOTE_DEADLINE_MS).toISOString(),
    });
    expect(new URL(status!.url).searchParams.get("depositAddress")).toBe(QUOTE.quote.depositAddress);
    // A chain with no USDC on the list, or several, stops before the quote.
    const none = world();
    await expect(fund({ ...INPUT, from: "polygon" }, none.deps)).rejects.toMatchObject({ code: FUND_ERROR_CODES.input });
    expect(none.api.calls.map((c) => new URL(c.url).pathname.split("/")[2])).toEqual(["tokens"]);
  });

  it("logs contain no API key and no 88-character base58 strings", async () => {
    // Every terminal state, a refusal from the API (its body echoes the path and so the key), and a network failure.
    const scripts: unknown[][] = [[fixture("status-pending"), fixture("status-success")], [fixture("status-failed")], [fixture("status-refunded")]];
    const lines: string[] = [];
    for (const statuses of scripts) {
      const w = world(statuses);
      const run = fund(INPUT, w.deps);
      await vi.advanceTimersByTimeAsync(POLL_MIN_MS);
      await run;
      lines.push(...w.lines);
    }
    const echoing = world();
    echoing.deps = {
      ...echoing.deps,
      fetch: (async (input: string | URL | Request) => new Response(JSON.stringify({ message: `Unauthorized for ${new URL(String(input)).pathname}` }), { status: 401 })) as typeof fetch,
    };
    const thrown = async (deps: FundDeps): Promise<Error> => {
      try {
        await fund(INPUT, deps);
      } catch (error) {
        return error as Error;
      }
      throw new Error("expected fund() to throw");
    };
    const refused = await thrown(echoing.deps);
    expect(refused).toBeInstanceOf(FundRefusedError);
    lines.push(refused.message, ...echoing.lines);
    const failing = world();
    failing.deps = { ...failing.deps, fetch: (async (input: string | URL | Request) => Promise.reject(new Error(`ECONNREFUSED ${String(input)}`))) as typeof fetch };
    const down = await thrown(failing.deps);
    lines.push(down.message, ...failing.lines);
    expect(lines.length).toBeGreaterThan(10);
    for (const line of lines) {
      expect(line).not.toContain(API_KEY);
      expect(line).not.toMatch(BASE58_88);
    }
    // The arrival signature is shortened on the line and whole in the channel file.
    const arrival = SUCCESS.swapDetails.destinationChainTxHashes[0]!.hash;
    expect(lines.some((l) => l.includes(`${arrival.slice(0, 8)}…${arrival.slice(-8)}`))).toBe(true);
    expect(refused.message).toContain("[redacted]");
    expect(down.message).toContain("[redacted]");
  });

  it("the CLI refuses without the flags and sends nothing", async () => {
    // A root with no .env, and the flags cleared in the process environment whatever the shell exports.
    for (const name of ["FUNDING", "MAINNET_ENABLED", "DEMO_CONFIRM", "AURORA_API_KEY", "FUND_REFUND_TO"]) vi.stubEnv(name, "");
    const root = join(tempStore(), "..");
    const fetchSpy = vi.spyOn(globalThis, "fetch");
    try {
      await expect(main(["fund", "--from", "base", "--amount", "2", "--to", RECIPIENT, "--refund-to", REFUND_TO], root)).rejects.toMatchObject({
        code: FUND_ERROR_CODES.refused,
        message: expect.stringMatching(/FUNDING.*MAINNET_ENABLED.*DEMO_CONFIRM/),
      });
      // Without --to and without keys/mainnet/buyer.json there is nothing to fund; still nothing sent.
      await expect(main(["fund", "--from", "base", "--amount", "2"], root)).rejects.toMatchObject({ code: FUND_ERROR_CODES.input });
      expect(fetchSpy).not.toHaveBeenCalled();
    } finally {
      fetchSpy.mockRestore();
      vi.unstubAllEnvs();
    }
    expect(await main(["--help"], root)).toBe(2);
    expect(parseArgs(["--from", "base", "--amount=2", "--no-wait", "--confirm", "x"])).toEqual({ values: { from: "base", amount: "2", confirm: "x" }, flags: new Set(["no-wait"]) });
    expect(() => parseArgs(["--from", "--amount", "2"])).toThrow(FundRefusedError);
  });
});
