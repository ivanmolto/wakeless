import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { latestLeakHeadline, ParseError, parseLeakHeadline, parseSideBySide } from "../src/data.js";
import raw from "../../../../docs/side-by-side.json" with { type: "json" };

function onlyParseErrors(f: () => unknown): void {
  try {
    f();
  } catch (e) {
    expect(e).toBeInstanceOf(ParseError);
  }
}

describe("watcher web data", () => {
  it("parses the committed docs/side-by-side.json", () => {
    const d = parseSideBySide(raw);
    expect(d.publicRail.comparison.vendorsRecovered).toBe(d.publicRail.comparison.vendorsActual);
    expect(d.wakeless.comparison).toMatchObject({ vendorsRecovered: 0, spendRecoveredBps: 0, orderRecovered: false });
    expect(d.wakeless.rebuilt.firstContactOrder).toEqual([]);
    expect(d.wakeless.observer.rows[0]?.label).not.toMatch(/^\d+\. /);
    expect(d.difference).toContain(d.trustBoundary);
  });

  it("rejects swapped rails", () => {
    const o = raw as Record<string, unknown>;
    expect(() => parseSideBySide({ ...o, public: o.wakeless })).toThrow(ParseError);
  });

  it("rejects a JSON without the paragraphs", () => {
    const without: Record<string, unknown> = { ...raw };
    delete without.trustBoundary;
    expect(() => parseSideBySide(without)).toThrow(/trustBoundary/);
  });

  it("fuzz: arbitrary JSON makes the parsers throw ParseError or return, nothing else", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (v) => {
        onlyParseErrors(() => parseSideBySide(v));
        onlyParseErrors(() => parseLeakHeadline("snapshot-2026-11-08.json", v));
        onlyParseErrors(() => latestLeakHeadline({ "snapshot-2026-11-08.json": v }));
      }),
      { numRuns: 500 },
    );
  });

  it("fuzz: mutating one field of the public rail never escapes as anything but ParseError", () => {
    const keys = Object.keys(raw.public);
    fc.assert(
      fc.property(fc.constantFrom(...keys), fc.jsonValue(), (k, v) => {
        onlyParseErrors(() => parseSideBySide({ ...raw, public: { ...raw.public, [k]: v } }));
      }),
      { numRuns: 300 },
    );
  });
});
