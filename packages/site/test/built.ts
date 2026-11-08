// Shared by the unit (build) tests: the Next build's output, or a printed reason to skip.
import { existsSync, readdirSync } from "node:fs";
import { join, relative } from "node:path";
import { describe } from "vitest";

export const SITE = join(import.meta.dirname, "..");
export const APP = join(SITE, ".next", "server", "app");
export const SEARCH_BODY = join(APP, "api", "search.body");

/** A `describe` that runs only after `pnpm site:build`, and says why when it skips. */
export function describeBuilt(name: string, fn: () => void) {
  const built = existsSync(SEARCH_BODY);
  if (!built) console.warn(`[skip] ${name}: no site build (run pnpm site:build; ${relative(SITE, SEARCH_BODY)} is absent)`);
  return describe.skipIf(!built)(name, fn);
}

/** Every prerendered HTML page, as [route, file]. */
export function builtPages(): [string, string][] {
  const out: [string, string][] = [];
  const walk = (dir: string) => {
    for (const entry of readdirSync(dir, { withFileTypes: true })) {
      const file = join(dir, entry.name);
      if (entry.isDirectory()) walk(file);
      else if (entry.name.endsWith(".html") && !entry.name.startsWith("_")) {
        const route = "/" + relative(APP, file).replace(/\.html$/, "").replace(/(^|\/)index$/, "");
        out.push([route, file]);
      }
    }
  };
  walk(APP);
  return out;
}
