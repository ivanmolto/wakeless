// Task 12.2: `scripts/check-signatures.ts`. The pure half (finding and classifying
// signatures, formatting) runs offline over fixtures and a fake fetch. The network half,
// "every signature in the README resolves", needs the devnet RPC from `.env`: without it
// the test skips with a printed reason, and when the RPC cannot be reached at all it skips
// rather than passing. The README is the document under test; the side-by-side and watcher
// documents are the same check on the files the README's numbers come from.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { extractSignatures, fetchTransactionJson, formatResolutions, missing, resolveSignatures } from "../lib/check-signatures.js";
import { loadDotEnv } from "../lib/env.js";

const ROOT = join(import.meta.dirname, "..", "..");
const DEVNET_GENESIS = "EtWTRABZaYq6iMfeYKouRu166VU2xqa1VSJHrZ4oA6zh";

const BASE_SIG = "384j89A1T1BeVAp2UrTDvLYCL8EYnAjJpp3c3jFQzkLagD5ipv87kRUWWdwmDxGM8J2VJF73pYpWHym1Vs2v2C9U";
const ROLLUP_SIG = "45rG4cjnUZL5zXn23DLSVF67pmJRQxGu5YY5FqMXG1ky2kVfS2gdaRJxdo12yb1UwL4gswVg1QNTKAjwUcpSwM7u";
const SHORT_SIG = "TFLa6G8pLqLkWqRWNn41HdAdxiGiZsJXy6euFfwz6TVmG3enK1Nhh2EKDtNYoJ7vuktwKbPjiXY8xiFKT5hL4vV";

describe("check-signatures: finding signatures", () => {
  it("finds each distinct signature once, with its line and cluster", () => {
    const text = ["# Doc", `| 1 | deposit | \`${BASE_SIG}\` | slot 1 |`, `Again ${BASE_SIG} and a rollup one ${ROLLUP_SIG}.`, `A mainnet arrival ${SHORT_SIG} on mainnet.`, "An address 3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba is not a signature."].join("\n");
    expect(extractSignatures(text)).toEqual([
      { signature: BASE_SIG, cluster: "devnet", line: 2 },
      { signature: ROLLUP_SIG, cluster: "devnet", line: 3 },
      { signature: SHORT_SIG, cluster: "mainnet", line: 4 },
    ]);
  });

  it("ignores base58 runs that are not signatures and takes an 87-character one", () => {
    // Too short, too long, an address, and a 0x-prefixed hex digest (one word with its prefix).
    const text = `${"1".repeat(85)} ${"a".repeat(89)} CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX 0x${"f".repeat(88)}`;
    expect(extractSignatures(text)).toEqual([]);
    const short87 = "zSicACsABQRLs7ZaUw7mb7kmtFJy71RWzf98bokivVxVKtwooCtV8Y6UTLuBfMkXUa7cPVPP2kzLBKEnSvkK6Xm";
    expect(short87).toHaveLength(87);
    expect(extractSignatures(`(${short87})`).map((f) => f.signature)).toEqual([short87]);
  });
});

describe("check-signatures: resolving", () => {
  function fakeRpc(known: Record<string, Record<string, { slot: number; err: unknown }>>): typeof fetch {
    return (async (input: string | URL | Request, init?: RequestInit) => {
      const url = String(input);
      const body = JSON.parse(String(init?.body)) as { method: string; params: unknown[] };
      if (body.method === "getGenesisHash") return Response.json({ jsonrpc: "2.0", id: 1, result: DEVNET_GENESIS });
      const host = new URL(url).hostname;
      const sig = body.params[0] as string;
      const hit = known[host]?.[sig];
      return Response.json({ jsonrpc: "2.0", id: 1, result: hit ? { slot: hit.slot, meta: { err: hit.err } } : null });
    }) as typeof fetch;
  }

  const options = { devnetRpcUrl: "https://devnet.helius-rpc.com/?api-key=secret", teeRpcUrl: "https://devnet-tee.magicblock.app" };

  it("base layer first, then the rollup, then missing", async () => {
    const fetchImpl = fakeRpc({ "devnet.helius-rpc.com": { [BASE_SIG]: { slot: 519469332, err: null } }, "devnet-tee.magicblock.app": { [ROLLUP_SIG]: { slot: 726378804, err: null } } });
    const found = extractSignatures(`${BASE_SIG} ${ROLLUP_SIG} ${SHORT_SIG}`);
    const resolutions = await resolveSignatures(found, { ...options, fetchImpl });
    expect(resolutions.map((r) => [r.where, r.slot])).toEqual([
      ["devnet base layer", 519469332],
      ["devnet rollup", 726378804],
      ["missing", null],
    ]);
    expect(missing(resolutions).map((r) => r.signature)).toEqual([SHORT_SIG]);
    const text = formatResolutions(resolutions);
    expect(text).toContain("384j89A1…Vs2v2C9U  devnet base layer, slot 519469332");
    expect(text).toContain("45rG4cjn…UcpSwM7u  devnet rollup, slot 726378804");
    expect(text).toContain("TFLa6G8p…KT5hL4vV  MISSING on devnet");
    // Shortened signatures only: no full signature and never the RPC URL or its key.
    expect(text).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{86,88}/);
    expect(text).not.toContain("secret");
  });

  it("a mainnet signature without a mainnet reader is missing with a reason, and no mainnet URL is built", async () => {
    const fetchImpl = fakeRpc({});
    const resolutions = await resolveSignatures([{ signature: SHORT_SIG, cluster: "mainnet", line: 1 }], { ...options, fetchImpl });
    expect(resolutions[0]!.where).toBe("missing");
    expect(String(resolutions[0]!.err)).toContain("no mainnet reader");
  });

  it("refuses a mainnet devnet URL and a foreign TEE host before any call", async () => {
    const fetchImpl = fakeRpc({});
    await expect(resolveSignatures([], { ...options, devnetRpcUrl: "https://mainnet.helius-rpc.com/?api-key=x", fetchImpl })).rejects.toThrow(/mainnet/);
    await expect(resolveSignatures([], { ...options, teeRpcUrl: "https://example.com", fetchImpl })).rejects.toThrow(/TEE RPC host/);
  });

  it("an RPC error message is redacted of the API key", async () => {
    const fetchImpl = (async () => Response.json({ jsonrpc: "2.0", id: 1, error: { message: "bad key at https://devnet.helius-rpc.com/?api-key=secret" } })) as typeof fetch;
    await expect(fetchTransactionJson("https://devnet.helius-rpc.com/?api-key=secret", BASE_SIG, fetchImpl)).rejects.toThrow(/api-key=\[redacted\]/);
  });
});

loadDotEnv(ROOT);
const rpcUrl = process.env.SOLANA_RPC_URL;
if (!rpcUrl) console.warn("[skip] every signature in the README resolves: needs SOLANA_RPC_URL in .env (devnet)");

describe.skipIf(!rpcUrl)("check-signatures on the documents (network)", () => {
  async function reachable(url: string): Promise<boolean> {
    try {
      const response = await fetch(url, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "getHealth", params: [] }), signal: AbortSignal.timeout(15_000) });
      return response.ok;
    } catch {
      return false;
    }
  }

  it("every signature in the README resolves", async () => {
    if (!(await reachable(rpcUrl!))) {
      console.warn("[skip] every signature in the README resolves: the devnet RPC cannot be reached (offline?)");
      return;
    }
    const found = extractSignatures(readFileSync(join(ROOT, "README.md"), "utf8"));
    expect(found.length).toBeGreaterThan(10);
    expect(found.every((f) => f.cluster === "devnet"), "the README names no mainnet signature until docs/FUNDING-RUNS.md exists").toBe(true);
    const resolutions = await resolveSignatures(found, { devnetRpcUrl: rpcUrl!, teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app", paceMs: 250 });
    expect(missing(resolutions).map((r) => r.signature), formatResolutions(resolutions)).toEqual([]);
    // The README says which signatures are not on the base layer; the lookups agree.
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    for (const r of resolutions) {
      const line = readme.split("\n").find((l) => l.includes(r.signature))!;
      if (/not on the base layer/.test(line)) expect(r.where, r.signature).toBe("devnet rollup");
    }
  }, 180_000);
});
