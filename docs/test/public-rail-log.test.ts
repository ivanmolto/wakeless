import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOC = join(import.meta.dirname, "..", "public-rail-log.md");
const SIGNATURE = /`([1-9A-HJ-NP-Za-km-z]{87,88})`/g;

function section(text: string, heading: string): string {
  const start = text.indexOf(`\n${heading}\n`);
  expect(start, `heading ${JSON.stringify(heading)}`).toBeGreaterThan(-1);
  const rest = text.slice(start + heading.length + 2);
  const level = heading.match(/^#+/)![0];
  const next = rest.search(new RegExp(`\\n#{1,${level.length}} `));
  return next === -1 ? rest : rest.slice(0, next);
}

describe("docs/public-rail-log.md", () => {
  const text = readFileSync(DOC, "utf8");

  it("public-rail log has every signature of the run and the reconstruction block", () => {
    // The plan wrote "ten signatures"; batch-settlement put three transactions on
    // chain for ten calls, and that count is the finding (docs/DEVIATIONS.md).
    const rail = section(text, "### The rail: three on-chain transactions for ten calls");
    const railSigs = [...rail.matchAll(SIGNATURE)].map(m => m[1]);
    expect(railSigs).toHaveLength(3);
    expect(new Set(railSigs).size).toBe(3);

    const all = [...text.matchAll(SIGNATURE)].map(m => m[1]);
    expect(new Set(all).size).toBeGreaterThanOrEqual(6); // three rail, three setup

    const count = section(text, "## Transaction count per call");
    expect(count).toContain("Total: 3 on-chain transactions for 10 paid calls");
    // Ten numbered call rows, one transaction for the first and none after.
    expect(count).toMatch(/\| 1 \| 1 \|/);
    for (let call = 2; call <= 10; call++) expect(count).toMatch(new RegExp(`\\| ${call} \\| 0 \\|`));

    const table = section(text, "## What is public, per transaction");
    const header = table.split("\n").find(line => line.startsWith("| # |"));
    expect(header).toBeDefined();
    for (const column of ["Payer", "payTo", "Deposit", "Cumulative settled"]) {
      expect(header).toContain(`| ${column} |`);
    }
    // One row per rail signature's role, in order.
    expect(table).toMatch(/\| 1 `open` \|[\s\S]*\| 2 `settle` \|[\s\S]*\| 3 `distribute` \|/);

    const rebuilt = section(text, "## What an observer rebuilds");
    expect(rebuilt).toContain("**Payer:**");
    expect(rebuilt).toContain("**Vendor set:**");
    expect(rebuilt).toContain("**First-contact order:**");
    expect(rebuilt).toContain("**Cumulative spend per vendor:**");
    // The baseline reconstruct() must reproduce on Day 9.
    expect(rebuilt).toContain("`94BRf9UjVLdNUBGGeKuFqWSk4sA67EDtAmS9pm6RTjzT`");
    expect(rebuilt).toContain("vendors = [9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy]");
    expect(rebuilt).toContain("9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy: 100000n");
  });

  it("names the three operators' public footprint and no secret", () => {
    // The log quotes devnet transactions, never keys, vouchers or bearer tokens.
    expect(text).not.toMatch(/SVM_PRIVATE_KEY=\S/);
    expect(text).not.toMatch(/Bearer /i);
    expect(text).not.toMatch(/api-key=/);
    // Only the recorded 88-character devnet signatures may be that long; the
    // voucher's Ed25519 signature bytes stay out of the document.
    const long = [...text.matchAll(/[1-9A-HJ-NP-Za-km-z]{87,}/g)].map(m => m[0]);
    const recorded = new Set([...text.matchAll(SIGNATURE)].map(m => m[1]));
    for (const value of long) expect(recorded.has(value), value.slice(0, 8)).toBe(true);
  });

  it("observed JSON holds the rail transactions and the channel account", () => {
    const observed = JSON.parse(
      readFileSync(join(import.meta.dirname, "..", "public-rail-observed.json"), "utf8"),
    ) as Record<string, unknown>;
    const rail = section(text, "### The rail: three on-chain transactions for ten calls");
    for (const signature of [...rail.matchAll(SIGNATURE)].map(m => m[1]!)) {
      expect(observed[signature], signature.slice(0, 8)).toBeTruthy();
    }
    expect(observed.channel).toMatchObject({
      deposit: "100000",
      settled: "100000",
      payoutWatermark: "100000",
      payer: "94BRf9UjVLdNUBGGeKuFqWSk4sA67EDtAmS9pm6RTjzT",
    });
  });
});
