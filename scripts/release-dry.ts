// `pnpm release:dry` (after `pnpm -r build`): packs the five publishable packages into
// .release/ with pnpm, runs `npm pack --dry-run` on each tarball, prints the file lists,
// and fails when a tarball holds anything but package.json, LICENSE, README.md and dist/, or when
// a published manifest carries a version that is not exact. Publishes nothing.
import { rmSync } from "node:fs";
import { join, relative } from "node:path";
import { PUBLISHABLE, REPO_ROOT, dryRunTarballs, isAllowedFile, packTarballs, packedManifest, rangeViolations } from "./lib/release.js";

const outDir = join(REPO_ROOT, ".release");
rmSync(outDir, { recursive: true, force: true });

const tarballs = packTarballs(outDir);
const packed = dryRunTarballs(tarballs);
const problems: string[] = [];

for (const [i, entry] of packed.entries()) {
  const tarball = tarballs[i]!;
  console.log(`\n${entry.name}@${entry.version}  ${relative(REPO_ROOT, tarball)}`);
  for (const file of entry.files) console.log(`  ${file}`);
  for (const file of entry.files.filter((f) => !isAllowedFile(f))) problems.push(`${entry.name}: ${file} is neither dist nor README`);
  if (!entry.files.includes("README.md")) problems.push(`${entry.name}: no README.md`);
  if (!entry.files.some((f) => f.startsWith("dist/"))) problems.push(`${entry.name}: no dist/`);
  const manifest = packedManifest(tarball);
  for (const v of rangeViolations(manifest, { allowWorkspace: false })) problems.push(`${entry.name}: ${v} is not an exact version`);
  if (manifest.devDependencies !== undefined) problems.push(`${entry.name}: devDependencies left in the published manifest`);
}

console.log(`\n${packed.length} tarballs in ${relative(REPO_ROOT, outDir)}/`);
if (packed.length !== PUBLISHABLE.length) problems.push(`expected ${PUBLISHABLE.length} tarballs, npm listed ${packed.length}`);
if (problems.length > 0) {
  for (const p of problems) console.error(`FAIL ${p}`);
  process.exit(1);
}
// npm refuses a prerelease version without --tag; `alpha` keeps it off `latest`.
console.log("Nothing was published. To publish, after checking the scope, in dependency order:");
for (const tarball of tarballs) console.log(`  npm publish --access public --tag alpha ${relative(REPO_ROOT, tarball)}`);
console.log("or, in one sitting and resumable after a failure:  pnpm release:publish");
