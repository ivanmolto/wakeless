import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";

/** Replaces `$NAME` and `${NAME}` from `vars`; an unknown name becomes empty. */
export function expandEnvValue(value: string, vars: Record<string, string | undefined>): string {
  return value.replace(/\$(?:\{(\w+)\}|(\w+))/g, (_, braced?: string, bare?: string) => {
    return vars[(braced ?? bare) as string] ?? "";
  });
}

/**
 * Loads `<root>/.env` into process.env if the file exists. Variables already
 * set win. Expands `$VAR`, which node's parser leaves alone and SOLANA_RPC_URL needs.
 */
export function loadDotEnv(root: string): void {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, "utf8"));
  const vars = { ...parsed, ...process.env };
  for (const [name, value] of Object.entries(parsed)) {
    if (process.env[name] === undefined && value !== undefined) {
      process.env[name] = expandEnvValue(value, vars);
    }
  }
}

export function requireDotEnv(root: string): void {
  if (!existsSync(join(root, ".env"))) {
    throw new Error("This suite requires .env. Copy .env.example to .env and fill it in.");
  }
  loadDotEnv(root);
}
