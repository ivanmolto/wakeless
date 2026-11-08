// Task 12.3, unit (build): every internal href and src in the built site resolves to a page,
// a public file or a built asset. Skips with a printed reason before `pnpm site:build`.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { PAGES } from "../scripts/pages.js";
import { SITE, builtPages, describeBuilt } from "./built.js";

describeBuilt("site links", () => {
  it("no broken internal link in the built site", () => {
    const pages = builtPages();
    const routes = new Set(pages.map(([route]) => route));
    // Every manifest page whose sources exist was built (Relationship terms only with docs/TERMS.md).
    for (const page of PAGES) {
      if (page.optional && !page.sources.every((s) => existsSync(join(SITE, "..", "..", s)))) continue;
      expect(routes, `page ${page.slug} not built`).toContain(page.slug === "index" ? "/" : `/${page.slug}`);
    }

    const resolves = (path: string) =>
      routes.has(path.replace(/\/$/, "") || "/") ||
      path === "/api/search" ||
      (path.startsWith("/_next/") && existsSync(join(SITE, ".next", path.replace(/^\/_next\//, "")))) ||
      existsSync(join(SITE, "public", decodeURIComponent(path)));

    const broken: string[] = [];
    let checked = 0;
    for (const [route, file] of pages) {
      const html = readFileSync(file, "utf8");
      for (const match of html.matchAll(/\s(?:href|src)="(\/(?!\/)[^"]*)"/g)) {
        const path = match[1]!.split(/[?#]/)[0]!;
        checked++;
        if (!resolves(path)) broken.push(`${route} → ${match[1]}`);
      }
    }
    expect(checked).toBeGreaterThan(0);
    expect(broken).toEqual([]);
  });
});
