// `pnpm vendor:receipts --vendor 1` (task 7.3): vendor N's own receipt report. Logs in to
// the attested TEE RPC and the Payments API with keys/vendorN.json, reads its private
// balance and any reference ids the rail exposes, fetches and verifies the facilitator's
// receipts for each of its channels, asks the rail whether each transfer landed, and
// cross-checks against GET /admin/channels. Exits 1 on any mismatch or unverified receipt.
// Devnet only. Never prints a token or a key; transfer signatures are shortened unless
// --full-signatures is given (to look one up on the TEE RPC).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { address, createKeyPairFromBytes } from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { MagicBlockPayee } from "@wakeless/binding-magicblock";
import { formatReport, isClean, readVendorReceipts, receiptTokenFor, scrub } from "@wakeless/vendors";
import { assertDevnetRpcUrl, redactSecrets } from "./lib/devnet.js";
import { loadDotEnv } from "./lib/env.js";
import { assertNotMainnetKeyPath } from "./lib/keypairs.js";

const ROOT = resolve(import.meta.dirname, "..");

/** `--vendor 1`, `--vendor=2` or `--vendor vendor3`. */
function vendorArg(argv: readonly string[]): 1 | 2 | 3 {
  const i = argv.findIndex((a) => a === "--vendor" || a.startsWith("--vendor="));
  const raw = i === -1 ? undefined : argv[i]!.includes("=") ? argv[i]!.split("=")[1] : argv[i + 1];
  const n = Number((raw ?? "").replace(/^vendor/, ""));
  if (n !== 1 && n !== 2 && n !== 3) throw new Error("usage: pnpm vendor:receipts --vendor <1|2|3>");
  return n;
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set in .env`);
  return value;
}

async function main(): Promise<void> {
  const n = vendorArg(process.argv.slice(2));
  loadDotEnv(ROOT);
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured by the receipt reader: it runs on devnet only");
  const baseRpcUrl = required("SOLANA_RPC_URL");
  assertDevnetRpcUrl(baseRpcUrl);

  const keyPath = resolve(ROOT, process.env[`VENDOR${n}_KEYPAIR`] || `keys/vendor${n}.json`);
  assertNotMainnetKeyPath(keyPath);
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(keyPath, "utf8"));
  } catch {
    throw new Error(`VENDOR${n}_KEYPAIR is not a readable JSON keypair file; run pnpm keys`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`VENDOR${n}_KEYPAIR is not an array of 64 bytes`);

  const payee = await MagicBlockPayee.create({
    network: DEVNET_CAIP2,
    baseRpcUrl,
    teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
    paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app",
    mint: address(required("USDC_MINT")),
    payee: await createKeyPairFromBytes(Uint8Array.from(bytes as number[])),
    attestationReportPath: resolve(ROOT, "docs/attestation-vendor.json"),
  });
  const adminToken = required("FACILITATOR_ADMIN_TOKEN");
  const receiptToken = receiptTokenFor(payee.address(), process.env.FACILITATOR_RECEIPT_TOKENS);
  const report = await readVendorReceipts({ payee, facilitatorUrl: process.env.FACILITATOR_URL || "http://127.0.0.1:4020", adminToken, receiptToken });
  console.log(formatReport(report, `vendor${n}`, [adminToken, receiptToken], { fullSignatures: process.argv.includes("--full-signatures") }));
  if (!isClean(report)) process.exitCode = 1;
}

main().catch((error: unknown) => {
  const message = error instanceof Error ? error.message : String(error);
  const secrets = [process.env.FACILITATOR_ADMIN_TOKEN ?? "", ...(process.env.FACILITATOR_RECEIPT_TOKENS ?? "").split(",").map((e) => e.slice(e.indexOf("=") + 1).trim())];
  console.error(`[vendor:receipts] ${scrub(redactSecrets(message), secrets)}`);
  process.exit(1);
});
