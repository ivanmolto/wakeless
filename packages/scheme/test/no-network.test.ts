import { existsSync, readdirSync, readFileSync, statSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const PKG = join(import.meta.dirname, "..");

// Module specifiers and globals that would mean a network call. `fetch` is also
// matched bare: a pure scheme never needs it.
const FORBIDDEN = [
  /\bfetch\s*\(/,
  /["'](node:)?https?["']/,
  /["'](node:)?net["']/,
  /["'](node:)?dgram["']/,
  /["'](node:)?tls["']/,
  /["']undici["']/,
  /["']ws["']/,
  /["']@solana\/kit["']/,
  /["']@solana\/rpc[^"']*["']/,
  /XMLHttpRequest/,
  /WebSocket/,
];

function filesUnder(dir: string, ext: RegExp): string[] {
  return readdirSync(dir).flatMap(name => {
    const path = join(dir, name);
    if (statSync(path).isDirectory()) return filesUnder(path, ext);
    return ext.test(name) ? [path] : [];
  });
}

function scan(files: string[]) {
  for (const file of files) {
    const text = readFileSync(file, "utf8");
    for (const pattern of FORBIDDEN) {
      expect(text, `${file} matches ${pattern}`).not.toMatch(pattern);
    }
  }
}

describe("@wakeless/scheme", () => {
  it("scheme package imports no network module", (ctx) => {
    // The sources are always scanned.
    const sources = filesUnder(join(PKG, "src"), /\.ts$/);
    expect(sources.length).toBeGreaterThan(5);
    scan(sources);

    // The package's dependencies are the three pure libraries and nothing else.
    const pkg = JSON.parse(readFileSync(join(PKG, "package.json"), "utf8")) as {
      dependencies?: Record<string, string>;
      peerDependencies?: Record<string, string>;
    };
    expect(Object.keys(pkg.dependencies ?? {}).sort()).toEqual(["@noble/ed25519", "@noble/hashes", "bs58"]);
    expect(pkg.peerDependencies).toBeUndefined();
    for (const version of Object.values(pkg.dependencies ?? {})) {
      expect(version, version).toMatch(/^\d+\.\d+\.\d+$/);
    }

    // The built output, when present (`pnpm build`), is scanned too.
    const dist = join(PKG, "dist");
    if (!existsSync(dist)) {
      const reason = "dist/ absent; run pnpm build to scan the built output (sources scanned)";
      console.log(`partial: scheme package imports no network module: ${reason}`);
      ctx.skip(reason);
      return;
    }
    const built = filesUnder(dist, /\.js$/);
    expect(built.length).toBeGreaterThan(5);
    scan(built);
  });
});
