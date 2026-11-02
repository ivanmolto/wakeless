import { readFileSync } from "node:fs";
import { join } from "node:path";
// A relative import: the root has no dependency on the workspace packages, like the other docs tests.
import { SCHEME_ERROR_CODES, isSchemeErrorCode } from "../../packages/scheme/src/errors.js";
import { describe, expect, it } from "vitest";

const DOC = join(import.meta.dirname, "..", "RECOVERY.md");

// Task 6.3: the recovery document names real codes, cites the spec by line, and keeps
// the two tables a buyer and a seller act on.
describe("docs/RECOVERY.md", () => {
  it("RECOVERY.md names only real error codes and cites the spec by line", () => {
    const text = readFileSync(DOC, "utf8");

    const headings = text
      .split("\n")
      .filter((line) => line.startsWith("## "))
      .map((line) => line.slice(3).trim());
    expect(headings).toEqual(["1. The rules the spec sets", "2. What Wakeless does with them", "3. The buyer", "4. The seller", "5. The facilitator", "6. Checklist"]);

    // Every backticked snake_case word that looks like an error code is one the scheme defines.
    const codes = [...text.matchAll(/`((?:invalid|unexpected|settlement|duplicate|shielded)_[a-z0-9_]+)`/g)].map((m) => m[1]!);
    expect(codes.length).toBeGreaterThan(10);
    for (const code of codes) expect(isSchemeErrorCode(code), code).toBe(true);
    for (const must of [SCHEME_ERROR_CODES.settlementPending, SCHEME_ERROR_CODES.duplicateSettlement, SCHEME_ERROR_CODES.shieldedRateLimited, SCHEME_ERROR_CODES.shieldedVerifyRequired, SCHEME_ERROR_CODES.cumulativeAmountMismatch]) {
      expect(codes, must).toContain(must);
    }

    // Spec citations carry line numbers, like docs/SCHEME.md.
    // A full path, or the short `:L…` form that follows a named file in the same sentence.
    const citations = [...text.matchAll(/`(?:specs\/|scheme_batch_settlement_svm\.md|:L)[^`]*`/g)].map((m) => m[0]);
    expect(citations.length).toBeGreaterThan(4);
    for (const citation of citations) expect(citation, citation).toMatch(/:L\d+`$/);
    expect(text).not.toMatch(/:L`/);

    // The two things the document exists to say.
    expect(text).toContain("pendingDeposit");
    expect(text).toContain("exact request envelope");
    expect(text).toContain("extra.replayed: true");
  });
});
