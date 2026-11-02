// Generates the six devnet keypairs if missing (buyer, escrow, three vendors, the facilitator's
// receipt signer). Prints public keys only.
import { chmodSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import {
  assertNotMainnetKeyPath,
  generateKeypairJson,
  KEY_ROLES,
  publicKeyFromKeypairJson,
} from "./lib/keypairs.js";

const dir = resolve(process.env.KEYS_DIR ?? join(import.meta.dirname, "..", "keys"));
assertNotMainnetKeyPath(dir);
mkdirSync(dir, { recursive: true, mode: 0o700 });

for (const { name } of KEY_ROLES) {
  const path = join(dir, `${name}.json`);
  const created = !existsSync(path);
  if (created) {
    writeFileSync(path, generateKeypairJson(), { flag: "wx", mode: 0o600 });
    chmodSync(path, 0o600);
  }
  const publicKey = publicKeyFromKeypairJson(readFileSync(path, "utf8"));
  console.log(`${name.padEnd(8)} ${publicKey} ${created ? "created" : "exists"}`);
}
