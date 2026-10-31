// Unit checks over the spike's artefacts. The devnet checks live in spike-magicblock.devnet.test.ts.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { describe, expect, it } from "vitest";

const root = resolve(import.meta.dirname, "..");
const attestationPath = resolve(root, "docs/attestation-devnet.json");
const logPath = resolve(root, "docs/spike-log.md");
const scriptPath = resolve(root, "scripts/spike-magicblock.ts");

describe("spike-magicblock artefacts", () => {
  it("attestation report saved and verified", () => {
    expect(existsSync(attestationPath), "docs/attestation-devnet.json is missing; run scripts/spike-magicblock.ts").toBe(true);
    const report = JSON.parse(readFileSync(attestationPath, "utf8")) as Record<string, unknown>;
    expect(report.verified).toBe(true);
    expect(report.rpcUrl).toBe("https://devnet-tee.magicblock.app");
    expect(report.host).toBe("devnet-tee.magicblock.app");
    expect(report.validatorIdentity).toBe("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
    expect(typeof report.quoteSha256).toBe("string");
    expect((report.quoteSha256 as string).length).toBe(64);
    expect(typeof report.quoteBase64).toBe("string");
  });

  it("spike log carries transaction signatures but no bearer token or key material", () => {
    expect(existsSync(logPath), "docs/spike-log.md is missing; run scripts/spike-magicblock.ts").toBe(true);
    const log = readFileSync(logPath, "utf8");
    // Transaction signatures (87–88 base58 chars) are public ledger data and are recorded on purpose.
    expect(log).toMatch(/^base .* [1-9A-HJ-NP-Za-km-z]{87,88}$/m);
    expect(log).toMatch(/^ephemeral .* [1-9A-HJ-NP-Za-km-z]{87,88}$/m);
    // Tokens: the TEE login is a 3-part dotted token, the API login a 4-part one; neither may appear.
    expect(log).not.toMatch(/Bearer\s+\S/);
    expect(log).not.toMatch(/[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}\.[A-Za-z0-9_-]{16,}/);
    expect(log).toContain('"token":"<redacted>"');
    // No 64-byte keypair arrays.
    expect(log).not.toMatch(/\[\s*(\d{1,3}\s*,\s*){63}\d{1,3}\s*\]/);
  });

  it("spike script never requests a public transfer or a memo", () => {
    const source = readFileSync(scriptPath, "utf8");
    expect(source).not.toMatch(/visibility:\s*"public"/);
    expect(source).not.toMatch(/\bmemo:\s*"/);
    // Every transfer request the script builds is private.
    const transfers = source.match(/visibility:\s*"[a-z]+"/g) ?? [];
    expect(transfers.length).toBeGreaterThanOrEqual(2);
    for (const t of transfers) expect(t).toBe('visibility: "private"');
  });
});
