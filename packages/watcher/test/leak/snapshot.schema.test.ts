import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { aggregate } from "../../src/leak/aggregate.js";
import { decodeTransaction } from "../../src/leak/decode.js";
import { buildSnapshot, snapshotToJson, type SnapshotMeta } from "../../src/leak/publish.js";
import { latestLeakHeadline, ParseError, parseLeakHeadline, parseLeakSnapshot, SNAPSHOT_SCHEMA, TRUNCATED_ADDRESS } from "../../src/leak/snapshot.schema.js";
import { address } from "./fixtures.js";
import { syntheticTransactions } from "./synthetic.js";

const LEAK_DIR = join(import.meta.dirname, "..", "..", "..", "..", "docs", "leak");

const META: SnapshotMeta = {
  date: "2026-11-07",
  rpcHost: "mainnet.helius-rpc.com",
  sample: { signaturesScanned: 25, signaturesCap: 20000, since: "2026-06-01", oldest: "2026-06-30T00:00:00.000Z", newest: "2026-07-24T00:00:00.000Z", transactionsFetched: 25, transactionsFailed: 1, channelsWithoutOpen: 1 },
  x402scan: { exactTransfers: null, source: "x402scan", note: "absent" },
};

function onlyParseErrors(f: () => unknown): void {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ParseError);
  }
}

describe("leak snapshot schema", () => {
  it("the snapshot JSON validates against its schema and carries a date", () => {
    const files = existsSync(LEAK_DIR) ? readdirSync(LEAK_DIR).filter((f) => /^snapshot-\d{4}-\d{2}-\d{2}\.json$/.test(f)) : [];
    if (files.length === 0) {
      console.log("skipped: no docs/leak/snapshot-*.json yet (run pnpm leak:index)");
      return;
    }
    const byFile: Record<string, unknown> = {};
    for (const file of files) {
      const raw = JSON.parse(readFileSync(join(LEAK_DIR, file), "utf8")) as unknown;
      byFile[`docs/leak/${file}`] = raw;
      const snapshot = parseLeakSnapshot(raw);
      expect(snapshot.schema).toBe(SNAPSHOT_SCHEMA);
      expect(`snapshot-${snapshot.date}.json`).toBe(file);
      expect(snapshot.headline.signaturesScanned).toBe(snapshot.sample.signaturesScanned);
      expect(snapshot.headline.signaturesScanned).toBeGreaterThan(0);
      expect(snapshot.headline.signaturesScanned).toBeLessThanOrEqual(snapshot.sample.signaturesCap);
      expect(snapshot.headline.relationships).toBeLessThanOrEqual(snapshot.headline.channels);
      expect(snapshot.headline.payersWithTwoOrMorePayTo).toBeLessThanOrEqual(snapshot.headline.payers);
      expect(snapshot.payToDegree.length).toBeLessThanOrEqual(10);
      expect(snapshot.program.id).toBe("CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX");
      expect(snapshot.rpcHost).toMatch(/mainnet/);
      // Real mainnet data: the structure must be there even if small.
      expect(snapshot.headline.channels).toBeGreaterThan(0);
      const headline = parseLeakHeadline(file, raw);
      expect(headline).toMatchObject({ file, date: snapshot.date, relationships: snapshot.headline.relationships, signaturesScanned: snapshot.sample.signaturesScanned });
    }
    expect(latestLeakHeadline(byFile)?.file).toBe(files.sort().at(-1));
  });

  it("round-trips a built snapshot and refuses a full address anywhere an address goes", () => {
    const agg = aggregate(syntheticTransactions().flatMap(decodeTransaction));
    const snapshot = buildSnapshot(agg, META, null);
    const raw = JSON.parse(snapshotToJson(snapshot)) as Record<string, unknown>;
    expect(parseLeakSnapshot(raw)).toEqual(snapshot);
    expect(parseLeakHeadline("snapshot-2026-11-07.json", raw)).toEqual({ file: "snapshot-2026-11-07.json", date: "2026-11-07", relationships: 5, signaturesScanned: 25, channels: 7, payers: 3, payTo: 3 });

    const full = address("vendor-1");
    expect(TRUNCATED_ADDRESS.test(full)).toBe(false);
    const degree = raw.payToDegree as Record<string, unknown>[];
    expect(() => parseLeakSnapshot({ ...raw, payToDegree: [{ ...degree[0], payTo: full }] })).toThrow(ParseError);
    expect(() => parseLeakSnapshot({ ...raw, sampleTrajectory: { payer: full, channels: 1, vendors: [], firstContactOrder: [], spendPerVendor: {}, settlementTimes: [], edges: 0 } })).toThrow(/truncated/);
    expect(() => parseLeakSnapshot({ ...raw, settled: { ...(raw.settled as object), unit: full } })).toThrow(ParseError);
    expect(() => parseLeakSnapshot({ ...raw, date: "7 Nov 2026" })).toThrow(/date/);
    expect(() => parseLeakSnapshot({ ...raw, schema: "other" })).toThrow(/schema/);
    expect(parseLeakHeadline("x.json", { date: "2026-11-07", headline: { relationships: 1 } })).toBeUndefined();
  });

  it("fuzz: arbitrary JSON makes the parsers throw ParseError or return, nothing else", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        onlyParseErrors(() => parseLeakSnapshot(v));
        onlyParseErrors(() => parseLeakHeadline("snapshot-2026-11-08.json", v));
        onlyParseErrors(() => latestLeakHeadline({ "snapshot-2026-11-08.json": v }));
      }),
      { numRuns: 500 },
    );
  });
});
