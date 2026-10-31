import { defineConfig } from "vitest/config";
import { requireDotEnv } from "./scripts/lib/env.js";
import { baseExclude } from "./vitest.shared.js";

requireDotEnv(import.meta.dirname);

export default defineConfig({
  test: {
    include: ["**/*.devnet.test.ts"],
    exclude: baseExclude,
    passWithNoTests: true,
    testTimeout: 120_000,
  },
});
