import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOC = join(import.meta.dirname, "..", "SCHEME.md");

describe("docs/SCHEME.md", () => {
  it("SCHEME.md has the four sections and quotes line numbers", () => {
    const text = readFileSync(DOC, "utf8");

    const headings = text
      .split("\n")
      .filter(line => line.startsWith("## "))
      .map(line => line.slice(3).trim());
    expect(headings).toEqual([
      "1. What we reuse verbatim",
      "2. The `BatchVoucher` signed message",
      "3. Every place the SVM binding names the payment-channels program",
      "4. The `batch-settlement-shielded` accept",
    ]);

    // Every citation of a spec file is a backticked path that carries :L<n>.
    // The sources table at the top lists the bare paths once each; it is the
    // only place a bare `specs/...` path is allowed.
    const citations = [...text.matchAll(/`specs\/[^`]+`/g)].map(m => m[0]);
    expect(citations.length).toBeGreaterThan(20);
    const sourcesTable = text.slice(0, text.indexOf("## 1."));
    const inBody = citations.filter(c => !sourcesTable.includes(c));
    for (const citation of inBody) {
      expect(citation, citation).toMatch(/:L\d+`$/);
    }
    // No line reference anywhere is bare (`:L` without a number).
    expect(text).not.toMatch(/:L`/);
  });
});
