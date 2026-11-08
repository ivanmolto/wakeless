// Task 12.3, unit (build): the search index the build exports, loaded and queried the way the
// browser's static client does it (zbsearch, the engine fumadocs-core ships). No external service.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { create, load, search } from "zbsearch";
import { SEARCH_BODY, describeBuilt } from "./built.js";

describeBuilt("site search", () => {
  it("built search index contains voucher, trust boundary, fund and leak", async () => {
    // The schema is replaced by the loaded export; it is declared here only for the types.
    const db = create({ schema: { content: "string", url: "string" } });
    load(db, JSON.parse(readFileSync(SEARCH_BODY, "utf8")));
    const expected: Record<string, string> = {
      voucher: "/x402-integration",
      "trust boundary": "/trust-boundary",
      fund: "/fund-from-any-chain",
      leak: "/ledger",
    };
    for (const [term, page] of Object.entries(expected)) {
      const result = await search(db, { term, properties: ["content"], limit: 200 });
      const urls = result.hits.map((hit) => String(hit.document.url ?? ""));
      expect(result.count, `no hit for "${term}"`).toBeGreaterThan(0);
      expect(urls.some((u) => u.startsWith(page)), `"${term}" does not reach ${page}`).toBe(true);
    }
  });
});
