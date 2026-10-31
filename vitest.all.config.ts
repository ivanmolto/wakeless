import { defineConfig } from "vitest/config";
import { requireDotEnv } from "./scripts/lib/env.js";
import { baseExclude } from "./vitest.shared.js";

requireDotEnv(import.meta.dirname);

export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: baseExclude,
    testTimeout: 120_000,
  },
});
