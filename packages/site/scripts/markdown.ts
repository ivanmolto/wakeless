// Markdown helpers for the site's build-time copy (task 12.3). Sources are parsed to an
// mdast tree, the wanted nodes are selected, links are rewritten for the site, and the
// result is printed through remark-mdx so `<`, `{` and `}` in prose come out escaped.
// Nothing here writes prose of its own: it selects and copies.
import { existsSync, readFileSync, statSync } from "node:fs";
import { dirname, join, normalize, relative } from "node:path";
import type { Heading, Nodes, Paragraph, PhrasingContent, Root, RootContent, Table, Text } from "mdast";
import { toString } from "mdast-util-to-string";
import remarkGfm from "remark-gfm";
import remarkMdx from "remark-mdx";
import remarkParse from "remark-parse";
import remarkStringify from "remark-stringify";
import { unified } from "unified";
import { visit } from "unist-util-visit";

/** The monorepo root: the nearest ancestor with pnpm-workspace.yaml, so a deploy rooted at packages/site still finds the sources. */
function findRoot(): string {
  let dir = import.meta.dirname;
  for (;;) {
    if (existsSync(join(dir, "pnpm-workspace.yaml"))) return dir;
    const parent = dirname(dir);
    if (parent === dir) throw new Error("pnpm-workspace.yaml not found above packages/site");
    dir = parent;
  }
}
export const ROOT = findRoot();
export const GITHUB = "https://github.com/ivanmolto/wakeless";

/** Private working notes (CLAUDE.md, Working style): never a source, never a link target. */
export const PRIVATE_NOTES = [
  "docs/VERSIONS.md",
  "docs/DEVIATIONS.md",
  "docs/FAILURES.md",
  "docs/IDEAS.md",
  "docs/LOG.md",
  "docs/MID-SUBMISSION.md",
  "docs/OUTREACH.md",
  "docs/wakeless-briefing.md",
  "docs/wakeless-plan.md",
  "docs/wakeless-after-hackathon.md",
];

export function parse(markdown: string): Root {
  return unified().use(remarkParse).use(remarkGfm).parse(markdown);
}

export function readTree(file: string): Root {
  return parse(readFileSync(join(ROOT, file), "utf8"));
}

/** Print nodes as MDX. remark-mdx's printer escapes characters MDX would read as JSX or expressions. */
export function toMdx(nodes: RootContent[]): string {
  const root: Root = { type: "root", children: nodes };
  return unified()
    .use(remarkGfm, { tablePipeAlign: false })
    .use(remarkMdx)
    .use(remarkStringify, { bullet: "-", fences: true, rule: "-", emphasis: "_" })
    .stringify(root);
}

const isH = (node: RootContent, depth: number): node is Heading => node.type === "heading" && node.depth === depth;

/** The nodes between the H1 (if any) and the first H2, without raw HTML (the README's wordmark). */
export function intro(tree: Root): RootContent[] {
  const out: RootContent[] = [];
  for (const node of tree.children) {
    if (isH(node, 2)) break;
    if (isH(node, 1) || node.type === "html") continue;
    out.push(node);
  }
  return out;
}

/** An H2 section by its exact title: the heading (when `withHeading`) and every node up to the next H2. */
export function section(tree: Root, title: string, withHeading: boolean): RootContent[] {
  const start = tree.children.findIndex((n) => isH(n, 2) && toString(n) === title);
  if (start < 0) throw new Error(`section "${title}" not found`);
  const end = tree.children.findIndex((n, i) => i > start && isH(n, 2));
  const body = tree.children.slice(start + 1, end < 0 ? undefined : end);
  return withHeading ? [tree.children[start]!, ...body] : body;
}

/** The whole document without its H1. */
export function body(tree: Root): RootContent[] {
  return tree.children.filter((n) => !isH(n, 1));
}

/** The first paragraph whose text starts with `prefix`. */
export function paragraphStartingWith(nodes: RootContent[], prefix: string): Paragraph {
  const found = nodes.find((n): n is Paragraph => n.type === "paragraph" && toString(n).startsWith(prefix));
  if (!found) throw new Error(`no paragraph starting with "${prefix}"`);
  return found;
}

/** The first list item whose text starts with `prefix`, as a one-item list. */
export function listItemStartingWith(nodes: RootContent[], prefix: string): RootContent {
  for (const node of nodes) {
    if (node.type !== "list") continue;
    const item = node.children.find((li) => toString(li).startsWith(prefix));
    if (item) return { ...node, children: [item] };
  }
  throw new Error(`no list item starting with "${prefix}"`);
}

/** The first code block whose text contains `needle`. */
export function codeContaining(nodes: RootContent[], needle: string): RootContent {
  const found = nodes.find((n) => n.type === "code" && n.value.includes(needle));
  if (!found) throw new Error(`no code block containing "${needle}"`);
  return found;
}

/** A paragraph cut after its first sentence (the first ". " inside a plain text node). */
export function firstSentence(paragraph: Paragraph): Paragraph {
  const children: PhrasingContent[] = [];
  for (const child of paragraph.children) {
    if (child.type === "text" && child.value.includes(". ")) {
      children.push({ type: "text", value: child.value.slice(0, child.value.indexOf(". ") + 1) } satisfies Text);
      return { type: "paragraph", children };
    }
    children.push(child);
  }
  return paragraph;
}

/** The first table in `nodes`, keeping the header row and the rows whose first cell is in `rows`. */
export function tableRows(nodes: RootContent[], rows: string[]): Table {
  const table = nodes.find((n): n is Table => n.type === "table");
  if (!table) throw new Error("no table");
  const [header, ...rest] = table.children;
  const kept = rest.filter((row) => rows.includes(toString(row.children[0]!)));
  if (kept.length !== rows.length) throw new Error(`table rows not all found: ${rows.join(", ")}`);
  return { ...table, children: [header!, ...kept] };
}

export interface LinkContext {
  /** Repo-relative path of the source file the nodes came from. */
  from: string;
  /** Repo-relative path (file or directory) → site route. */
  routes: Record<string, string>;
}

/** Resolve a link found in `from` for the site: a route when the target is a page, GitHub otherwise. */
export function rewriteUrl(url: string, ctx: LinkContext): string {
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) || url.startsWith("#") || url.startsWith("//")) return url;
  const [pathPart, hash] = url.split("#", 2) as [string, string | undefined];
  const target = normalize(join(dirname(ctx.from), pathPart)).replace(/\/+$/, "");
  if (target.startsWith("..")) throw new Error(`link outside the repo in ${ctx.from}: ${url}`);
  if (PRIVATE_NOTES.includes(target)) throw new Error(`link to a private note in ${ctx.from}: ${url}`);
  const route = ctx.routes[target];
  if (route) return route + (hash ? `#${hash}` : "");
  const abs = join(ROOT, target);
  if (!existsSync(abs)) throw new Error(`broken link in ${ctx.from}: ${url} (${relative(ROOT, abs)})`);
  const kind = statSync(abs).isDirectory() ? "tree" : "blob";
  return `${GITHUB}/${kind}/main/${target}` + (hash ? `#${hash}` : "");
}

/** Rewrite every link and definition in `nodes`; raw HTML becomes text so it prints escaped. */
export function prepare(nodes: RootContent[], ctx: LinkContext): RootContent[] {
  const copy = structuredClone(nodes);
  const root: Root = { type: "root", children: copy };
  visit(root, (node: Nodes, index, parent) => {
    if (node.type === "link" || node.type === "definition" || node.type === "image") {
      node.url = rewriteUrl(node.url, ctx);
    } else if (node.type === "html" && parent && index !== undefined) {
      const text: Text = { type: "text", value: node.value };
      const replacement = parent.type === "root" ? { type: "paragraph", children: [text] } : text;
      parent.children.splice(index, 1, replacement as never);
    }
  });
  return root.children;
}
