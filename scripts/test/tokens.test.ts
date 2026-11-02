import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { parseReceiptTokens } from "../../packages/facilitator/src/http/auth.js";
import { publicKeyFromKeypairJson } from "../lib/keypairs.js";

const ROOT = join(import.meta.dirname, "..", "..");

function run(script: string, dir: string, args: string[] = []): string {
  return execFileSync(process.execPath, ["--import", "tsx", `scripts/${script}`, ...args], {
    cwd: ROOT,
    env: { ...process.env, KEYS_DIR: join(dir, "keys"), ENV_FILE: join(dir, ".env") },
    encoding: "utf8",
  });
}

function env(dir: string): Record<string, string> {
  return Object.fromEntries(
    readFileSync(join(dir, ".env"), "utf8")
      .split("\n")
      .filter((l) => l.includes("=") && !l.startsWith("#"))
      .map((l) => [l.slice(0, l.indexOf("=")), l.slice(l.indexOf("=") + 1)]),
  );
}

describe("scripts/tokens.ts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wakeless-tokens-"));
    run("keys.ts", dir);
    writeFileSync(join(dir, ".env"), "HELIUS_API_KEY=x\nFACILITATOR_ADMIN_TOKEN=\nOTHER=1\n");
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("tokens script fills both variables in .env with one secret per vendor and prints no secret", () => {
    const stdout = run("tokens.ts", dir);
    const vars = env(dir);
    expect(vars.HELIUS_API_KEY).toBe("x");
    expect(vars.OTHER).toBe("1");
    expect(vars.FACILITATOR_ADMIN_TOKEN!.length).toBeGreaterThanOrEqual(16);
    const tokens = parseReceiptTokens(vars.FACILITATOR_RECEIPT_TOKENS);
    const vendors = ["vendor1", "vendor2", "vendor3"].map((v) => publicKeyFromKeypairJson(readFileSync(join(dir, "keys", `${v}.json`), "utf8")));
    expect([...tokens.keys()]).toEqual(vendors);
    expect(new Set(tokens.values()).size).toBe(3);
    expect(stdout).toContain("FACILITATOR_ADMIN_TOKEN     set");
    expect(stdout).toContain("FACILITATOR_RECEIPT_TOKENS  set");
    for (const value of [vars.FACILITATOR_ADMIN_TOKEN!, ...tokens.values()]) expect(stdout).not.toContain(value);
    expect(statSync(join(dir, ".env")).mode & 0o777).toBe(0o600);
  });

  it("tokens script keeps existing values unless --rotate", () => {
    run("tokens.ts", dir);
    const first = env(dir);
    const second = run("tokens.ts", dir);
    expect(env(dir)).toEqual(first);
    expect(second).toContain("kept");
    run("tokens.ts", dir, ["--rotate"]);
    const rotated = env(dir);
    expect(rotated.FACILITATOR_ADMIN_TOKEN).not.toBe(first.FACILITATOR_ADMIN_TOKEN);
    expect(rotated.FACILITATOR_RECEIPT_TOKENS).not.toBe(first.FACILITATOR_RECEIPT_TOKENS);
    expect(rotated.OTHER).toBe("1");
  });
});
