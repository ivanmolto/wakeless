// The landing: every number and paragraph the page shows traces to the document it was read
// from, the built page carries them, and it names no project but Wakeless and its rail's
// operators. The build-gated half skips with a printed reason before `pnpm site:build`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { toString } from "mdast-util-to-string";
import { describe, expect, it } from "vitest";
import { buildLandingData } from "../scripts/landing-data.js";
import { ROOT, readTree, section } from "../scripts/markdown.js";
import { APP, describeBuilt } from "./built.js";

const MARKETING = /\b(revolutionary|seamless(?:ly)?|cutting[- ]edge|blazing(?:ly)?|powerful|robust|best[- ]in[- ]class|next[- ]generation|unprecedented|world[- ]class|effortless(?:ly)?|game[- ]changing|state[- ]of[- ]the[- ]art|groundbreaking|trusted by|testimonial)\b/i;

/** The projects the README's prior-art table names: the first cell of every row, links stripped. */
function priorArtNames(): string[] {
  const table = section(readTree("README.md"), "Prior art and what is new", false).find((n) => n.type === "table");
  if (!table || table.type !== "table") throw new Error("README prior-art table not found");
  return table.children
    .slice(1)
    .flatMap((row) => toString(row.children[0]!).split(/,| on the /))
    .map((s) => s.replace(/\(.*\)/, "").trim())
    // The Foundation's payment-channels program is the public rail the landing measures, not a competitor.
    .filter((s) => s.length > 2 && s !== "Project" && !/program/.test(s));
}

describe("landing data", () => {
  it("every number and paragraph is read from its source document", () => {
    const d = buildLandingData();
    const readme = readFileSync(join(ROOT, "README.md"), "utf8");
    const leakage = readFileSync(join(ROOT, "docs/LEAKAGE.md"), "utf8");
    const sbs = readFileSync(join(ROOT, "docs/side-by-side.md"), "utf8");
    const plain = readme.replace(/[`*]/g, "");

    for (const text of [d.tagline, d.status, d.problem, d.trajectory.lead, d.whyHide, d.trust]) expect(plain).toContain(text.replace(/[`*]/g, ""));
    expect(d.trust).toMatch(/\.$/);
    expect(d.trust).toContain("trusted hardware, not proofs");
    expect(d.trajectory.verticals).toHaveLength(6);
    for (const v of d.trajectory.verticals) {
      expect(plain).toContain(`- ${v.title}: ${v.consequence}`);
      expect(v.consequence, "a vertical states a possibility, not a certainty").toMatch(/^can /);
    }

    expect(sbs).toContain(`| Base-layer transactions per call | ${d.sideBySide.public.transactions} / ${d.sideBySide.calls} = ${d.sideBySide.public.perCall} | ${d.sideBySide.wakeless.transactions} / ${d.sideBySide.calls} = ${d.sideBySide.wakeless.perCall} |`);
    expect(sbs).toContain(`| Vendors recovered / actual | ${d.sideBySide.public.vendorsRecovered} / ${d.sideBySide.public.vendorsActual} | ${d.sideBySide.wakeless.vendorsRecovered} / ${d.sideBySide.wakeless.vendorsActual} |`);
    expect(sbs).toContain(`| Spend recovered | ${d.sideBySide.public.spendRecoveredPercent}% | ${d.sideBySide.wakeless.spendRecoveredPercent}% |`);
    expect(d.sideBySide.wakeless.vendorsRecovered, "a Wakeless run that recovers a vendor is a failing test, not a tunable").toBe(0);

    expect(readme).toContain(`made ${d.agentRun.paidRequests} paid requests with ${d.agentRun.deposits} deposits and ${d.agentRun.baseLayerTransactions} base-layer transactions`);
    expect(existsSync(join(ROOT, d.agentRun.source))).toBe(true);

    expect(readme).toMatch(new RegExp(`Relationship capital\\s+${d.terms.known.cleanPeriods} clean periods\\s+${d.terms.known.capitalBps} bps`));
    expect(readme).toMatch(new RegExp(`^\\s*PRICE\\s+${d.terms.known.price.replace(".", "\\.")} USDC`, "m"));
    expect(readme).toMatch(new RegExp(`PRICE\\s+${d.terms.unknown.price.replace(".", "\\.")} USDC`));
    expect(readme).toMatch(new RegExp(`FUNDING REQUIREMENT\\s+${d.terms.known.fundingCalls} calls\\s+${d.terms.known.minDeposit.replace(".", "\\.")} USDC`));
    expect(readme).toMatch(new RegExp(`FUNDING REQUIREMENT\\s+${d.terms.unknown.fundingCalls} calls\\s+${d.terms.unknown.minDeposit.replace(".", "\\.")} USDC`));
    expect(Number(d.terms.known.price)).toBeLessThan(Number(d.terms.unknown.price));
    expect(d.terms.known.fundingCalls).toBeLessThan(d.terms.unknown.fundingCalls);

    const fmt = (n: number) => n.toLocaleString("en-US");
    expect(leakage).toContain(`| Channels the ledger names | **${fmt(d.leak.channels)}** |`);
    expect(leakage).toContain(`| Distinct payers | **${fmt(d.leak.payers)}** |`);
    expect(leakage).toContain(`| Distinct payTo | **${fmt(d.leak.payTo)}** |`);
    expect(leakage).toContain(`| Public (payer, payTo) relationships | **${fmt(d.leak.relationships)}** |`);
    expect(leakage).toContain(`| Payers with two or more distinct payTo | **${fmt(d.leak.payersWithTwoOrMorePayTo)}** |`);
    expect(leakage).toContain(`${fmt(d.leak.signaturesScanned)} signatures scanned`);
    expect(leakage).toContain(`Snapshot **${d.leak.date}**`);
    // Truncated address only, never a full one (CLAUDE.md, Leakage dashboard).
    expect(d.leak.trajectory.payer).toMatch(/^.{4}….{4}$/);
    expect(readme).toContain(`Payer: \`${d.leak.trajectory.payer}\``);
    expect(readme).toContain(`from its ${d.leak.trajectory.channels} channels' signatures`);
  });
});

describeBuilt("landing page", () => {
  const html = () => readFileSync(join(APP, "index.html"), "utf8");
  const textOf = (h: string) =>
    h
      .replace(/<script[\s\S]*?<\/script>/g, " ")
      .replace(/<style[\s\S]*?<\/style>/g, " ")
      .replace(/<[^>]+>/g, " ")
      .replace(/&#x27;|&apos;/g, "'")
      .replace(/&amp;/g, "&")
      .replace(/\s+/g, " ");

  it("the built landing carries the run numbers, the verticals, the trust sentence and no marketing", () => {
    const d = buildLandingData();
    const text = textOf(html());
    for (const needle of [
      `${d.sideBySide.calls} paid calls. ${d.sideBySide.vendors} vendors. Zero vendors recovered from the ledger.`,
      `${d.sideBySide.wakeless.vendorsRecovered} / ${d.sideBySide.wakeless.vendorsActual}`,
      d.sideBySide.wakeless.perCall,
      String(d.agentRun.paidRequests),
      d.terms.known.price,
      d.terms.unknown.price,
      d.leak.channels.toLocaleString("en-US"),
      String(d.leak.payersWithTwoOrMorePayTo),
      String(d.leak.trajectory.vendors),
      d.leak.trajectory.payer,
      "The calls are the plan.",
      ...d.trajectory.verticals.map((v) => v.title),
      "trusted hardware, not proofs",
      "not independently audited",
      "What the observer recovered",
    ])
      expect(text, needle).toContain(needle);
    expect(text).not.toMatch(MARKETING);
    // The hero banner leads with the run, not with the caveat; the caveat sits in the trust section.
    expect(text.indexOf("Zero vendors recovered")).toBeLessThan(text.indexOf("not independently audited"));
    // No full base58 address or signature on the landing (the README's are on the docs pages, not here).
    expect(text).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{32,}/);
  });

  it("names no project but Wakeless and its rail's operators", () => {
    const text = textOf(html());
    const names = priorArtNames();
    expect(names.length).toBeGreaterThan(5);
    for (const name of names) expect(text, name).not.toMatch(new RegExp(`\\b${name.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")}\\b`));
  });

  it("the header links to the repository with an accessible label", () => {
    const h = html();
    expect(h).toContain('href="https://github.com/ivanmolto/wakeless"');
    expect(h).toMatch(/aria-label="GitHub repository"/);
  });
});
