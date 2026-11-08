// `pnpm release:dry`'s checks: five tarballs, each holding only dist/, README.md and the
// manifest npm always adds; and no dependency of a publishable package given as a range,
// neither in the repo's package.json nor in the manifest pnpm writes into the tarball.
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import fc from "fast-check";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import {
  PUBLISHABLE,
  RELEASE_VERSION,
  buildPublishable,
  dryRunTarballs,
  isAllowedFile,
  isExactSpec,
  packTarballs,
  packageDir,
  packedManifest,
  parseDryRun,
  rangeViolations,
} from "../lib/release.js";

let outDir: string;
let tarballs: string[];

beforeAll(() => {
  buildPublishable();
  outDir = mkdtempSync(join(tmpdir(), "wakeless-release-"));
  tarballs = packTarballs(outDir);
}, 300_000);

afterAll(() => {
  if (outDir) rmSync(outDir, { recursive: true, force: true });
});

describe("release dry run", () => {
  it("release dry run produces five tarballs containing only dist and README", () => {
    const packed = dryRunTarballs(tarballs);
    expect(packed.map((p) => p.name)).toEqual(PUBLISHABLE.map((p) => `@wakeless/${p}`));
    for (const entry of packed) {
      expect(entry.version).toBe(RELEASE_VERSION);
      expect(entry.files.filter((f) => !isAllowedFile(f)), entry.name).toEqual([]);
      expect(entry.files).toContain("README.md");
      expect(entry.files).toContain("LICENSE");
      expect(entry.files).toContain("dist/index.js");
      expect(entry.files).toContain("dist/index.d.ts");
      expect(entry.files.some((f) => f.endsWith(".map") || f.startsWith("src/")), entry.name).toBe(false);
    }
    expect(packed.find((p) => p.name === "@wakeless/client")?.files).toContain("dist/cli.js");
  });

  it("the published manifests carry no development export, no prepublish guard, and the agreed fields", () => {
    for (const [i, pkg] of PUBLISHABLE.entries()) {
      const manifest = packedManifest(tarballs[i]!);
      expect(manifest.exports, pkg).toEqual({ ".": { types: "./dist/index.d.ts", import: "./dist/index.js" } });
      expect(manifest.files).toEqual(["dist", "README.md", "LICENSE"]);
      expect(manifest.sideEffects).toBe(false);
      expect(manifest.engines).toEqual({ node: ">=22.13.0" }); // the root's floor
      expect(manifest.type).toBe("module");
      expect((manifest.scripts as Record<string, string> | undefined)?.prepublishOnly).toBeUndefined();
      // devDependencies name @wakeless/facilitator, which is never published; the registry must not show them.
      expect(manifest.devDependencies, pkg).toBeUndefined();
    }
  });

  it("@wakeless/binding is a peer dependency of binding-magicblock and client, never a direct one", () => {
    for (const pkg of ["binding-magicblock", "client"] as const) {
      const manifest = packedManifest(tarballs[PUBLISHABLE.indexOf(pkg)]!) as { dependencies?: Record<string, string>; peerDependencies?: Record<string, string> };
      expect(manifest.peerDependencies?.["@wakeless/binding"], pkg).toBe(RELEASE_VERSION);
      expect(manifest.dependencies?.["@wakeless/binding"], pkg).toBeUndefined();
    }
  });

  it("no dependency range in any publishable package.json", () => {
    for (const [i, pkg] of PUBLISHABLE.entries()) {
      const source = JSON.parse(readFileSync(join(packageDir(pkg), "package.json"), "utf8")) as unknown;
      expect(rangeViolations(source, { allowWorkspace: true }), `packages/${pkg}/package.json`).toEqual([]);
      expect(rangeViolations(packedManifest(tarballs[i]!), { allowWorkspace: false }), `${pkg} tarball`).toEqual([]);
    }
  });

  it("every README states the status line and opens with a ts example", () => {
    for (const pkg of PUBLISHABLE) {
      const readme = readFileSync(join(packageDir(pkg), "README.md"), "utf8");
      expect(readme, pkg).toContain("Status: devnet alpha, unaudited");
      expect(readme, pkg).toMatch(/```ts\n/);
    }
  });
});

describe("version and file rules", () => {
  it("accepts exact versions and pinned workspace specifiers only", () => {
    for (const ok of ["1.2.3", "0.1.0-alpha.0", "8.6.0", "1.0.0-rc.1"]) expect(isExactSpec(ok, { allowWorkspace: false }), ok).toBe(true);
    for (const bad of ["^1.2.3", "~1.2.3", "*", "latest", ">=1.0.0", "1.x", "1.2", "workspace:*", "workspace:^", "file:../x", ""]) {
      expect(isExactSpec(bad, { allowWorkspace: false }), bad).toBe(false);
    }
    expect(isExactSpec("workspace:0.1.0-alpha.0", { allowWorkspace: true })).toBe(true);
    expect(isExactSpec("workspace:*", { allowWorkspace: true })).toBe(false);
    expect(rangeViolations({ dependencies: { a: "1.0.0" }, peerDependencies: { b: "^2.0.0" } }, { allowWorkspace: false })).toEqual(["peerDependencies.b@^2.0.0"]);
  });

  it("allows package.json, README.md and dist/ only", () => {
    expect(isAllowedFile("dist/index.js")).toBe(true);
    for (const bad of ["src/index.ts", "tsup.config.ts", "test/x.test.ts", "README", "distx/a.js", "LICENSE.txt"]) expect(isAllowedFile(bad), bad).toBe(false);
  });
});

describe("parseDryRun", () => {
  it("reads npm's JSON after any preamble", () => {
    const out = 'npm notice\n[{"name":"@wakeless/x","version":"1.0.0","filename":"x.tgz","files":[{"path":"README.md","size":1}]}]';
    expect(parseDryRun(out)).toEqual([{ name: "@wakeless/x", version: "1.0.0", filename: "x.tgz", files: ["README.md"] }]);
  });

  it("throws an Error, never anything else, on arbitrary output", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json(), fc.jsonValue().map((v) => JSON.stringify([v]))), (text) => {
        try {
          const parsed = parseDryRun(text);
          for (const entry of parsed) {
            expect(typeof entry.name).toBe("string");
            expect(entry.files.every((f) => typeof f === "string")).toBe(true);
          }
        } catch (error) {
          expect(error).toBeInstanceOf(Error);
        }
      }),
    );
  });
});
