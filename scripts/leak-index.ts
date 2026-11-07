// Task 11.3: the leakage dashboard's indexer. Reads the mainnet payment-channels program
// through the Helius mainnet RPC (read-only, the one mainnet path CLAUDE.md allows without
// the mainnet flags: no keypair, two read methods, nothing spent), and writes
// docs/leak/snapshot-YYYY-MM-DD.json and docs/LEAKAGE.md. Raw responses are cached in
// docs/leak/cache/transactions.jsonl (gitignored) so a re-render does not refetch.
//
//   pnpm leak:index
//
// Env: HELIUS_API_KEY (or LEAK_RPC_URL for another mainnet RPC), LEAK_MAX_SIGNATURES
// (default 20000), LEAK_SINCE (ISO date; default the whole history), LEAK_CONCURRENCY (8),
// LEAK_RPS (requests started per second, default 5: what Helius's free plan sustained on 7 Nov).
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Signature } from "@solana/kit";
import { createMainnetReader, indexLeak, renderLeakage, snapshotToJson, type SnapshotX402scan, type TransactionCache } from "@wakeless/watcher/leak";
import { loadDotEnv } from "./lib/env.js";

const ROOT = join(import.meta.dirname, "..");
const LEAK_DIR = join(ROOT, "docs", "leak");
const CACHE_DIR = join(LEAK_DIR, "cache");
const CACHE_FILE = join(CACHE_DIR, "transactions.jsonl");

/**
 * Checked by hand on 7 Nov 2026 (`docs/DEVIATIONS.md`): x402scan publishes a Networks page
 * but documents no export or API, and its Solana count is not broken out by scheme.
 */
const X402SCAN: SnapshotX402scan = {
  exactTransfers: null,
  source: "x402scan (Merit Systems), https://www.x402scan.com/networks and https://github.com/Merit-Systems/x402scan, read 7 Nov 2026",
  note: "x402scan documents no public export or API for Solana x402 transfers. Its Networks page showed 26,182 x402 transactions on Solana in the past 24 hours (5 facilitators, 428 sellers, 123 buyers) on 7 Nov 2026, not broken out by scheme, so the exact-scheme per-call transfer count is absent rather than estimated.",
};

function openCache(): TransactionCache {
  mkdirSync(CACHE_DIR, { recursive: true });
  const map = new Map<Signature, unknown>();
  if (existsSync(CACHE_FILE)) {
    for (const line of readFileSync(CACHE_FILE, "utf8").split("\n")) {
      if (line === "") continue;
      const entry = JSON.parse(line) as { signature: Signature; result: unknown };
      map.set(entry.signature, entry.result);
    }
  }
  return {
    get: (signature) => map.get(signature),
    set: (signature, raw) => {
      map.set(signature, raw);
      appendFileSync(CACHE_FILE, JSON.stringify({ signature, result: raw }) + "\n");
    },
  };
}

function positiveInt(name: string, fallback: number): number {
  const raw = process.env[name];
  if (raw === undefined || raw === "") return fallback;
  const value = Number(raw);
  if (!Number.isInteger(value) || value <= 0) throw new Error(`${name} must be a positive integer`);
  return value;
}

async function main(): Promise<void> {
  loadDotEnv(ROOT);
  const rpcUrl = process.env.LEAK_RPC_URL || (process.env.HELIUS_API_KEY ? `https://mainnet.helius-rpc.com/?api-key=${process.env.HELIUS_API_KEY}` : undefined);
  if (rpcUrl === undefined) throw new Error("HELIUS_API_KEY (or LEAK_RPC_URL) is not set; copy .env.example to .env");
  const sinceRaw = process.env.LEAK_SINCE;
  const since = sinceRaw === undefined || sinceRaw === "" ? undefined : new Date(sinceRaw);
  if (since !== undefined && Number.isNaN(since.getTime())) throw new Error("LEAK_SINCE is not a date");

  const reader = createMainnetReader(rpcUrl, { requestsPerSecond: positiveInt("LEAK_RPS", 5) });
  const now = new Date();
  const result = await indexLeak({
    reader,
    maxSignatures: positiveInt("LEAK_MAX_SIGNATURES", 20_000),
    ...(since === undefined ? {} : { since }),
    now,
    concurrency: positiveInt("LEAK_CONCURRENCY", 8),
    cache: openCache(),
    x402scan: X402SCAN,
    log: (line) => console.error(`leak:index ${line}`),
  });

  mkdirSync(LEAK_DIR, { recursive: true });
  const snapshotPath = join(LEAK_DIR, `snapshot-${result.snapshot.date}.json`);
  writeFileSync(snapshotPath, snapshotToJson(result.snapshot));
  writeFileSync(join(ROOT, "docs", "LEAKAGE.md"), renderLeakage(result.snapshot) + "\n");
  const h = result.snapshot.headline;
  console.log(`leak:index wrote ${snapshotPath} and docs/LEAKAGE.md: ${h.channels} channels, ${h.payers} payers, ${h.payTo} payTo, ${h.relationships} relationships, ${h.payersWithTwoOrMorePayTo} payers with two or more payTo, of ${h.signaturesScanned} signatures scanned`);
}

main().catch((error: unknown) => {
  console.error(error instanceof Error ? error.message : String(error));
  process.exit(1);
});
