import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { loadDotEnv } from "../../scripts/lib/env.js";

const DOC = join(import.meta.dirname, "..", "aurora-dry-run.md");

describe("docs/aurora-dry-run.md", () => {
  it("aurora dry-run answers the three questions with the key redacted", () => {
    const text = readFileSync(DOC, "utf8");

    const headings = text.split("\n").filter(line => line.startsWith("## "));
    expect(headings).toEqual([
      "## 1. Is Solana USDC accepted as a confidential destination from each origin?",
      "## 2. What does the quote return for the deposit address and expiry?",
      "## 3. What does the status endpoint return for an unknown deposit address?",
      "## Costs observed",
      "## Responses",
    ]);

    const responses = text.split("\n").filter(line => line.startsWith("### Quote response: "));
    expect(responses).toEqual(["### Quote response: USDC on Base", "### Quote response: USDC on NEAR"]);

    expect(text).not.toMatch(/\/api\/(tokens|quote|status)\/(?!\[redacted\])/);
    // The referral names the Studio account; it appears only redacted.
    expect(text).toContain('"referral": "[redacted]"');
    expect(text).not.toMatch(/"referral": "(?!\[redacted\]")/);

    loadDotEnv(join(import.meta.dirname, "..", ".."));
    const key = process.env.AURORA_API_KEY;
    if (key) expect(text).not.toContain(key);
    else console.warn("[skip] key check: AURORA_API_KEY is not set");
  });
});
