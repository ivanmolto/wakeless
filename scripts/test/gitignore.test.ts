import { spawnSync } from "node:child_process";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");

function isIgnored(path: string): boolean {
  const { status } = spawnSync("git", ["check-ignore", "--no-index", "-q", path], { cwd: ROOT });
  return status === 0;
}

describe(".gitignore", () => {
  it("keeps secrets and third-party checkouts out", () => {
    for (const path of [".env", "keys/buyer.json", "keys/mainnet/buyer.json", "vendor/x402/README.md", "node_modules/a", "packages/client/dist/a.js"]) {
      expect(isIgnored(path), path).toBe(true);
    }
  });

  it("does not swallow packages/vendor, packages/vendors or the tracked docs", () => {
    for (const path of ["packages/vendor/package.json", "packages/vendor/src/terms/a.ts", "packages/vendors/package.json", ".env.example", "docs/VERSIONS.md", "docs/test/a.test.ts"]) {
      expect(isIgnored(path), path).toBe(false);
    }
  });
});
