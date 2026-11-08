// The five publishable packages and the checks `pnpm release:dry` and its tests share.
// Tarballs are made by `pnpm pack`, which writes the manifest that gets published
// (`workspace:` specifiers pinned, `publishConfig.exports` applied); `npm pack --dry-run`
// on each tarball then lists exactly what `npm publish <tarball>` would upload.
import { execFileSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";

export const RELEASE_VERSION = "0.1.0-alpha.0";
export const PUBLISHABLE = ["scheme", "binding", "binding-magicblock", "client", "vendor"] as const;
export type Publishable = (typeof PUBLISHABLE)[number];

export const REPO_ROOT = resolve(import.meta.dirname, "../..");

export const packageDir = (pkg: Publishable, root: string = REPO_ROOT): string => join(root, "packages", pkg);
export const tarballName = (pkg: Publishable, version: string = RELEASE_VERSION): string => `wakeless-${pkg}-${version}.tgz`;

const DEPENDENCY_FIELDS = ["dependencies", "peerDependencies", "optionalDependencies", "devDependencies"] as const;
const EXACT = /^\d+\.\d+\.\d+(?:-[0-9A-Za-z-]+(?:\.[0-9A-Za-z-]+)*)?$/;

/** An exact semver, or a `workspace:` specifier naming one (pnpm pins it on pack). */
export function isExactSpec(spec: unknown, { allowWorkspace }: { allowWorkspace: boolean }): boolean {
  if (typeof spec !== "string") return false;
  if (allowWorkspace && spec.startsWith("workspace:")) return EXACT.test(spec.slice("workspace:".length));
  return EXACT.test(spec);
}

/** `field.name@spec` for every dependency whose version is not exact. */
export function rangeViolations(manifest: unknown, options: { allowWorkspace: boolean }): string[] {
  const out: string[] = [];
  if (typeof manifest !== "object" || manifest === null) return ["manifest is not an object"];
  for (const field of DEPENDENCY_FIELDS) {
    const deps = (manifest as Record<string, unknown>)[field];
    if (deps === undefined) continue;
    if (typeof deps !== "object" || deps === null) {
      out.push(`${field} is not an object`);
      continue;
    }
    for (const [name, spec] of Object.entries(deps)) {
      if (!isExactSpec(spec, options)) out.push(`${field}.${name}@${String(spec)}`);
    }
  }
  return out;
}

/** Files a tarball may hold: `npm` always adds package.json and LICENSE; `files` allows dist and README. */
export function isAllowedFile(path: string): boolean {
  return path === "package.json" || path === "README.md" || path === "LICENSE" || path.startsWith("dist/");
}

export interface PackedTarball {
  readonly name: string;
  readonly version: string;
  readonly filename: string;
  readonly files: readonly string[];
}

/**
 * Parses `npm pack --dry-run --json` output. Throws on anything that is not an array of
 * `{ name, version, filename, files: [{ path }] }`; never returns a partial entry.
 */
export function parseDryRun(stdout: string): PackedTarball[] {
  const start = stdout.indexOf("[");
  if (start < 0) throw new Error("npm pack --dry-run printed no JSON array");
  let parsed: unknown;
  try {
    parsed = JSON.parse(stdout.slice(start));
  } catch {
    throw new Error("npm pack --dry-run printed malformed JSON");
  }
  if (!Array.isArray(parsed)) throw new Error("npm pack --dry-run JSON is not an array");
  return parsed.map((entry: unknown, i) => {
    const e = entry as Record<string, unknown> | null;
    if (typeof e !== "object" || e === null) throw new Error(`entry ${i} is not an object`);
    const { name, version, filename, files } = e;
    if (typeof name !== "string" || typeof version !== "string" || typeof filename !== "string" || !Array.isArray(files)) {
      throw new Error(`entry ${i} lacks name, version, filename or files`);
    }
    const paths = files.map((f: unknown) => {
      const path = (f as { path?: unknown } | null)?.path;
      if (typeof path !== "string") throw new Error(`entry ${i} has a file without a path`);
      return path;
    });
    return { name, version, filename, files: paths };
  });
}

/**
 * Removes `devDependencies` from the manifest inside a tarball. Consumers never install
 * them, but the registry shows them, and ours name `@wakeless/facilitator`, which is not
 * published. pnpm has no switch for this, so the tarball is unpacked, edited and repacked.
 */
export function stripDevDependencies(tarball: string): void {
  const work = mkdtempSync(join(tmpdir(), "wakeless-strip-"));
  try {
    execFileSync("tar", ["-xzf", tarball, "-C", work], { stdio: "pipe" });
    const manifestPath = join(work, "package", "package.json");
    const manifest = JSON.parse(readFileSync(manifestPath, "utf8")) as Record<string, unknown>;
    delete manifest.devDependencies;
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    // Files only, sorted, from an explicit list: no directory entries, and COPYFILE_DISABLE
    // keeps macOS tar from adding AppleDouble `._*` entries.
    const files = execFileSync("find", ["package", "-type", "f"], { cwd: work, encoding: "utf8" }).split("\n").filter(Boolean).sort();
    execFileSync("tar", ["-czf", tarball, "-C", work, "-T", "-"], { input: `${files.join("\n")}\n`, stdio: ["pipe", "pipe", "pipe"], env: { ...process.env, COPYFILE_DISABLE: "1" } });
  } finally {
    rmSync(work, { recursive: true, force: true });
  }
}

/** `pnpm pack` each package into `outDir`, devDependencies stripped; tarball paths in PUBLISHABLE order. */
export function packTarballs(outDir: string, root: string = REPO_ROOT): string[] {
  mkdirSync(outDir, { recursive: true });
  return PUBLISHABLE.map((pkg) => {
    execFileSync("pnpm", ["pack", "--pack-destination", outDir], { cwd: packageDir(pkg, root), stdio: "pipe" });
    const path = join(outDir, tarballName(pkg));
    if (!existsSync(path)) throw new Error(`pnpm pack wrote no ${tarballName(pkg)}`);
    stripDevDependencies(path);
    return path;
  });
}

/** `npm pack --dry-run --json` over the tarballs: what `npm publish <tarball>` would upload. */
export function dryRunTarballs(tarballs: readonly string[], cwd: string = REPO_ROOT): PackedTarball[] {
  const stdout = execFileSync("npm", ["pack", "--dry-run", "--json", ...tarballs], { cwd, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] });
  return parseDryRun(stdout);
}

/** The manifest inside a tarball, as the registry would receive it. */
export function packedManifest(tarball: string): Record<string, unknown> {
  return JSON.parse(execFileSync("tar", ["-xOzf", tarball, "package/package.json"], { encoding: "utf8" })) as Record<string, unknown>;
}

/**
 * Builds the five with tsup, always: a few seconds, and no staleness heuristic to be
 * wrong about. Two test workers may build at once; tsup's `clean: true` and identical
 * output make that safe.
 */
export function buildPublishable(root: string = REPO_ROOT): void {
  const filters = PUBLISHABLE.flatMap((pkg) => ["--filter", `@wakeless/${pkg}`]);
  execFileSync("pnpm", [...filters, "build"], { cwd: root, stdio: "pipe" });
}
