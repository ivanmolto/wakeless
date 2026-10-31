import { execFileSync } from "node:child_process";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { publicKeyFromKeypairJson } from "../lib/keypairs.js";

const ROOT = join(import.meta.dirname, "..", "..");
const BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g;
const LONG_BASE58 = /\b[1-9A-HJ-NP-Za-km-z]{87,88}\b/;

function runKeys(dir: string): string {
  return execFileSync(process.execPath, ["--import", "tsx", "scripts/keys.ts"], {
    cwd: ROOT,
    env: { ...process.env, KEYS_DIR: dir },
    encoding: "utf8",
  });
}

describe("scripts/keys.ts", () => {
  let dir: string;
  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "wakeless-keys-"));
  });
  afterEach(() => {
    rmSync(dir, { recursive: true, force: true });
  });

  it("keys script prints public keys only", () => {
    const stdout = runKeys(dir);
    expect(stdout.match(BASE58)).toHaveLength(5);
    expect(stdout).not.toMatch(LONG_BASE58);
    expect(stdout).not.toMatch(/bearer/i);
    expect(stdout).not.toMatch(/\[\s*\d+\s*,/);
  });

  it("keys script writes solana-cli keypairs readable only by the owner", () => {
    const stdout = runKeys(dir);
    for (const name of ["buyer", "escrow", "vendor1", "vendor2", "vendor3"]) {
      const path = join(dir, `${name}.json`);
      expect(statSync(path).mode & 0o777).toBe(0o600);
      const publicKey = publicKeyFromKeypairJson(readFileSync(path, "utf8"));
      expect(stdout).toContain(publicKey);
    }
  });

  it("keys script keeps existing keypairs", () => {
    runKeys(dir);
    const before = readFileSync(join(dir, "buyer.json"), "utf8");
    const second = runKeys(dir);
    expect(readFileSync(join(dir, "buyer.json"), "utf8")).toBe(before);
    expect(second).not.toContain("created");
  });
});

describe("publicKeyFromKeypairJson", () => {
  it("rejects anything but 64 bytes without quoting the input", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (input) => {
        let parsed: unknown;
        try {
          parsed = JSON.parse(input);
        } catch {
          parsed = undefined;
        }
        fc.pre(!(Array.isArray(parsed) && parsed.length === 64));
        try {
          publicKeyFromKeypairJson(input);
          return false;
        } catch (error) {
          const { message } = error as Error;
          return message.startsWith("Keypair file is not") && (input.length < 4 || !message.includes(input));
        }
      }),
    );
  });
});
