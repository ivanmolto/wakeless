// The caps: per payment, rolling 24 hours under a fake clock, set_limits through the MCP
// client, the ledger file, and the USDC parser against arbitrary input.
import { readFileSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { Budget, BudgetRefusedError, DAY_MS, DEFAULT_PER_DAY, DEFAULT_PER_PAYMENT, formatUsdc, parseUsdc } from "../src/index.js";
import { startWorld, tempDir, textOf } from "./harness.js";

function clock(start = Date.UTC(2026, 10, 1, 12)) {
  let now = start;
  return { now: () => now, advance: (ms: number) => (now += ms), at: () => now };
}

describe("caps", () => {
  it("a payment above the per-payment cap is refused with a clear message", () => {
    const budget = new Budget({ path: null });
    expect(budget.limits()).toEqual({ perPayment: DEFAULT_PER_PAYMENT, perDay: DEFAULT_PER_DAY });
    // The vendors' prices plus the 10 bps fee share all fit under 0.05 USDC.
    for (const charge of [1001n, 2002n, 3003n]) expect(() => budget.check(charge)).not.toThrow();
    const error = (() => {
      try {
        budget.reserve(50_001n);
        return undefined;
      } catch (e) {
        return e;
      }
    })();
    expect(error).toBeInstanceOf(BudgetRefusedError);
    const message = (error as BudgetRefusedError).message;
    expect(message).toContain("refused");
    expect(message).toContain("0.050001 USDC");
    expect(message).toContain("per-payment cap of 0.05 USDC");
    expect(message).toContain("Nothing was signed");
    expect(message).toContain("set_limits");
    // A refusal records nothing.
    expect(budget.spentInWindow()).toBe(0n);
    expect(budget.status().last24h.payments).toBe(0);
  });

  it("the rolling 24h cap refuses and resets after 24h", () => {
    const c = clock();
    const budget = new Budget({ path: null, now: c.now, limits: { perPayment: 400_000n, perDay: 1_000_000n } });
    // Three payments of 0.3 USDC fit; the fourth would make 1.2.
    for (let i = 0; i < 3; i++) {
      budget.reserve(300_000n);
      c.advance(60 * 60 * 1000);
    }
    expect(budget.spentInWindow()).toBe(900_000n);
    expect(() => budget.check(300_000n)).toThrow(BudgetRefusedError);
    let message = "";
    try {
      budget.reserve(300_000n);
    } catch (e) {
      message = (e as Error).message;
    }
    expect(message).toContain("0.9 USDC was charged in the last 24 hours");
    expect(message).toContain("would take it to 1.2 USDC");
    expect(message).toContain("daily cap of 1 USDC");
    expect(message).toContain(new Date(c.at() - 3 * 60 * 60 * 1000 + DAY_MS).toISOString());
    // What still fits is accepted.
    expect(() => budget.check(100_000n)).not.toThrow();
    expect(budget.status().last24h).toMatchObject({ spent: "0.9", remaining: "0.1", payments: 3 });

    // Twenty-four hours after the first payment, it leaves the window and 0.3 fits again.
    c.advance(DAY_MS - 3 * 60 * 60 * 1000);
    expect(budget.spentInWindow()).toBe(600_000n);
    expect(() => budget.reserve(300_000n)).not.toThrow();
    // A day with nothing in it is empty.
    c.advance(DAY_MS + 1);
    expect(budget.spentInWindow()).toBe(0n);
    expect(budget.status().last24h).toEqual({ spent: "0", remaining: "1", payments: 0 });
  });

  it("set_limits changes both caps", async () => {
    const w = await startWorld();
    try {
      const before = JSON.parse(textOf((await w.client.callTool({ name: "budget_status", arguments: {} })) as CallToolResult)) as { limits: { perPayment: string; perDay: string } };
      expect(before.limits).toEqual({ perPayment: "0.05", perDay: "1" });

      const changed = (await w.client.callTool({ name: "set_limits", arguments: { perPayment: "0.0015", perDay: 2.5 } })) as CallToolResult;
      expect(changed.isError).not.toBe(true);
      expect(JSON.parse(textOf(changed))).toEqual({ limits: { perPayment: "0.0015", perDay: "2.5" } });
      expect(w.budget.limits()).toEqual({ perPayment: 1500n, perDay: 2_500_000n });

      // One at a time, too.
      await w.client.callTool({ name: "set_limits", arguments: { perDay: "0.75" } });
      expect(w.budget.limits()).toEqual({ perPayment: 1500n, perDay: 750_000n });

      // Nothing, zero, a negative or a seventh decimal are refused and change nothing.
      for (const args of [{}, { perPayment: "0" }, { perDay: "-1" }, { perPayment: "0.0000001" }, { perDay: "1e-3" }, { perPayment: "abc" }]) {
        const result = (await w.client.callTool({ name: "set_limits", arguments: args })) as CallToolResult;
        expect(result.isError, JSON.stringify(args)).toBe(true);
      }
      expect(w.budget.limits()).toEqual({ perPayment: 1500n, perDay: 750_000n });

      // The new per-payment cap is what refuses the next payment: vendor1 charges 1001 and fits, vendor2 would charge 2002.
      expect(() => w.budget.check(1001n)).not.toThrow();
      expect(() => w.budget.check(2002n)).toThrow(BudgetRefusedError);
    } finally {
      await w.close();
    }
  });

  it("the ledger file survives a restart, is mode 0600 and is pruned to the window", () => {
    const dir = tempDir();
    const path = join(dir, "state", "mcp-budget.json");
    const c = clock();
    const first = new Budget({ path, now: c.now });
    first.reserve(1001n);
    first.setLimits({ perDay: 2_000_000n });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect((statSync(join(dir, "state")).mode & 0o777) & 0o077).toBe(0);

    c.advance(DAY_MS / 2);
    const second = new Budget({ path, now: c.now });
    second.reserve(2002n);
    expect(second.spentInWindow()).toBe(3003n);
    // The file's limits win over the constructor's defaults: set_limits persists.
    expect(second.limits()).toEqual({ perPayment: DEFAULT_PER_PAYMENT, perDay: 2_000_000n });

    c.advance(DAY_MS / 2 + 1);
    second.reserve(3003n);
    expect(second.spentInWindow()).toBe(5005n);
    const file = JSON.parse(readFileSync(path, "utf8")) as { entries: { charge: string }[] };
    expect(file.entries.map((e) => e.charge)).toEqual(["2002", "3003"]);
    // No key material and no amounts beyond the charges themselves.
    expect(readFileSync(path, "utf8")).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{43,44}/);

    // A file that is not this format is refused at construction, never overwritten.
    const other = join(dir, "other.json");
    writeFileSync(other, '{"version": 2}\n');
    expect(() => new Budget({ path: other })).toThrow(/not a version 1 budget file/);
    expect(readFileSync(other, "utf8")).toBe('{"version": 2}\n');
  });

  it("parseUsdc never throws anything but RangeError and round-trips formatUsdc", () => {
    fc.assert(
      fc.property(fc.anything(), (input) => {
        try {
          const atomic = parseUsdc(input, "x");
          expect(atomic).toBeGreaterThan(0n);
          expect(parseUsdc(formatUsdc(atomic), "x")).toBe(atomic);
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
        }
      }),
      { numRuns: 500 },
    );
    fc.assert(
      fc.property(fc.bigInt({ min: 1n, max: 1_000_000_000_000_000n }), (atomic) => {
        expect(parseUsdc(formatUsdc(atomic), "x")).toBe(atomic);
      }),
      { numRuns: 300 },
    );
    expect(parseUsdc("0.05", "x")).toBe(50_000n);
    expect(parseUsdc(0.05, "x")).toBe(50_000n);
    expect(parseUsdc("1", "x")).toBe(1_000_000n);
    expect(parseUsdc(1, "x")).toBe(1_000_000n);
    expect(formatUsdc(1001n)).toBe("0.001001");
    expect(formatUsdc(0n)).toBe("0");
    for (const bad of ["", " ", "1e6", "0x10", "1,5", ".5", "5.", "-1", "0", "0.0000001", Number.NaN, Number.POSITIVE_INFINITY, 1e-7, null, undefined, {}, []]) {
      expect(() => parseUsdc(bad, "x"), String(bad)).toThrow(RangeError);
    }
  });
});
