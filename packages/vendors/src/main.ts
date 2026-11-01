// `pnpm vendors`: the three vendors, concurrently, on 127.0.0.1. Devnet only. Each vendor's
// keypair gives its `payTo`; only the public key is kept, and nothing here signs anything.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { publicKeyOf } from "@wakeless/scheme";
import { VENDORS, startVendors } from "./servers.js";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** Solana CLI format, 64 bytes. Never under keys/mainnet/. Errors never quote the file. */
function loadPublicKey(name: string, path: string): string {
  if (/(^|[\\/])keys[\\/]mainnet([\\/]|$)/.test(path)) throw new Error(`Refusing a key under keys/mainnet/ for ${name}: the vendors run on devnet only`);
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
  } catch {
    throw new Error(`${name}: ${path} is not a readable JSON keypair file; run pnpm keys`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${name}: ${path} is not an array of 64 bytes`);
  return publicKeyOf({ secretKey: Uint8Array.from(bytes as number[]) });
}

function portOf(name: string, fallback: number): number {
  const raw = process.env[`${name.toUpperCase()}_PORT`];
  if (!raw) return fallback;
  const port = Number(raw);
  if (!Number.isInteger(port) || port <= 0 || port > 65_535) throw new Error(`${name.toUpperCase()}_PORT must be a port number`);
  return port;
}

async function main(): Promise<void> {
  const envFile = resolve(ROOT, ".env");
  if (existsSync(envFile)) process.loadEnvFile(envFile);
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured by the vendors: they run on devnet only");

  const facilitatorUrl = process.env.FACILITATOR_URL || "http://127.0.0.1:4020";
  const running = await startVendors(
    VENDORS.map((definition) => ({
      definition,
      payTo: loadPublicKey(definition.name, process.env[`${definition.name.toUpperCase()}_KEYPAIR`] || `keys/${definition.name}.json`),
      port: portOf(definition.name, definition.defaultPort),
    })),
    { facilitatorUrl, seed: process.env.VENDORS_SEED || "wakeless" },
  );
  for (const vendor of running.vendors) {
    console.log(`[${vendor.name}] GET ${vendor.url}${vendor.route} payTo ${vendor.payTo}`);
  }
  console.log(`[vendors] facilitator ${facilitatorUrl}`);

  const stop = () => void running.close().finally(() => process.exit(0));
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(`[vendors] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
