// Task 12.3: every page is copied from a document that exists, is non-empty, and is public.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { PRIVATE_NOTES, ROOT, toMdx } from "../scripts/markdown.js";
import { PAGES } from "../scripts/pages.js";
import { render } from "../scripts/sync-content.js";
import { routes } from "../scripts/pages.js";

describe("site sources", () => {
  it("every MDX page's source document exists and is non-empty", () => {
    for (const page of PAGES) {
      const missing = page.sources.filter((s) => !existsSync(join(ROOT, s)));
      if (page.optional && missing.length > 0) {
        console.warn(`[skip] page ${page.slug}: ${missing.join(", ")} absent; the page is built only when it exists`);
        continue;
      }
      expect(missing, `page ${page.slug}`).toEqual([]);
      for (const source of page.sources) {
        expect(PRIVATE_NOTES, `page ${page.slug} is copied from a private note`).not.toContain(source);
        expect(readFileSync(join(ROOT, source), "utf8").trim().length, `${source} is empty`).toBeGreaterThan(0);
      }
      const copied = page.build().filter((b) => "from" in b);
      expect(copied.length, `page ${page.slug} copies nothing`).toBeGreaterThan(0);
      for (const block of copied) {
        expect(page.sources, `page ${page.slug} copies from an undeclared source`).toContain(block.from);
        expect(toMdx(block.nodes).trim().length, `page ${page.slug}: empty selection from ${block.from}`).toBeGreaterThan(0);
      }
    }
  });

  it("the ledger page names the snapshot date and the trust page is the README verbatim", () => {
    const ledger = PAGES.find((p) => p.slug === "ledger")!;
    expect(ledger.title).toMatch(/\(snapshot \d{4}-\d{2}-\d{2}\)$/);
    expect(readFileSync(join(ROOT, "docs/LEAKAGE.md"), "utf8")).toContain(ledger.title.slice(-11, -1));

    const trust = PAGES.find((p) => p.slug === "trust-boundary")!;
    const mdx = render(trust, routes(PAGES));
    expect(mdx).toContain("## Trust boundary");
    expect(mdx).toContain("## Limitations");
    expect(mdx).toContain("Wakeless's privacy is against the public ledger, not against operators.");
  });
});
