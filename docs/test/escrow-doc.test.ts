import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOC = join(import.meta.dirname, "..", "ESCROW.md");

const VERDICTS = ["feasible as designed", "needs a commitment voucher", "unknown"];

describe("docs/ESCROW.md", () => {
  it("ESCROW.md answers four questions and concludes", () => {
    const text = readFileSync(DOC, "utf8");

    // Four numbered answers, in order, each phrased as a question.
    const answers = text
      .split("\n")
      .filter(line => /^## \d\. /.test(line))
      .map(line => line.slice(3).trim());
    expect(answers.map(a => a.slice(0, 2))).toEqual(["1.", "2.", "3.", "4."]);
    for (const answer of answers) {
      expect(answer, answer).toMatch(/\?$/);
    }

    // The last non-empty line carries exactly one of the three verdicts.
    const lines = text.trimEnd().split("\n");
    const last = lines[lines.length - 1] ?? "";
    const hits = VERDICTS.filter(v => last.includes(v));
    expect(hits, last).toHaveLength(1);

    // Privacy rule: every document that describes privacy names all three
    // operators who see inside.
    expect(text).toMatch(/the facilitator \(vouchers\), MagicBlock's enclave/);
    expect(text).toMatch(/NEAR's private shard/);
  });
});
