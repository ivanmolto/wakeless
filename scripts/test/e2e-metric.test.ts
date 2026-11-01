import { describe, expect, it } from "vitest";
import { E2E_TITLE, evaluateE2e, formatE2eTable, type E2eCounts } from "../lib/e2e-metric.js";

const passing: E2eCounts = { requests: 30, served: 30, deposits: 3, servedPerVendor: [10, 10, 10], signatures: 3, visibleOnBaseLayer: 0 };

describe("evaluateE2e", () => {
  it("three rollup signatures over thirty requests pass: 0.00 on the ledger, 0.10 emitted", () => {
    expect(evaluateE2e(passing)).toEqual({ perRequest: 0, emittedPerRequest: 0.1, failures: [] });
  });

  it("exactly 0.2 emitted fails: the bound is strict", () => {
    const verdict = evaluateE2e({ ...passing, signatures: 6 });
    expect(verdict.emittedPerRequest).toBeCloseTo(0.2);
    expect(verdict.failures).toEqual(["signatures emitted per request is not below 0.2"]);
  });

  it("a signature the ledger shows fails the headline bound only once it reaches 0.2", () => {
    expect(evaluateE2e({ ...passing, signatures: 6, visibleOnBaseLayer: 5 }).failures).toEqual(["signatures emitted per request is not below 0.2"]);
    expect(evaluateE2e({ ...passing, signatures: 6, visibleOnBaseLayer: 6 }).failures).toEqual([
      "base-layer transactions per request is not below 0.2",
      "signatures emitted per request is not below 0.2",
    ]);
  });

  it("a run that served nothing does not pass on an empty numerator", () => {
    const verdict = evaluateE2e({ requests: 30, served: 0, deposits: 0, servedPerVendor: [0, 0, 0], signatures: 0, visibleOnBaseLayer: 0 });
    expect(verdict.perRequest).toBe(0);
    expect(verdict.failures.length).toBeGreaterThan(0);
  });

  it("zero requests fail rather than divide by zero", () => {
    const verdict = evaluateE2e({ requests: 0, served: 0, deposits: 0, servedPerVendor: [], signatures: 0, visibleOnBaseLayer: 0 });
    expect(verdict.failures.length).toBeGreaterThan(0);
  });

  it("one request not served fails below the bounds", () => {
    expect(evaluateE2e({ ...passing, served: 29 }).failures).toEqual(["29 of 30 requests were served"]);
  });

  it("a vendor never paid fails", () => {
    expect(evaluateE2e({ ...passing, servedPerVendor: [15, 15, 0] }).failures).toEqual(["a vendor was never paid"]);
  });
});

describe("formatE2eTable", () => {
  it("prints the ledger's count first and the emitted count beneath it", () => {
    const table = formatE2eTable(passing, evaluateE2e(passing));
    expect(table.split("\n").map((row) => row.replace(/\s+/g, " ").trim())).toEqual([
      "requests 30",
      "deposits 3",
      "base-layer transactions (the ledger shows) 0",
      "base-layer transactions per request 0.00",
      "signatures emitted (inside the rollup) 3",
      "signatures emitted per request 0.10",
    ]);
  });

  it("the title is the one the plan names", () => {
    expect(E2E_TITLE).toBe("e2e: base-layer transactions per request below 0.2");
  });
});
