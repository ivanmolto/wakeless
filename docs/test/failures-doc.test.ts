import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const DOC = join(ROOT, "docs", "FAILURES.md");

// `docs/FAILURES.md` is a private working note (`CLAUDE.md`, Working style): CI and
// cloud sessions never have it, so the suite skips there and says why.
const present = existsSync(DOC);
if (!present) console.warn("[skip] docs/FAILURES.md is a private working note and is absent here");

interface Row {
  readonly row: string;
  readonly code: string;
  readonly tests: readonly { file: string; title: string }[];
  readonly state: string;
}

/** The data rows of the first table: `| Row | Failure | Code | Status | Behaviour | Test | State |`. */
export function parseFailureRows(text: string): Row[] {
  const lines = text.split("\n").filter((line) => line.startsWith("| "));
  const header = lines.findIndex((line) => line.startsWith("| Row |"));
  expect(header).toBeGreaterThan(-1);
  const rows: Row[] = [];
  for (const line of lines.slice(header + 2)) {
    const cells = line.split("|").map((cell) => cell.trim());
    // `| a | b |` splits to ["", "a", "b", ""].
    if (cells.length !== 9) break;
    const [, row, , code, , , testCell, state] = cells as [string, string, string, string, string, string, string, string, string];
    const files = [...testCell.matchAll(/`(packages\/[^/`]+\/test\/[^`]+\.test\.ts)`/g)].map((m) => m[1]!);
    const titles = [...testCell.matchAll(/"([^"]+)"/g)].map((m) => m[1]!);
    expect(files, line).toHaveLength(titles.length);
    rows.push({ row, code, tests: files.map((file, i) => ({ file, title: titles[i]! })), state });
  }
  return rows;
}

describe.skipIf(!present)("docs/FAILURES.md", () => {
  it("every FAILURES.md row names a test that exists", () => {
    const text = readFileSync(DOC, "utf8");
    const rows = parseFailureRows(text);
    expect(rows.map((r) => r.row)).toEqual(["1", "2", "3", "4", "5", "6", "7", "8", "9", "10"]);

    const green = rows.filter((r) => r.state === "green");
    expect(green.length).toBeGreaterThanOrEqual(4);
    for (const row of rows) {
      expect(row.tests.length, `row ${row.row} names a test`).toBeGreaterThan(0);
      for (const { file, title } of row.tests) {
        expect(title, `row ${row.row}`).toMatch(/\S/);
        if (row.state !== "green") continue;
        const path = join(ROOT, file);
        expect(existsSync(path), `row ${row.row}: ${file}`).toBe(true);
        const source = readFileSync(path, "utf8");
        expect(source, `row ${row.row}: ${JSON.stringify(title)} in ${file}`).toContain(`it(${JSON.stringify(title)}`);
      }
    }

    // The four codes of rows 1 to 3 are the standard's; row 4 is transport.
    const codes = green.map((r) => r.code).join(" ");
    for (const code of ["cumulative_exceeds_deposit", "cumulative_amount_mismatch", "voucher_signature", "channel_id_mismatch", "shielded_facilitator_unavailable"]) {
      expect(codes).toContain(code);
    }
    // A working note about failures carries no address and no signature.
    expect(text).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{43,88}/);
  });
});
