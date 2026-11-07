// The one build of the five publishable packages (task 11.2): ESM only, Node 22,
// declarations bundled beside the code, no source maps (./src is not published).
import type { Options } from "tsup";

export function publishable(entry: readonly string[] = ["src/index.ts"]): Options {
  return {
    entry: [...entry],
    format: ["esm"],
    platform: "node",
    target: "node22",
    dts: true,
    clean: true,
    sourcemap: false,
    splitting: false,
    removeNodeProtocol: false,
  };
}
