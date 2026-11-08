// `pnpm release:publish`: publishes the five tarballs in .release/ in dependency order
// (scheme, binding, binding-magicblock, client, vendor), in one sitting, so a consumer never
// finds @wakeless/client on the registry without the @wakeless/binding it needs. A version
// already on the registry is skipped, so a run that failed halfway resumes where it stopped.
// Run by a human after `pnpm release:dry`; the agent never runs it.
import { execFileSync } from "node:child_process";
import { existsSync } from "node:fs";
import { join, relative } from "node:path";
import { PUBLISHABLE, RELEASE_VERSION, REPO_ROOT, packedManifest, tarballName } from "./lib/release.js";

const outDir = join(REPO_ROOT, ".release");
const tarballs = PUBLISHABLE.map((pkg) => join(outDir, tarballName(pkg)));

const missing = tarballs.filter((t) => !existsSync(t));
if (missing.length > 0) {
  console.error(`FAIL no tarball at ${missing.map((m) => relative(REPO_ROOT, m)).join(", ")}; run pnpm release:dry first`);
  process.exit(1);
}
for (const [i, tarball] of tarballs.entries()) {
  const manifest = packedManifest(tarball);
  if (manifest.name !== `@wakeless/${PUBLISHABLE[i]}` || manifest.version !== RELEASE_VERSION) {
    console.error(`FAIL ${relative(REPO_ROOT, tarball)} holds ${String(manifest.name)}@${String(manifest.version)}, expected @wakeless/${PUBLISHABLE[i]}@${RELEASE_VERSION}`);
    process.exit(1);
  }
}

let user: string;
try {
  user = execFileSync("npm", ["whoami"], { encoding: "utf8", stdio: ["ignore", "pipe", "pipe"] }).trim();
} catch {
  console.error("FAIL not logged in to npm; run npm login");
  process.exit(1);
}
console.log(`publishing as ${user} to the @wakeless scope, tag alpha`);

/** Whether `name@version` is already on the registry. */
function published(name: string, version: string): boolean {
  try {
    const out = execFileSync("npm", ["view", `${name}@${version}`, "version"], { encoding: "utf8", stdio: ["ignore", "pipe", "ignore"] }).trim();
    return out === version;
  } catch {
    return false;
  }
}

for (const [i, tarball] of tarballs.entries()) {
  const name = `@wakeless/${PUBLISHABLE[i]}`;
  if (published(name, RELEASE_VERSION)) {
    console.log(`skip  ${name}@${RELEASE_VERSION} is already on the registry`);
    continue;
  }
  console.log(`publish ${relative(REPO_ROOT, tarball)}`);
  try {
    // --tag alpha: npm refuses a prerelease without a tag, and `alpha` keeps it off `latest`.
    execFileSync("npm", ["publish", "--access", "public", "--tag", "alpha", tarball], { cwd: REPO_ROOT, stdio: "inherit" });
  } catch {
    const left = PUBLISHABLE.slice(i).map((p) => `@wakeless/${p}`);
    console.error(`\nFAIL ${name} did not publish. Not yet on the registry: ${left.join(", ")}.`);
    console.error("Consumers of the packages already published may fail to install until this is rerun: pnpm release:publish");
    process.exit(1);
  }
}
console.log(`\nall five @wakeless packages at ${RELEASE_VERSION} are on the registry under the alpha tag`);
