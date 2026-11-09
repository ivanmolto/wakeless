// Evidence capture: renders a saved terminal transcript to a 1760 × 1000 PNG with the slide
// deck's terminal theme (background #171819, foreground #F6F5F1, monospace, 100 columns ×
// 28 rows filling the frame), through headless Chrome. Rendering the saved text instead of
// photographing a window gives the exact size with no title bar, tabs or scrollbars to
// crop, and nothing can be in frame that is not in the text file. The text is refused if
// it is wider than 100 columns, taller than 28 rows, or carries a signature or a token.
//
//   pnpm shots:render <input.txt> <output.png>
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

const COLUMNS = 100;
const ROWS = 28;
const WIDTH = 1760;
const HEIGHT = 1000;
const CHROME = process.env.CHROME_BIN ?? "/Applications/Google Chrome.app/Contents/MacOS/Google Chrome";

function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function page(text: string): string {
  return `<!doctype html>
<html><head><meta charset="utf-8"><style>
  html, body { margin: 0; padding: 0; background: #171819; }
  body { width: ${WIDTH}px; height: ${HEIGHT}px; overflow: hidden; }
  pre { margin: 0; padding: 28px 32px; color: #F6F5F1; font-family: "SF Mono", Menlo, "DejaVu Sans Mono", monospace; white-space: pre; tab-size: 4; }
  #m { position: absolute; visibility: hidden; white-space: pre; font-family: "SF Mono", Menlo, "DejaVu Sans Mono", monospace; }
</style></head><body>
<span id="m">${"M".repeat(COLUMNS)}</span>
<pre id="t">${escapeHtml(text)}</pre>
<script>
  // Size the font so ${COLUMNS} columns fill the width inside the padding and ${ROWS} rows fill the height.
  const m = document.getElementById("m"), t = document.getElementById("t");
  const probe = 20; m.style.fontSize = probe + "px";
  const size = (${WIDTH} - 64) / m.getBoundingClientRect().width * probe;
  t.style.fontSize = size.toFixed(2) + "px";
  t.style.lineHeight = ((${HEIGHT} - 56) / ${ROWS}).toFixed(2) + "px";
  document.title = "ready";
</script>
</body></html>`;
}

function main(): void {
  const [input, output] = process.argv.slice(2);
  if (!input || !output) throw new Error("usage: pnpm shots:render <input.txt> <output.png>");
  if (!existsSync(CHROME)) throw new Error(`Chrome not found at ${CHROME}; set CHROME_BIN`);
  const text = readFileSync(resolve(input), "utf8").replace(/\n$/, "");
  const lines = text.split("\n");
  if (lines.length > ROWS) throw new Error(`${input} has ${lines.length} lines; the frame holds ${ROWS}`);
  const widest = Math.max(...lines.map((line) => [...line].length));
  if (widest > COLUMNS) throw new Error(`${input} has a ${widest}-column line; the frame holds ${COLUMNS}`);
  if (/[1-9A-HJ-NP-Za-km-z]{86,90}/.test(text) || /bearer /i.test(text)) throw new Error(`${input} carries a signature or a token; not rendered`);

  const work = join(tmpdir(), "wakeless-shots");
  mkdirSync(join(work, "profile"), { recursive: true });
  const html = join(work, "frame.html");
  writeFileSync(html, page(text));
  const out = resolve(output);
  execFileSync(
    CHROME,
    [
      "--headless=new",
      "--disable-gpu",
      "--hide-scrollbars",
      "--force-device-scale-factor=1",
      `--window-size=${WIDTH},${HEIGHT}`,
      `--user-data-dir=${join(work, "profile")}`,
      "--virtual-time-budget=1500",
      `--screenshot=${out}`,
      `file://${html}`,
    ],
    { stdio: "pipe" },
  );
  const probe = execFileSync("sips", ["-g", "pixelWidth", "-g", "pixelHeight", out], { encoding: "utf8" });
  const width = Number(/pixelWidth: (\d+)/.exec(probe)?.[1]);
  const height = Number(/pixelHeight: (\d+)/.exec(probe)?.[1]);
  if (width !== WIDTH || height !== HEIGHT) throw new Error(`rendered ${width} × ${height}, expected ${WIDTH} × ${HEIGHT}`);
  console.log(`${output}  ${width} × ${height}  ${lines.length} rows, widest ${widest} columns`);
}

try {
  main();
} catch (error: unknown) {
  console.error(`[shots:render] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
}
