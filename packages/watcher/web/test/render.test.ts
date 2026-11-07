// @vitest-environment happy-dom
import { beforeEach, describe, expect, it } from "vitest";
import { latestLeakHeadline, parseSideBySide } from "../src/data.js";
import { renderPage } from "../src/render.js";
// The committed result of `pnpm side-by-side`, not a copy: the page is tested on what it ships.
import sideBySideJson from "../../../../docs/side-by-side.json" with { type: "json" };

const data = parseSideBySide(sideBySideJson);
const assets = { wordmarkLight: "wordmark-light.svg", wordmarkDark: "wordmark-dark.svg" };

function q(root: Element, testid: string): Element {
  const el = root.querySelector(`[data-testid="${testid}"]`);
  if (el === null) throw new Error(`no [data-testid="${testid}"]`);
  return el;
}

describe("watcher web page", () => {
  let root: HTMLElement;
  beforeEach(() => {
    document.body.innerHTML = `<main id="app"></main>`;
    root = document.getElementById("app")!;
  });

  it("fixture JSON renders both numbers and an empty Wakeless reconstruction panel", () => {
    renderPage(root, data, undefined, assets);

    expect(q(root, "per-call-public").querySelector(".big")?.textContent).toBe(data.publicRail.transactionsPerCall);
    expect(q(root, "vendors-public").querySelector(".big")?.textContent).toBe(`${data.publicRail.comparison.vendorsRecovered} / ${data.publicRail.comparison.vendorsActual}`);
    expect(q(root, "per-call-wakeless").querySelector(".big")?.textContent).toBe("0.00");
    expect(q(root, "vendors-wakeless").querySelector(".big")?.textContent).toBe(`0 / ${data.wakeless.comparison.vendorsActual}`);

    // Public rail: the observer rebuilt the vendor list in first-contact order, with spend.
    const publicVendors = q(root, "rebuilt-vendors-public").querySelectorAll("li");
    expect(publicVendors).toHaveLength(data.publicRail.rebuilt.firstContactOrder.length);
    const first = data.publicRail.rebuilt.firstContactOrder[0]!;
    expect(publicVendors[0]?.textContent).toContain(`${first.slice(0, 4)}…${first.slice(-4)}`);
    expect(publicVendors[0]?.textContent).toContain("0.100000 USDC");

    // Wakeless: nothing rebuilt, and the vault edges listed (none in this window).
    const wakeless = q(root, "rebuilt-wakeless");
    expect(wakeless.querySelectorAll(".vendors li")).toHaveLength(0);
    expect(q(wakeless, "rebuilt-vendors-wakeless").textContent).toContain("Nothing");
    expect(q(wakeless, "edges").textContent).toContain("none in the window");

    // Three columns; the two paragraphs come from the JSON, not the page.
    expect(root.querySelectorAll(".columns > .column")).toHaveLength(3);
    expect(q(root, "difference").textContent).toContain(data.difference);
    const trust = q(root, "trust-boundary").textContent ?? "";
    expect(trust).toContain(data.trustBoundary);
    for (const operator of ["facilitator", "MagicBlock's enclave", "NEAR's private shard"]) expect(trust).toContain(operator);
  });

  it("the owner column holds more than the observer's panel: totals, calls, and the gap against the ledger", () => {
    renderPage(root, data, undefined, assets);
    expect(q(root, "owner-vendors-wakeless").querySelectorAll("li")).toHaveLength(3);
    expect(q(root, "owner-total-wakeless").textContent).toBe("0.060060 USDC, fee shares included");
    expect(q(root, "owner-total-public").textContent).toBe("0.300000 USDC");
    expect(q(root, "owner-gap-wakeless").textContent).toContain("none of the vendors and none of the spend");
    expect(q(root, "owner-gap-public").textContent).toContain("every vendor and every amount");
  });

  it("the leakage strip is omitted when no snapshot exists", () => {
    const leak = latestLeakHeadline({});
    expect(leak).toBeUndefined();
    renderPage(root, data, leak, assets);
    expect(root.querySelector(`[data-testid="leak-strip"]`)).toBeNull();
    expect(root.textContent).not.toContain("On mainnet today");
  });

  it("the leakage strip shows the latest snapshot's headline with its sample size", () => {
    const leak = latestLeakHeadline({
      "../../../../docs/leak/snapshot-2026-11-01.json": { date: "2026-11-01", headline: { relationships: 1, signaturesScanned: 10 } },
      "../../../../docs/leak/snapshot-2026-11-08.json": { date: "2026-11-08", headline: { relationships: 42, signaturesScanned: 20000, channels: 57 } },
    });
    renderPage(root, data, leak, assets);
    const strip = q(root, "leak-strip").textContent ?? "";
    expect(strip).toContain("On mainnet today: 42 public relationships");
    expect(strip).toContain("20000 signatures scanned");
    expect(strip).toContain("57 channels");
    expect(strip).toContain("snapshot-2026-11-08.json");
  });

  it("a snapshot without a sample size gets no strip", () => {
    const leak = latestLeakHeadline({ "docs/leak/snapshot-2026-11-08.json": { date: "2026-11-08", headline: { relationships: 42 } } });
    expect(leak).toBeUndefined();
  });

  it("no full address or signature appears in the rendered text", () => {
    renderPage(root, data, undefined, assets);
    expect(root.textContent).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,}/);
  });

  it("text from the JSON is escaped, not parsed as markup", () => {
    const hostile = { ...data, workload: `<img src=x onerror="alert(1)">` };
    renderPage(root, hostile, undefined, assets);
    expect(root.querySelector("img[onerror]")).toBeNull();
    expect(root.textContent).toContain(`<img src=x onerror="alert(1)">`);
  });
});
