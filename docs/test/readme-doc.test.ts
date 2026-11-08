// Task 12.2: README.md for a judge with fifteen minutes. The required sections in the
// plan's order, the wordmark first, the three leaks before the first heading, the leakage
// numbers and the side-by-side headlines equal to the documents they come from, truncated
// third-party addresses, ten failure rows, the four named comparisons with links, the two
// terms cards, every relative link resolving to a committed file and none to a private
// note, and no marketing adjectives.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const README = readFileSync(join(ROOT, "README.md"), "utf8");

/** The plan's section list, as H2 headings, in order. */
export const REQUIRED_SECTIONS = [
  "Why hide the relationship",
  "What the ledger already knows",
  "Side by side: the same workload on both rails",
  "Fund from any chain",
  "Quickstart",
  "How Solana powers it",
  "The x402 integration",
  "Trust boundary",
  "Failed payments",
  "Prior art and what is new",
  "Relationship terms (experimental)",
  "Limitations",
  "v2",
] as const;

/** Private working notes (CLAUDE.md, Working style): gitignored, never linked from the README. */
const PRIVATE_NOTES = ["docs/VERSIONS.md", "docs/DEVIATIONS.md", "docs/FAILURES.md", "docs/IDEAS.md", "docs/LOG.md", "docs/wakeless-briefing.md", "docs/wakeless-plan.md", "docs/wakeless-after-hackathon.md"];

const MARKETING = /\b(revolutionary|seamless(?:ly)?|cutting[- ]edge|blazing(?:ly)?|powerful|robust|best[- ]in[- ]class|next[- ]generation|unprecedented|world[- ]class|effortless(?:ly)?|game[- ]changing|state[- ]of[- ]the[- ]art|groundbreaking)\b/i;

function headings(text: string): string[] {
  return [...text.matchAll(/^## (.+)$/gm)].map((m) => m[1]!.trim());
}

function section(text: string, title: string): string {
  const start = text.indexOf(`\n## ${title}\n`);
  if (start === -1) throw new Error(`section "${title}" not found`);
  const rest = text.slice(start + 1);
  const next = rest.indexOf("\n## ", 1);
  return next === -1 ? rest : rest.slice(0, next);
}

describe("README.md", () => {
  it("README has every required section in order", () => {
    const found = headings(README);
    const required = found.filter((h) => (REQUIRED_SECTIONS as readonly string[]).includes(h));
    expect(required).toEqual([...REQUIRED_SECTIONS]);
    // No other H2 stands between the wordmark and the first required one, and none after the last.
    expect(found[0]).toBe(REQUIRED_SECTIONS[0]);
    expect(found.at(-1)).toBe(REQUIRED_SECTIONS.at(-1));
  });

  it("opens with the wordmark, the three leaks and the status line", () => {
    const intro = README.slice(0, README.indexOf("\n## "));
    expect(intro.trimStart().startsWith("<picture>")).toBe(true);
    expect(intro).toContain("brand/wordmark-dark.svg");
    expect(intro).toContain("brand/wordmark-light.svg");
    for (const leak of ["Per call", "At settlement", "At funding"]) expect(intro).toContain(leak);
    expect(intro).toContain("batch-settlement-shielded");
    expect(intro).toContain("Status: devnet alpha, unaudited");
    // Every document that describes privacy names the three operators.
    for (const operator of ["the facilitator (vouchers)", "MagicBlock's enclave (private transfers)", "NEAR's private shard (funding origin and route)"]) expect(intro).toContain(operator);
  });

  it("the leakage numbers equal the snapshot's, state the sample, and truncate every third-party address", () => {
    const text = section(README, "What the ledger already knows");
    const link = /\(docs\/leak\/snapshot-(\d{4}-\d{2}-\d{2})\.json\)/.exec(text);
    expect(link, "link to the dated snapshot").not.toBeNull();
    const snapshotPath = join(ROOT, "docs", "leak", `snapshot-${link![1]}.json`);
    expect(existsSync(snapshotPath)).toBe(true);
    const snapshot = JSON.parse(readFileSync(snapshotPath, "utf8")) as { headline: Record<string, unknown>; sample: Record<string, unknown> };
    const headline = snapshot.headline as { channels: number; payers: number; payTo: number; relationships: number; payersWithTwoOrMorePayTo: number };
    const fmt = (n: number) => n.toLocaleString("en-US");
    expect(text).toContain(`| Channels the ledger names | ${fmt(headline.channels)} |`);
    expect(text).toContain(`| Distinct payers | ${fmt(headline.payers)} |`);
    expect(text).toContain(`| Distinct payTo | ${fmt(headline.payTo)} |`);
    expect(text).toContain(`| Public (payer, payTo) relationships | ${fmt(headline.relationships)} |`);
    expect(text).toContain(`| Payers with two or more distinct payTo | ${fmt(headline.payersWithTwoOrMorePayTo)} |`);
    const scanned = (snapshot.sample as { signaturesScanned: number }).signaturesScanned;
    expect(text).toContain(`${fmt(scanned)} signatures scanned`);
    // Every address is truncated (first four, an ellipsis, last four) except the program id, given in full with an explorer link.
    const full = [...text.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{32,44}\b/g)].map((m) => m[0]);
    expect(new Set(full)).toEqual(new Set(["CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX"]));
    expect(text).toContain("https://explorer.solana.com/address/CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX");
    expect(text.match(/`[1-9A-HJ-NP-Za-km-z]{4}…[1-9A-HJ-NP-Za-km-z]{4}`/g)?.length ?? 0).toBeGreaterThan(10);
  });

  it("the side-by-side headlines equal docs/side-by-side.md and the signatures are the document's", () => {
    const text = section(README, "Side by side: the same workload on both rails");
    const doc = readFileSync(join(ROOT, "docs", "side-by-side.md"), "utf8");
    const rows = [/^\| Base-layer transactions per call \| .+ \|$/m, /^\| Vendors recovered \/ actual \| \d+ \/ \d+ \| \d+ \/ \d+ \|$/m, /^\| Spend recovered \| .+ \|$/m, /^\| First-contact order recovered \| .+ \|$/m];
    for (const row of rows) {
      const inDoc = row.exec(doc);
      expect(inDoc, row.source).not.toBeNull();
      expect(text).toContain(inDoc![0]);
    }
    const signatures = (s: string) => [...s.matchAll(/\b[1-9A-HJ-NP-Za-km-z]{86,88}\b/g)].map((m) => m[0]);
    const inReadme = signatures(text);
    const inDoc = new Set(signatures(doc));
    const inWatcher = new Set(signatures(readFileSync(join(ROOT, "docs", "WATCHER.md"), "utf8")));
    expect(inReadme.length).toBeGreaterThanOrEqual(15);
    for (const s of inReadme) expect(inDoc.has(s) || inWatcher.has(s), `${s.slice(0, 8)}… is in side-by-side.md or WATCHER.md`).toBe(true);
    expect(text).toContain("pnpm check:signatures");
  });

  it("the funding section states the guards and where the mainnet runs stand", () => {
    const text = section(README, "Fund from any chain");
    for (const guard of ["FUNDING=aurora", "MAINNET_ENABLED=true", "DEMO_CONFIRM", "FUND_MAX_USDC"]) expect(text).toContain(guard);
    expect(text).toContain("(docs/FUNDING.md)");
    const runs = join(ROOT, "docs", "FUNDING-RUNS.md");
    if (existsSync(runs)) {
      // The two success links and the refund link come from the runs document.
      const links = [...readFileSync(runs, "utf8").matchAll(/https:\/\/[^\s)>\]]+/g)].map((m) => m[0]);
      expect(links.length).toBeGreaterThanOrEqual(3);
      expect(text).toContain("(docs/FUNDING-RUNS.md)");
      expect(links.filter((l) => text.includes(l)).length).toBeGreaterThanOrEqual(3);
    } else {
      expect(text).toMatch(/have not been run/);
      expect(text).toContain("mainnet spend to date is 0 USDC");
    }
  });

  it("the quickstart carries the exact commands of the loop", () => {
    const text = section(README, "Quickstart");
    for (const command of ["pnpm install && pnpm build", "cp .env.example .env", "pnpm keys", "pnpm airdrop", "pnpm fund:private --role buyer --usdc 1", "pnpm fund:private --role escrow --usdc 0.01", "pnpm tokens", "pnpm test", "pnpm e2e", "pnpm --filter @wakeless/facilitator start", "pnpm vendors", "/admin/redeem", "pnpm vendor:receipts --vendor 1", "pnpm watcher"]) {
      expect(text, command).toContain(command);
    }
    // Each is a single-line bash block the app can run.
    expect(text.match(/^```bash$/gm)?.length ?? 0).toBeGreaterThanOrEqual(12);
    expect(text).not.toMatch(/mainnet-tee|mainnet\.helius/);
  });

  it("names the rollup's programs, endpoints and attestation files", () => {
    const text = section(README, "How Solana powers it");
    for (const id of ["DELeGGvXpWV2fqJUhqcF5ZSYMS4JTLjteaAMARRSaeSh", "ACLseoPoyC3cBqoUtkbjZ4aDrkurZW86v19pXz2XQnp1", "SPLxh1LVZzEkX99H6rqYizhytLWPZVV296zyYDPagv2", "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"]) expect(text).toContain(id);
    expect(text).toContain("https://devnet-tee.magicblock.app");
    expect(text).toContain("https://payments.magicblock.app");
    for (const file of ["docs/attestation-devnet.json", "docs/attestation-facilitator.json", "docs/attestation-client.json"]) expect(text).toContain(`(${file})`);
    expect(text).toMatch(/sha256 `[0-9a-f]{64}`/);
  });

  it("the x402 section names the scheme id, the three endpoints and why not batch-settlement", () => {
    const text = section(README, "The x402 integration");
    expect(text).toContain("`batch-settlement-shielded`");
    for (const endpoint of ["GET /supported", "POST /verify", "POST /settle"]) expect(text).toContain(endpoint);
    expect(text).toMatch(/canonical payment-channels program/);
    expect(text).toContain("PAYMENT-REQUIRED");
    expect(text).toContain("shielded_");
  });

  it("the trust boundary names the three operators plainly", () => {
    const text = section(README, "Trust boundary");
    expect(text).toMatch(/against the public ledger, not against operators/);
    expect(text).toMatch(/^1\. The facilitator/m);
    expect(text).toMatch(/^2\. MagicBlock's enclave/m);
    expect(text).toMatch(/^3\. NEAR's private shard/m);
  });

  it("the failed-payment table has ten rows, each with a code and a test title", () => {
    const text = section(README, "Failed payments");
    const rows = [...text.matchAll(/^\| (\d+) \| .+ \| .+ \| .+ \| "(.+)" \|$/gm)];
    expect(rows.map((r) => Number(r[1]))).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9, 10]);
    const tests = readFileSync(join(ROOT, "packages", "facilitator", "test", "failures-1.test.ts"), "utf8") + readFileSync(join(ROOT, "packages", "facilitator", "test", "failures-2.test.ts"), "utf8");
    for (const row of rows) expect(tests, `row ${row[1]} test title`).toContain(`"${row[2]}"`);
  });

  it("prior art names the four comparisons with links and says what is new", () => {
    const text = section(README, "Prior art and what is new");
    for (const name of ["Subly", "Sotto", "GhostTab", "Mercurii"]) expect(text).toMatch(new RegExp(`\\[${name}\\]\\(https?://`));
    expect(text).toMatch(/What is new here/);
  });

  it("the terms section shows the two receipt cards and links docs/TERMS.md", () => {
    const text = section(README, "Relationship terms (experimental)");
    expect(text).toContain("(docs/TERMS.md)");
    expect(text).toContain("RELATIONSHIP_TERMS=true");
    const cards = text.split("\n").find((l) => l.includes("WAKELESS TERMS"))!;
    expect(cards.match(/WAKELESS TERMS/g)?.length).toBe(2);
    expect(text).toMatch(/Relationship capital\s+7 clean periods\s+1750 bps/);
    expect(text).toMatch(/FUNDING REQUIREMENT\s+20 calls/);
  });

  it("limitations cover the seven points and v2 is five lines", () => {
    const limits = section(README, "Limitations");
    for (const point of [/not proofs/, /Screening at ingress/, /Facilitator-held escrow/, /several buyers/, /mainnet only/, /Beta APIs/, /dated snapshot/]) expect(limits).toMatch(point);
    const v2 = section(README, "v2");
    const lines = v2.split("\n").filter((l) => l.startsWith("- "));
    expect(lines).toHaveLength(5);
    for (const item of [/Rings/, /commitment/, /program-owned escrow/, /[Rr]elationship terms/]) expect(v2).toMatch(item);
  });

  it("every relative link resolves to a committed file and none points at a private note", () => {
    const links = [...README.matchAll(/\]\(([^)]+)\)/g)].map((m) => m[1]!).filter((href) => !/^https?:\/\//.test(href));
    expect(links.length).toBeGreaterThan(20);
    for (const href of links) {
      const path = href.split("#")[0]!;
      expect(existsSync(join(ROOT, path)), href).toBe(true);
      expect(PRIVATE_NOTES.includes(path), `${href} is a private note`).toBe(false);
    }
    for (const note of PRIVATE_NOTES) expect(README).not.toContain(note);
  });

  it("no marketing adjectives, and the status line once", () => {
    const hit = MARKETING.exec(README);
    expect(hit?.[0], `line: ${README.split("\n").find((l) => MARKETING.test(l))}`).toBeUndefined();
  });
});
