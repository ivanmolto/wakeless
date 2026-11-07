import { fileURLToPath } from "node:url";
import { defineConfig } from "vite";

// The page reads docs/side-by-side.json, docs/leak/snapshot-*.json and brand/ from the
// repository root at build time; nothing is fetched at runtime.
const repoRoot = fileURLToPath(new URL("../../..", import.meta.url));

export default defineConfig({
  root: fileURLToPath(new URL(".", import.meta.url)),
  base: "./",
  server: { fs: { allow: [repoRoot] } },
  build: { outDir: "dist", emptyOutDir: true },
});
