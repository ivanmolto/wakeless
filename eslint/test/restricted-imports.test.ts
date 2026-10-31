import { join } from "node:path";
import { ESLint } from "eslint";
import { describe, expect, it } from "vitest";

const ROOT = join(import.meta.dirname, "..", "..");
const eslint = new ESLint({ cwd: ROOT });

async function restrictedImportHits(specifier: string, file: string): Promise<number> {
  const [result] = await eslint.lintText(`import "${specifier}";\n`, { filePath: join(ROOT, file) });
  return result!.messages.filter((m) => m.ruleId === "no-restricted-imports").length;
}

describe("no-restricted-imports", () => {
  it("direct MagicBlock import outside binding fails lint", async () => {
    expect(await restrictedImportHits("@magicblock-labs/x", "packages/facilitator/src/fixture.ts")).toBe(1);
    expect(await restrictedImportHits("@magicblock-labs/x", "packages/binding-magicblock/src/fixture.ts")).toBe(0);
  });

  it("covers helius and privacy cash, and every package outside the bindings", async () => {
    for (const specifier of ["@heliuslabs/x", "privacy-cash", "privacy-cash/sdk", "@privacy-cash/sdk", "privacycash"]) {
      expect(await restrictedImportHits(specifier, "packages/client/src/fixture.ts"), specifier).toBe(1);
      expect(await restrictedImportHits(specifier, "packages/binding-rings/src/fixture.ts"), specifier).toBe(0);
    }
    for (const file of ["packages/vendor/src/a.ts", "packages/binding/src/a.ts", "scripts/a.ts"]) {
      expect(await restrictedImportHits("@magicblock-labs/x", file), file).toBe(1);
    }
  });
});
