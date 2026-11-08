// `pnpm vendors`: the three vendors, concurrently, on 127.0.0.1. Devnet only. Each vendor's
// keypair gives its `payTo`; only the public key is kept, and nothing here signs anything,
// except with `RELATIONSHIP_TERMS=true` (task 12.1T), when each vendor keeps its key to sign
// its terms receipts and its private buyer history in ~/.wakeless/terms-<vendor>.json.
import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { publicKeyOf } from "@wakeless/scheme";
import { FileTermsHistory, termsIfEnabled, type TermsOptions } from "@wakeless/vendor";
import { VENDORS, startVendors } from "./servers.js";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** Solana CLI format, 64 bytes. Never under keys/mainnet/. Errors never quote the file. */
function loadKeyBytes(name: string, path: string): Uint8Array {
  if (/(^|[\\/])keys[\\/]mainnet([\\/]|$)/.test(path)) throw new Error(`Refusing a key under keys/mainnet/ for ${name}: the vendors run on devnet only`);
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
  } catch {
    throw new Error(`${name}: ${path} is not a readable JSON keypair file; run pnpm keys`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${name}: ${path} is not an array of 64 bytes`);
  return Uint8Array.from(bytes as number[]);
}

function portOf(name: string, fallback: number): number {
  const raw = process.env[`${name.toUpperCase()}_PORT`];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${name.toUpperCase()}_PORT must be a port number`);
  return port;
}

/** Where a vendor's private buyer history lives: its own file, never shared between vendors. */
export function termsHistoryPath(name: string): string {
  return resolve(process.env.TERMS_HISTORY_DIR || resolve(homedir(), ".wakeless"), `terms-${name}.json`);
}

async function main(): Promise<void> {
  const envFile = resolve(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured by the vendors: they run on devnet only");

  const facilitatorUrl = process.env.FACILITATOR_URL || "http://127.0.0.1:4020";
  const running = await startVendors(
    VENDORS.map((definition) => {
      const keyBytes = loadKeyBytes(definition.name, process.env[`${definition.name.toUpperCase()}_KEYPAIR`] || `keys/${definition.name}.json`);
      const terms: TermsOptions | undefined = termsIfEnabled(process.env, () => ({ signer: { secretKey: keyBytes }, history: new FileTermsHistory(termsHistoryPath(definition.name)) }));
      return { definition, payTo: publicKeyOf({ secretKey: keyBytes }), port: portOf(definition.name, definition.defaultPort), ...(terms === undefined ? {} : { terms }) };
    }),
    { facilitatorUrl, seed: process.env.VENDORS_SEED || "wakeless" },
  );
  for (const vendor of running.vendors) {
    console.log(`[${vendor.name}] GET ${vendor.url}${vendor.route} payTo ${vendor.payTo}`);
  }
  console.log(`[vendors] facilitator ${facilitatorUrl}`);
  if (process.env.RELATIONSHIP_TERMS === "true") console.log(`[vendors] relationship terms on; each vendor's buyer history in ${termsHistoryPath("<vendor>")}`);

  const stop = () => void running.close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(`[vendors] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
