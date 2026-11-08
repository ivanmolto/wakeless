// The site's page manifest (task 12.3). Every page is copied at build time from the README,
// docs/ or a package README; nothing here is page prose. Headings that join two sources and
// the JSX on Home are the only text the site adds. Private working notes are never a source.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { RootContent } from "mdast";
import {
  ROOT,
  body,
  codeContaining,
  intro,
  listItemStartingWith,
  paragraphStartingWith,
  readTree,
  section,
  tableRows,
} from "./markdown.js";

/** Nodes copied from one source file, or a line of MDX the site adds. */
export type Block = { from: string; nodes: RootContent[] } | { mdx: string };

export interface Page {
  /** Path under content/docs without extension; "index" is Home. */
  slug: string;
  title: string;
  /** Repo-relative files the page is copied from. */
  sources: string[];
  /** Skipped, with a printed reason, when a source is absent (Relationship terms: only if docs/TERMS.md exists). */
  optional?: boolean;
  build(): Block[];
}

const README = "README.md";
export const SDK_PACKAGES = ["scheme", "binding", "binding-magicblock", "client", "vendor"] as const;

const heading = (text: string): Block => ({ mdx: `## ${text}` });

/** The `npm install …` inline code that opens a package README's install paragraph. */
export function installLine(file: string): string {
  const paragraph = paragraphStartingWith(body(readTree(file)), "npm install");
  const code = paragraph.children.find((c) => c.type === "inlineCode" && c.value.startsWith("npm install"));
  if (!code || code.type !== "inlineCode") throw new Error(`${file}: install paragraph has no npm install code`);
  return code.value;
}

/** The snapshot date `docs/LEAKAGE.md` states in its first line ("Snapshot **YYYY-MM-DD**"). */
export function leakageSnapshotDate(): string {
  const text = readFileSync(join(ROOT, "docs/LEAKAGE.md"), "utf8");
  const match = /Snapshot \*\*(\d{4}-\d{2}-\d{2})\*\*/.exec(text);
  if (!match) throw new Error("docs/LEAKAGE.md states no snapshot date");
  return match[1]!;
}

export const PAGES: Page[] = [
  {
    slug: "index",
    title: "Wakeless",
    sources: [README],
    build() {
      const readme = readTree(README);
      const lead = intro(readme);
      const first = lead.find((n) => n.type === "paragraph");
      if (!first || first.type !== "paragraph") throw new Error("README has no intro paragraph");
      return [
        { from: README, nodes: [first, paragraphStartingWith(lead, "Status:")] },
        {
          from: README,
          nodes: [
            tableRows(section(readme, "Side by side: the same workload on both rails", false), [
              "Base-layer transactions per call",
              "Vendors recovered / actual",
            ]),
          ],
        },
        { mdx: "<VideoPlaceholder />" },
        { mdx: "<HomeButtons />" },
      ];
    },
  },
  {
    slug: "how-it-works",
    title: "How it works",
    sources: [README],
    build() {
      const readme = readTree(README);
      return [
        { from: README, nodes: intro(readme).filter((n) => n.type === "paragraph").slice(0, 1) },
        { from: README, nodes: section(readme, "Why hide the relationship", true) },
        { from: README, nodes: section(readme, "Side by side: the same workload on both rails", true) },
      ];
    },
  },
  {
    slug: "quickstart",
    title: "Quickstart",
    sources: [README, ...SDK_PACKAGES.map((p) => `packages/${p}/README.md`)],
    build() {
      // One shell block of the five install lines, each the inline code that opens its package README.
      const installs = SDK_PACKAGES.map((p) => installLine(`packages/${p}/README.md`));
      return [
        { from: README, nodes: section(readTree(README), "Quickstart", false) },
        heading("Install the packages"),
        { mdx: "From npm, outside this repo (`0.1.0-alpha.0`, ESM only, Node 22 or later):" },
        { mdx: "```bash\n" + installs.join("\n") + "\n```" },
      ];
    },
  },
  {
    slug: "fund-from-any-chain",
    title: "Fund from any chain",
    sources: ["docs/FUNDING.md"],
    build: () => [{ from: "docs/FUNDING.md", nodes: body(readTree("docs/FUNDING.md")) }],
  },
  ...SDK_PACKAGES.map(
    (p): Page => ({
      slug: `sdk/${p}`,
      title: `@wakeless/${p}`,
      sources: [`packages/${p}/README.md`],
      build: () => [{ from: `packages/${p}/README.md`, nodes: body(readTree(`packages/${p}/README.md`)) }],
    }),
  ),
  {
    slug: "bindings",
    title: "Bindings",
    sources: ["packages/binding/README.md", README],
    build() {
      const binding = "packages/binding/README.md";
      const nodes = body(readTree(binding));
      const readme = readTree(README);
      return [
        heading("The interface"),
        { from: binding, nodes: [paragraphStartingWith(nodes, "The SettlementBinding interface"), codeContaining(nodes, "interface SettlementBinding")] },
        heading("MagicBlock today"),
        { from: README, nodes: section(readme, "How Solana powers it", false) },
        heading("Roadmap: Rings and Privacy Cash"),
        { from: README, nodes: [listItemStartingWith(section(readme, "v2", false), "Binding to Helius Rings")] },
      ];
    },
  },
  {
    slug: "x402-integration",
    title: "x402 integration",
    sources: [README],
    build: () => [{ from: README, nodes: section(readTree(README), "The x402 integration", false) }],
  },
  {
    slug: "trust-boundary",
    title: "Trust boundary and limitations",
    sources: [README],
    build() {
      const readme = readTree(README);
      return [
        { from: README, nodes: section(readme, "Trust boundary", true) },
        { from: README, nodes: section(readme, "Limitations", true) },
      ];
    },
  },
  {
    // The README's public mirror of the private docs/FAILURES.md (Ivan, 8 Nov 2026).
    slug: "failure-handling",
    title: "Failure handling",
    sources: [README],
    build: () => [{ from: README, nodes: section(readTree(README), "Failed payments", false) }],
  },
  {
    slug: "ledger",
    get title() {
      return `What the ledger already knows (snapshot ${leakageSnapshotDate()})`;
    },
    sources: ["docs/LEAKAGE.md"],
    build: () => [{ from: "docs/LEAKAGE.md", nodes: body(readTree("docs/LEAKAGE.md")) }],
  },
  {
    slug: "relationship-terms",
    title: "Relationship terms",
    sources: ["docs/TERMS.md"],
    optional: true,
    build: () => [{ from: "docs/TERMS.md", nodes: body(readTree("docs/TERMS.md")) }],
  },
  {
    // The README's public section, not the private briefing §9b (Ivan, 8 Nov 2026).
    slug: "prior-art",
    title: "Prior art",
    sources: [README],
    build: () => [{ from: README, nodes: section(readTree(README), "Prior art and what is new", false) }],
  },
  {
    slug: "roadmap",
    title: "Roadmap",
    sources: [README],
    build: () => [{ from: README, nodes: section(readTree(README), "v2", false) }],
  },
];

/** Pages whose sources are all present. */
export function availablePages(): { pages: Page[]; skipped: { page: Page; missing: string[] }[] } {
  const pages: Page[] = [];
  const skipped: { page: Page; missing: string[] }[] = [];
  for (const page of PAGES) {
    const missing = page.sources.filter((s) => !existsSync(join(ROOT, s)));
    if (missing.length === 0) pages.push(page);
    else if (page.optional) skipped.push({ page, missing });
    else throw new Error(`page ${page.slug}: source missing: ${missing.join(", ")}`);
  }
  return { pages, skipped };
}

/** Repo path (file or directory) → site route, for the pages that exist. */
export function routes(pages: Page[]): Record<string, string> {
  const map: Record<string, string> = {};
  const has = (slug: string) => pages.some((p) => p.slug === slug);
  const add = (path: string, slug: string) => {
    if (has(slug)) map[path] = slug === "index" ? "/docs" : `/docs/${slug}`;
  };
  add("README.md", "index");
  add("docs/FUNDING.md", "fund-from-any-chain");
  add("docs/LEAKAGE.md", "ledger");
  add("docs/TERMS.md", "relationship-terms");
  for (const p of SDK_PACKAGES) {
    add(`packages/${p}`, `sdk/${p}`);
    add(`packages/${p}/README.md`, `sdk/${p}`);
  }
  return map;
}
