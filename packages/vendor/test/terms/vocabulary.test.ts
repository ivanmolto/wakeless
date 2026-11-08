// The CI grep as a test (CLAUDE.md, Relationship terms; docs/VOCABULARY.md): the layer's
// code, docs/TERMS.md and the README never use the words that name a portable number
// about a buyer.
import { readdirSync, readFileSync, statSync } from "node:fs";
import { join, relative, resolve } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "../../../..");

/** Whole words only: `scores` is forbidden, `underscore` is not. */
export const FORBIDDEN = /\b(score|scores|scored|scoring|rating|ratings|collateral)\b|reputation score|trust level|credit score/i;

function filesUnder(dir: string): string[] {
  return readdirSync(dir).flatMap((name) => {
    const path = join(dir, name);
    return statSync(path).isDirectory() ? filesUnder(path) : [path];
  });
}

describe("vocabulary", () => {
  it("forbidden vocabulary is absent from the terms code, TERMS.md and README", () => {
    const files = [...filesUnder(resolve(ROOT, "packages/vendor/src/terms")), resolve(ROOT, "docs/TERMS.md"), resolve(ROOT, "README.md")];
    const hits: string[] = [];
    for (const file of files) {
      readFileSync(file, "utf8")
        .split("\n")
        .forEach((line, i) => {
          const match = FORBIDDEN.exec(line);
          if (match !== null) hits.push(`${relative(ROOT, file)}:${i + 1}: "${match[0]}"`);
        });
    }
    expect(hits, hits.join("\n")).toEqual([]);
    expect(files.length).toBeGreaterThan(6);
  });

  it("the four terms are the labels the receipt uses", async () => {
    const { LABELS } = await import("../../src/index.js");
    expect(Object.values(LABELS).sort()).toEqual(["funding requirement", "relationship capital", "risk premium", "standard price"]);
    for (const label of Object.values(LABELS)) expect(FORBIDDEN.test(label)).toBe(false);
  });
});
