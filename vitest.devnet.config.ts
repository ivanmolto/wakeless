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
    // Every devnet file reads and moves the same buyer, escrow and vendor private balances,
    // so two files in flight at once break each other's balance-delta assertions (Gate 3, 7 Nov 2026).
    fileParallelism: false,
  },
});
