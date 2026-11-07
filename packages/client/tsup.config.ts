import { defineConfig } from "tsup";
import { publishable } from "../../tsup.base.js";

// cli.ts keeps its `#!/usr/bin/env node` line; it is the `wakeless` bin.
export default defineConfig(publishable(["src/index.ts", "src/cli.ts"]));
