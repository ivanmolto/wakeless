// Task 12.3: every page is copied from a document that exists, is non-empty, and is public.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { buildLandingData } from "../scripts/landing-data.js";
import { PRIVATE_NOTES, ROOT, toMdx } from "../scripts/markdown.js";
import { PAGES, SDK_PACKAGES, availablePages, demoVideoId, installLine, publishedVersion, routes } from "../scripts/pages.js";
import { render } from "../scripts/sync-content.js";

describe("site sources", () => {
  // The extractors pin headings and first words in the README and docs/. This runs every one
  // of them, so a renamed heading fails `pnpm test` here rather than the Vercel build.
  it("every available page renders and the landing data builds", () => {
    const { pages } = availablePages();
    const routeMap = routes(pages);
    for (const page of pages) {
      const mdx = render(page, routeMap);
      expect(mdx, `page ${page.slug}`).toContain(`title: ${JSON.stringify(page.title)}`);
      expect(mdx.trim().split("\n").length, `page ${page.slug} is near-empty`).toBeGreaterThan(5);
    }
    expect(() => buildLandingData()).not.toThrow();
  });

  it("the install page's version is the packages' version, and the five packages agree", () => {
    const version = publishedVersion();
    expect(version).toMatch(/^\d+\.\d+\.\d+(-[\w.]+)?$/);
    for (const p of SDK_PACKAGES) {
      const pkg = JSON.parse(readFileSync(join(ROOT, `packages/${p}/package.json`), "utf8")) as { version: string };
      expect(pkg.version, `packages/${p}/package.json version`).toBe(version);
      expect(installLine(`packages/${p}/README.md`), `packages/${p}/README.md install line`).toContain(`@${version}`);
    }
    const quickstart = render(PAGES.find((p) => p.slug === "quickstart")!, routes(PAGES));
    expect(quickstart).toContain(`(\`${version}\`, ESM only`);
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(`at \`${version}\``);
  });

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

  // Task 14.2: the overview embeds the video the README links, and nothing else names a video id.
  it("the overview's video embed is the README's demo video", () => {
    const id = demoVideoId();
    expect(id).toMatch(/^[\w-]{11}$/);
    expect(readFileSync(join(ROOT, "README.md"), "utf8")).toContain(`Demo video: <https://youtu.be/${id}>`);
    const home = render(PAGES.find((p) => p.slug === "index")!, routes(PAGES));
    expect(home).toContain(`<DemoVideo id="${id}" />`);
    expect(home).not.toContain("VideoPlaceholder");
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
