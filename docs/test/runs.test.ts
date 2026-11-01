import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const RUNS = join(import.meta.dirname, "..", "runs");

interface Entry {
  readonly vendor: string;
  readonly route: string;
  readonly amount: string;
  readonly cumulative: string;
  readonly timestamp: string;
  readonly deposit?: string;
}

function countAfter(text: string, label: string): number {
  const match = text.match(new RegExp(`\\*\\*${label}: (\\d+)\\*\\*`));
  expect(match, label).not.toBeNull();
  return Number(match![1]);
}

function check(run: string): void {
    const path = join(RUNS, `${run}.md`);
    expect(existsSync(path)).toBe(true);
    const text = readFileSync(path, "utf8");
    const raw = readFileSync(join(RUNS, `${run}-trajectory.json`), "utf8");
    const trajectory = JSON.parse(raw) as Entry[];

    expect(trajectory.length).toBeGreaterThan(0);
    for (const entry of trajectory) {
      expect(entry.vendor).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
      expect(entry.route).toMatch(/^\/(price|sentiment|news)\/[A-Z0-9]{1,12}$/);
      expect(entry.amount).toMatch(/^[1-9][0-9]*$/);
      expect(entry.cumulative).toMatch(/^[1-9][0-9]*$/);
      expect(Number.isNaN(Date.parse(entry.timestamp))).toBe(false);
    }

    // The count is the deposits only; the ledger's own count cannot exceed it.
    const deposits = trajectory.filter(entry => entry.deposit !== undefined);
    expect(deposits.length).toBeGreaterThan(0);
    expect(countAfter(text, "Base-layer transaction count")).toBe(deposits.length);
    expect(countAfter(text, "Of those, on the public ledger")).toBeLessThanOrEqual(deposits.length);

    // A market view for three symbols, in the transcript as tool calls.
    expect(new Set(trajectory.map(entry => entry.route.split("/")[2])).size).toBe(3);
    expect(text).toContain("## Transcript");
    expect(text).toContain("**Tool call:** `mcp__wakeless__get_price`");

    // Every document that describes privacy names the three operators, and neither file holds a secret.
    for (const operator of ["facilitator", "MagicBlock's enclave", "NEAR's private shard"]) expect(text).toContain(operator);
    for (const content of [text, raw]) {
      expect(content).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
      expect(content).not.toMatch(/bearer|api[-_]?key=/i);
    }
}

describe("docs/runs", () => {
  it("run-1 transcript and trajectory are saved and consistent", () => {
    check("run-1");
  });

  it("run-2 is the clean claude -p run with the bare prompt", () => {
    check("run-2");
    const text = readFileSync(join(RUNS, "run-2.md"), "utf8");
    expect(text).toContain("`claude -p`");
    // The prompt as the file holds it, with nothing prepended by an app session.
    expect(text).toContain("**Prompt:**\n\nBuild a short market view for three symbols: SOL, BTC and ETH. Use the tools.\n");
    expect(text).not.toContain("Background (from the session that started this one)");
  });
});
