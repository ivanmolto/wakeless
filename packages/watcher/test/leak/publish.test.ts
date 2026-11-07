import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { aggregate, pickSamplePayer, signaturesOfPayer } from "../../src/leak/aggregate.js";
import { decodeTransaction as decodeAll } from "../../src/leak/decode.js";
import { buildSnapshot, EXPLORER_URL, PROGRAM_ID, renderLeakage, shorten, snapshotToJson, type SnapshotMeta } from "../../src/leak/publish.js";
import { parseLeakSnapshot } from "../../src/leak/snapshot.schema.js";
import { reconstruct } from "../../src/reconstruct.js";
import { address } from "./fixtures.js";
import { syntheticTransactions } from "./synthetic.js";

const DOCS = join(import.meta.dirname, "..", "..", "..", "..", "docs");
const BASE58_RUN = /[1-9A-HJ-NP-Za-km-z]{32,44}/g;

const META: SnapshotMeta = {
  date: "2026-11-07",
  rpcHost: "mainnet.helius-rpc.com",
  sample: { signaturesScanned: 25, signaturesCap: 20000, since: null, oldest: "2026-06-30T00:00:00.000Z", newest: "2026-07-24T00:00:00.000Z", transactionsFetched: 25, transactionsFailed: 1, channelsWithoutOpen: 1 },
  x402scan: { exactTransfers: null, source: "x402scan (Merit Systems), read 7 Nov 2026", note: "x402scan documents no public export or API for Solana x402 transfers." },
};

function synthetic(): { markdown: string; json: string } {
  const txs = syntheticTransactions();
  const agg = aggregate(txs.flatMap((tx) => decodeAll(tx)));
  const payer = pickSamplePayer(agg)!;
  const mine = new Set(signaturesOfPayer(agg, payer));
  const snapshot = buildSnapshot(agg, META, { payer, channels: 3, rebuilt: reconstruct(txs.filter((tx) => mine.has(tx.signature))) });
  return { markdown: renderLeakage(snapshot), json: snapshotToJson(snapshot) };
}

/** Every base58 run of address length, the program id removed first. */
function fullAddresses(text: string): string[] {
  return text.replaceAll(PROGRAM_ID, "").match(BASE58_RUN) ?? [];
}

function headlineRows(markdown: string): string[] {
  const start = markdown.indexOf("## Headline");
  const end = markdown.indexOf("\n## ", start + 1);
  return markdown
    .slice(start, end)
    .split("\n")
    .filter((line) => line.startsWith("| ") && /\*\*[\d,.]+/.test(line));
}

describe("leak publish", () => {
  it("published markdown and JSON contain no 32-to-44-character base58 string other than the program id", () => {
    const { markdown, json } = synthetic();
    // The synthetic set has full addresses in play; they must all have been shortened.
    expect(markdown).toContain(shorten(address("vendor-1")));
    expect(json).toContain(shorten(address("payer-1")));
    expect(markdown).not.toContain(address("vendor-1"));
    expect(fullAddresses(markdown)).toEqual([]);
    expect(fullAddresses(json)).toEqual([]);
    expect(markdown).toContain(PROGRAM_ID);
    expect(markdown).toContain(EXPLORER_URL);
    // No signatures either (88 characters), no bearer tokens, no API keys.
    for (const text of [markdown, json]) {
      expect(text).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
      expect(text).not.toMatch(/bearer|api[-_]?key=/i);
    }
  });

  it("every headline figure is followed by its sample size", () => {
    const { markdown } = synthetic();
    const rows = headlineRows(markdown);
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) {
      const afterFigure = row.slice(row.lastIndexOf("**"));
      expect(afterFigure, row).toMatch(/of 25 signatures scanned/);
    }
    // The strip the web page shows reads the same sample size from the JSON.
    const { json } = synthetic();
    const snapshot = parseLeakSnapshot(JSON.parse(json));
    expect(snapshot.headline.signaturesScanned).toBe(25);
    expect(snapshot.headline).toMatchObject({ channels: 7, payers: 3, payTo: 3, relationships: 5, payersWithTwoOrMorePayTo: 1 });
    expect(snapshot.sampleTrajectory).toMatchObject({ payer: shorten(address("payer-1")), channels: 3 });
    expect(snapshot.sampleTrajectory?.vendors).toHaveLength(4); // three vendors and the fee recipient the distribution lists
    expect(snapshot.payToDegree[0]).toEqual({ payTo: shorten(address("vendor-1")), payers: 3, channels: 4 });
    expect(snapshot.settled.unit).toBe(shorten(address("usdc")));
    expect(snapshot.settled).toMatchObject({ channelsWithSettlement: 5, channelsWithoutSettlement: 1, channelsInOtherMints: 0, channelsWithUnknownMint: 1, total: "670000", median: "100000" });
    expect(snapshot.payeeSeats).toBe(1);
    expect(markdown).toContain("facilitator's sponsor key");
    expect(markdown).toContain("facilitator (vouchers), MagicBlock's enclave (private transfers) and NEAR's private shard (funding origin and route)");
    expect(markdown).toContain("x402scan");
  });

  it("the committed docs/LEAKAGE.md and snapshot obey the same rules", () => {
    const leakage = join(DOCS, "LEAKAGE.md");
    const leakDir = join(DOCS, "leak");
    const snapshots = existsSync(leakDir) ? readdirSync(leakDir).filter((f) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f)) : [];
    if (!existsSync(leakage) || snapshots.length === 0) {
      console.log("skipped: docs/LEAKAGE.md or docs/leak/snapshot-*.json absent (run pnpm leak:index)");
      return;
    }
    const markdown = readFileSync(leakage, "utf8");
    expect(fullAddresses(markdown)).toEqual([]);
    expect(markdown).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
    expect(markdown).toContain(EXPLORER_URL);
    const rows = headlineRows(markdown);
    expect(rows.length).toBeGreaterThanOrEqual(7);
    for (const row of rows) expect(row.slice(row.lastIndexOf("**")), row).toMatch(/of [\d,]+ signatures scanned/);
    for (const operator of ["facilitator", "MagicBlock's enclave", "NEAR's private shard"]) expect(markdown).toContain(operator);
    for (const file of snapshots) {
      const json = readFileSync(join(leakDir, file), "utf8");
      expect(fullAddresses(json), file).toEqual([]);
      expect(json).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
    }
    // The document and its latest snapshot carry the same sample size.
    const latest = parseLeakSnapshot(JSON.parse(readFileSync(join(leakDir, snapshots.sort().at(-1)!), "utf8")));
    expect(markdown).toContain(`${latest.headline.signaturesScanned.toLocaleString("en-US")} signatures scanned`);
    expect(markdown).toContain(`Snapshot **${latest.date}**`);
  });
});
