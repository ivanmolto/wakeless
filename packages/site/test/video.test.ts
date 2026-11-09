// Task 14.2, unit (build): the built docs overview carries the demo video as a privacy-enhanced
// YouTube embed (youtube-nocookie.com) with no autoplay, and no other built page embeds one.
// Skips with a printed reason before `pnpm site:build`.
import { readFileSync } from "node:fs";
import { expect, it } from "vitest";
import { demoVideoId } from "../scripts/pages.js";
import { builtPages, describeBuilt } from "./built.js";

describeBuilt("demo video embed", () => {
  it("the overview embeds the README's video, privacy-enhanced and without autoplay", () => {
    const id = demoVideoId();
    const pages = builtPages();
    const overview = pages.find(([route]) => route === "/docs");
    expect(overview, "/docs not built").toBeDefined();
    const html = readFileSync(overview![1], "utf8");
    const iframes = [...html.matchAll(/<iframe\b[^>]*>/g)].map((m) => m[0]);
    expect(iframes).toHaveLength(1);
    const iframe = iframes[0]!;
    expect(iframe).toContain(`src="https://www.youtube-nocookie.com/embed/${id}"`);
    expect(iframe).toContain('title="Wakeless demo video"');
    expect(iframe).not.toMatch(/autoplay/i);
    expect(html).not.toContain("youtube.com/embed");
    expect(html).not.toContain("Video placeholder");

    for (const [route, file] of pages) {
      if (route === "/docs") continue;
      expect(readFileSync(file, "utf8"), `${route} embeds a video`).not.toContain("<iframe");
    }
  });
});
