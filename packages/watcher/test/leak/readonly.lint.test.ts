// CLAUDE.md, "Networks and funds": packages/watcher/src/leak/* may read mainnet without the
// flags because it loads no keypair, imports no signing helper and calls only read methods.
// This static scan is what makes that a property of the code rather than a promise.
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..", "..", "..");
const LEAK_SRC = join(ROOT, "packages", "watcher", "src", "leak");
const SCRIPT = join(ROOT, "scripts", "leak-index.ts");

/** The read methods CLAUDE.md names (the indexer uses the first two). */
const ALLOWED_RPC_METHODS = new Set(["getSignaturesForAddress", "getTransaction", "getParsedTransaction", "getProgramAccounts"]);
const FORBIDDEN_IMPORTS = [/signer/i, /keypair/i, /wallet/i, /^@wakeless\/(client|binding|binding-magicblock|facilitator|vendor|scheme)$/, /^@magicblock-labs\//, /^@solana\/web3\.js$/];
const FORBIDDEN_TEXT = [/keys\//, /KEYPAIR/, /\.config\/solana/, /generateKeyPair/, /createKeyPairSigner/, /signTransaction/, /sendTransaction/, /sendAndConfirm/, /simulateTransaction/, /requestAirdrop/, /partiallySign/];
const ALLOWED_SCRIPT_ENV = new Set(["LEAK_RPC_URL", "HELIUS_API_KEY", "LEAK_SINCE", "LEAK_MAX_SIGNATURES", "LEAK_CONCURRENCY", "LEAK_RPS"]);

function imports(source: string): { specifier: string; typeOnly: boolean }[] {
  const out: { specifier: string; typeOnly: boolean }[] = [];
  // Import statements hold no semicolon before their specifier; `export ... from` re-exports a brace list.
  for (const m of source.matchAll(/^import\s+(type\s+)?([^;]*?)\s+from\s+["']([^"']+)["']/gm)) out.push({ specifier: m[3]!, typeOnly: m[1] !== undefined });
  for (const m of source.matchAll(/^export\s+(type\s+)?\{[^}]*\}\s+from\s+["']([^"']+)["']/gm)) out.push({ specifier: m[2]!, typeOnly: m[1] !== undefined });
  for (const m of source.matchAll(/^import\s+["']([^"']+)["']/gm)) out.push({ specifier: m[1]!, typeOnly: false });
  return out;
}

function leakFiles(): { path: string; source: string }[] {
  return readdirSync(LEAK_SRC)
    .filter((f) => f.endsWith(".ts"))
    .map((f) => ({ path: `packages/watcher/src/leak/${f}`, source: readFileSync(join(LEAK_SRC, f), "utf8") }));
}

describe("leak read-only lint", () => {
  it("the leak package imports no signer, keypair path or .env key", () => {
    const files = leakFiles();
    expect(files.length).toBeGreaterThanOrEqual(5);
    for (const { path, source } of files) {
      for (const { specifier, typeOnly } of imports(source)) {
        for (const pattern of FORBIDDEN_IMPORTS) expect(specifier, `${path} imports ${specifier}`).not.toMatch(pattern);
        // Only types from @solana/kit: no RPC client, no signer, no transaction builder.
        if (specifier === "@solana/kit") expect(typeOnly, `${path} imports a value from @solana/kit`).toBe(true);
        if (specifier.startsWith("@solana/")) expect(specifier).toBe("@solana/kit");
      }
      for (const pattern of FORBIDDEN_TEXT) expect(source, `${path} contains ${pattern}`).not.toMatch(pattern);
      // The package reads no environment and no .env: the script hands it a URL.
      expect(source, `${path} reads process.env`).not.toMatch(/process\.env/);
      expect(source, `${path} reads .env`).not.toMatch(/loadDotEnv|dotenv|parseEnv/);
      expect(source, `${path} reads files`).not.toMatch(/node:fs|readFileSync/);
    }
  });

  it("the leak package calls only read RPC methods", () => {
    const methods = new Set<string>();
    for (const { source } of leakFiles()) for (const m of source.matchAll(/call\(\s*"([A-Za-z]+)"/g)) methods.add(m[1]!);
    expect([...methods].sort()).toEqual(["getSignaturesForAddress", "getTransaction"]);
    for (const m of methods) expect(ALLOWED_RPC_METHODS.has(m), m).toBe(true);
  });

  it("the script loads no keypair and reads only the indexer's own variables", () => {
    const source = readFileSync(SCRIPT, "utf8");
    for (const pattern of FORBIDDEN_TEXT) expect(source, `scripts/leak-index.ts contains ${pattern}`).not.toMatch(pattern);
    for (const { specifier } of imports(source)) for (const pattern of FORBIDDEN_IMPORTS) expect(specifier).not.toMatch(pattern);
    for (const m of source.matchAll(/process\.env\.([A-Z_]+)/g)) expect(ALLOWED_SCRIPT_ENV.has(m[1]!), `scripts/leak-index.ts reads ${m[1]}`).toBe(true);
    for (const m of source.matchAll(/process\.env\[["']([A-Z_]+)["']\]/g)) expect(ALLOWED_SCRIPT_ENV.has(m[1]!), `scripts/leak-index.ts reads ${m[1]}`).toBe(true);
    for (const m of source.matchAll(/positiveInt\("([A-Z_]+)"/g)) expect(ALLOWED_SCRIPT_ENV.has(m[1]!), `scripts/leak-index.ts reads ${m[1]}`).toBe(true);
    expect(source).not.toMatch(/MAINNET_ENABLED|DEMO_CONFIRM/);
    // It writes under docs/leak/ and docs/LEAKAGE.md only.
    for (const m of source.matchAll(/join\(ROOT,\s*"docs",\s*"([^"]+)"/g)) expect(["leak", "LEAKAGE.md"]).toContain(m[1]);
  });
});
