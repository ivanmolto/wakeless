// Writes the facilitator's bearer tokens into .env: FACILITATOR_ADMIN_TOKEN (one secret) and
// FACILITATOR_RECEIPT_TOKENS (one secret per vendor, paired with the vendor's public key from
// keys/vendorN.json). Values already set are kept unless --rotate is given. Prints which
// variables were set, kept or rotated, never a secret.
//
//   pnpm tokens            # fill in what is missing
//   pnpm tokens --rotate   # new secrets for both, replacing the old ones
import { randomBytes } from "node:crypto";
import { chmodSync, existsSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { assertNotMainnetKeyPath, KEY_ROLES, publicKeyFromKeypairJson } from "./lib/keypairs.js";

const ROOT = resolve(import.meta.dirname, "..");
const keysDir = resolve(process.env.KEYS_DIR ?? join(ROOT, "keys"));
const envPath = resolve(process.env.ENV_FILE ?? join(ROOT, ".env"));
const rotate = process.argv.includes("--rotate");
assertNotMainnetKeyPath(keysDir);

const VARS = ["FACILITATOR_ADMIN_TOKEN", "FACILITATOR_RECEIPT_TOKENS"] as const;

function secret(): string {
  return randomBytes(24).toString("base64url");
}

function vendorAddresses(): string[] {
  return KEY_ROLES.filter(({ name }) => name.startsWith("vendor")).map(({ name }) => {
    const path = join(keysDir, `${name}.json`);
    if (!existsSync(path)) throw new Error(`${path} is missing; run pnpm keys first`);
    return publicKeyFromKeypairJson(readFileSync(path, "utf8"));
  });
}

/** `.env` as lines; a variable's line is replaced in place, or appended at the end. */
function upsert(lines: string[], name: string, value: string): string[] {
  const line = `${name}=${value}`;
  const index = lines.findIndex((l) => l.startsWith(`${name}=`));
  if (index === -1) return [...lines, line];
  return lines.map((l, i) => (i === index ? line : l));
}

function currentValue(lines: string[], name: string): string {
  const line = lines.find((l) => l.startsWith(`${name}=`));
  return line === undefined ? "" : line.slice(name.length + 1).trim();
}

function main(): void {
  if (!existsSync(envPath)) {
    const example = join(ROOT, ".env.example");
    if (!existsSync(example)) throw new Error(".env and .env.example are both missing");
    writeFileSync(envPath, readFileSync(example, "utf8"), { mode: 0o600 });
    console.log(".env      created from .env.example");
  }
  let lines = readFileSync(envPath, "utf8").split("\n");
  const trailingNewline = lines.at(-1) === "";
  if (trailingNewline) lines.pop();

  const values: Record<(typeof VARS)[number], () => string> = {
    FACILITATOR_ADMIN_TOKEN: secret,
    FACILITATOR_RECEIPT_TOKENS: () => vendorAddresses().map((address) => `${address}=${secret()}`).join(","),
  };
  for (const name of VARS) {
    const had = currentValue(lines, name) !== "";
    if (had && !rotate) {
      console.log(`${name.padEnd(27)} kept (--rotate replaces it)`);
      continue;
    }
    lines = upsert(lines, name, values[name]());
    console.log(`${name.padEnd(27)} ${had ? "rotated" : "set"}`);
  }
  writeFileSync(envPath, lines.join("\n") + "\n", { mode: 0o600 });
  chmodSync(envPath, 0o600); // `mode` applies only to a new file; .env holds secrets either way.
  console.log("Restart the facilitator to pick the new values up; a vendor's receipt reader needs its own entry from FACILITATOR_RECEIPT_TOKENS.");
}

main();
