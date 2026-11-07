// The run files under docs/watcher/ parse, describe what they say they do, and the parser
// never throws anything but RunFileError on arbitrary input.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { parseRunFile, RunFileError } from "../src/run-file.js";

const DOCS = join(import.meta.dirname, "..", "..", "..", "docs", "watcher");

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(DOCS, name), "utf8")) as unknown;
}

describe("docs/watcher run files", () => {
  it("public-rail.json is the three rail signatures and the hand-written block", () => {
    const run = parseRunFile(load("public-rail.json"));
    expect(run.rail).toBe("public");
    expect(run.signatures.map((s) => s.label.split(" ")[0])).toEqual(["open", "settle", "distribute"]);
    expect(run.actual).toEqual({
      payer: "94BRf9UjVLdNUBGGeKuFqWSk4sA67EDtAmS9pm6RTjzT",
      vendors: ["9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy"],
      firstContactOrder: ["9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy"],
      spendPerVendor: { "9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy": 100000n },
      settlementTimes: [1793487579],
    });
  });

  it("wakeless-run.json names the three vendors, every channel amount, and who made each signature", () => {
    const run = parseRunFile(load("wakeless-run.json"));
    expect(run.rail).toBe("wakeless");
    expect(run.vendors).toHaveLength(3);
    expect(run.escrow).toBe("EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6");
    expect(run.attributableAmounts).toEqual(expect.arrayContaining([100000n, 200000n, 300000n, 10010n, 20020n, 30030n]));
    // Three channel deposits, two vault deposits; one vendor withdrawal.
    expect(run.signatures.filter((s) => s.party === "buyer")).toHaveLength(5);
    expect(run.signatures.filter((s) => s.label.startsWith("channel deposit"))).toHaveLength(3);
    expect(run.signatures.filter((s) => s.party === "vendor")).toHaveLength(1);
    expect(run.actual.vendors).toEqual(run.vendors);
    expect(Object.values(run.actual.spendPerVendor).reduce((a, b) => a + b, 0n)).toBe(60060n);
  });

  it("arbitrary JSON parses or throws RunFileError", () => {
    fc.assert(
      fc.property(fc.jsonValue(), (json) => {
        try {
          parseRunFile(json);
        } catch (error) {
          expect(error).toBeInstanceOf(RunFileError);
        }
      }),
      { numRuns: 300 },
    );
    const good = load("public-rail.json") as Record<string, unknown>;
    expect(() => parseRunFile({ ...good, signatures: [{ signature: "x", label: "y", party: "buyer" }] })).toThrow(RunFileError);
    expect(() => parseRunFile({ ...good, signatures: [{ ...(good.signatures as unknown[])[0] as object, party: "facilitator" }] })).toThrow(RunFileError);
    expect(() => parseRunFile({ ...good, actual: { vendors: [], spendPerVendor: { a: "1" } } })).toThrow(RunFileError);
  });
});
