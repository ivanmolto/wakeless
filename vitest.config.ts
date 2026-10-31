import { defineConfig } from "vitest/config";
import { baseExclude } from "./vitest.shared.js";

// Unit: no network, runs in CI.
export default defineConfig({
  test: {
    include: ["**/*.test.ts"],
    exclude: [...baseExclude, "**/*.devnet.test.ts"],
  },
});
