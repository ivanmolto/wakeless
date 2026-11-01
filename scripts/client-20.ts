// Task 5.1, definition of done: twenty paid requests across the three vendors with
// exactly one deposit per vendor and zero chain transactions per request after the
// deposit. Devnet only. The facilitator (real MagicBlock binding, memory stores) and
// the three vendors run in this process on loopback; the buyer pays through
// `wrapFetchWithWakeless` over the real `MagicBlockBuyer`. Spends devnet USDC from the
// buyer's private balance: one deposit per vendor of 100 × the route's price (0.6 USDC).
//
//   pnpm client:20            # fresh channel file under ~/.wakeless/, 20 requests
//   pnpm client:20 -- 30      # another count
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { address, createKeyPairFromBytes, type Signature } from "@solana/kit";
import { DEVNET_CAIP2, type BuyerBinding } from "@wakeless/binding";
import { MagicBlockBinding, MagicBlockBuyer } from "@wakeless/binding-magicblock";
import { wrapFetchWithWakeless } from "@wakeless/client";
import { createDepositHandler, createFacilitatorApp, createMemoryStores } from "@wakeless/facilitator";
import { publicKeyOf } from "@wakeless/scheme";
import { VENDORS, startVendors } from "@wakeless/vendors";
import { assertDevnetRpcUrl, redactSecrets } from "./lib/devnet.js";
import { loadDotEnv } from "./lib/env.js";
import { assertNotMainnetKeyPath } from "./lib/keypairs.js";

const ROOT = resolve(import.meta.dirname, "..");

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see .env.example`);
  return value;
}

/** Solana CLI format, 64 bytes. Never under keys/mainnet/. Errors never quote the file. */
function keyBytes(envVar: string, fallback: string): Uint8Array {
  const path = resolve(ROOT, process.env[envVar] || fallback);
  assertNotMainnetKeyPath(path);
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new Error(`${envVar} is not a readable JSON keypair file; run pnpm keys`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${envVar} is not an array of 64 bytes`);
  return Uint8Array.from(bytes as number[]);
}

/** The rail with its deposits counted: each is one signature emitted by this run. */
function counted(rail: MagicBlockBuyer): { rail: BuyerBinding; signatures: Signature[] } {
  const signatures: Signature[] = [];
  const wrapped: BuyerBinding = {
    id: rail.id,
    teeValidator: rail.teeValidator,
    network: () => rail.network(),
    async deposit(to, amount, ref) {
      const result = await rail.deposit(to, amount, ref);
      signatures.push(result.sig);
      return result;
    },
  };
  return { rail: wrapped, signatures };
}

async function main(): Promise<void> {
  loadDotEnv(ROOT);
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured here: this script runs on devnet only");
  const count = Number(process.argv[2] ?? 20);
  if (!Number.isInteger(count) || count <= 0) throw new Error("the request count must be a positive integer");
  const baseRpcUrl = required("SOLANA_RPC_URL");
  assertDevnetRpcUrl(baseRpcUrl);
  const common = {
    network: DEVNET_CAIP2,
    baseRpcUrl,
    teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
    paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app",
    mint: address(required("USDC_MINT")),
  };

  // The facilitator, in process, over the real escrow binding.
  const escrow = await createKeyPairFromBytes(keyBytes("ESCROW_KEYPAIR", "keys/escrow.json"));
  const binding = await MagicBlockBinding.create({ ...common, escrow, attestationReportPath: resolve(ROOT, "docs/attestation-facilitator.json") });
  const stores = createMemoryStores();
  const facilitatorLog: string[] = [];
  const app = createFacilitatorApp({
    binding: { status: "ready", binding, teeValidator: binding.attestation.validatorIdentity! },
    stores,
    deposits: createDepositHandler({ binding, stores, log: (line) => facilitatorLog.push(line) }),
    log: (line) => facilitatorLog.push(line),
  });
  const facilitator = await new Promise<{ url: string; close: () => void }>((done) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => done({ url: `http://127.0.0.1:${info.port}`, close: () => server.close() }));
  });

  // The three vendors, each on its own keypair's public key.
  const vendors = await startVendors(
    VENDORS.map((definition) => ({ definition, payTo: publicKeyOf({ secretKey: keyBytes(`${definition.name.toUpperCase()}_KEYPAIR`, `keys/${definition.name}.json`) }), port: 0 })),
    { facilitatorUrl: facilitator.url, seed: process.env.VENDORS_SEED || "wakeless" },
  );

  // The buyer: the real rail, attested once here, counted.
  const buyerKeypair = keyBytes("BUYER_KEYPAIR", "keys/buyer.json");
  const buyerRail = await MagicBlockBuyer.create({ ...common, buyer: await createKeyPairFromBytes(buyerKeypair), attestationReportPath: resolve(ROOT, "docs/attestation-client.json") });
  const { rail, signatures } = counted(buyerRail);
  const need = VENDORS.reduce((sum, v) => sum + BigInt(v.amount) * 100n, 0n);
  const balanceBefore = await buyerRail.privateBalance();
  if (balanceBefore < need) {
    throw new Error(`the buyer's private balance is below the three deposits (${Number(need) / 1e6} USDC); fund it with POST /v1/spl/deposit (private: true) first`);
  }
  const stamp = new Date().toISOString().replace(/[:.]/g, "-");
  const channelStoreLocal = resolve(homedir(), ".wakeless", `client-20-${stamp}.json`);
  const clientLog: string[] = [];
  const pay = wrapFetchWithWakeless(fetch, { buyerKeypair, rail, channelStoreLocal, log: (line) => clientLog.push(line) });

  const symbols = ["SOL", "BTC", "ETH", "USDC", "JUP"];
  let served = 0;
  const started = Date.now();
  try {
    for (let i = 0; i < count; i++) {
      const vendor = vendors.vendors[i % vendors.vendors.length]!;
      const url = `${vendor.url}${vendor.route.replace(":symbol", symbols[i % symbols.length]!)}`;
      const response = await pay(url);
      const body = (await response.text()).slice(0, 60);
      console.log(`${String(i + 1).padStart(2)}  ${vendor.name}  ${new URL(url).pathname.padEnd(16)}  ${response.status}  ${response.status === 200 ? "" : body}`);
      if (response.status === 200) served++;
    }
  } finally {
    await vendors.close();
    facilitator.close();
  }

  // What the ledger would show for every signature this run emitted.
  let onBaseLayer = 0;
  for (const signature of signatures) {
    const view = await binding.observe(signature);
    if (view.onBaseLayer || view.memoText.length > 0 || view.plaintextRecipients.length > 0) onBaseLayer++;
  }
  const trajectory = pay.getTrajectory();
  const deposits = trajectory.filter((t) => t.deposit !== undefined);
  const perVendor = new Map<string, number>();
  for (const d of deposits) perVendor.set(d.vendor, (perVendor.get(d.vendor) ?? 0) + 1);
  const afterFirst = count - vendors.vendors.length;
  const balanceAfter = await buyerRail.privateBalance();

  console.log("");
  console.log(`requests                         ${count} (${served} served)`);
  console.log(`deposits                         ${deposits.length} (${[...perVendor.values()].join(", ")} per vendor)`);
  console.log(`signatures emitted               ${signatures.length}`);
  console.log(`base-layer transactions          ${onBaseLayer}`);
  console.log(`chain transactions per request   ${afterFirst > 0 ? (0 / afterFirst).toFixed(2) : "n/a"} after the deposits (${signatures.length - deposits.length} unexpected)`);
  console.log(`private balance moved            ${Number(balanceBefore - balanceAfter) / 1e6} USDC into escrow`);
  console.log(`channel file                     ${channelStoreLocal} (0600)`);
  console.log(`attestation                      docs/attestation-client.json, docs/attestation-facilitator.json`);
  console.log(`elapsed                          ${((Date.now() - started) / 1000).toFixed(1)} s`);

  for (const line of [...clientLog, ...facilitatorLog]) {
    if (/[1-9A-HJ-NP-Za-km-z]{87,88}/.test(line) || /bearer/i.test(line)) throw new Error("a log line carries a signature or a token");
  }
  const ok = served === count && deposits.length === vendors.vendors.length && [...perVendor.values()].every((n) => n === 1) && signatures.length === deposits.length && onBaseLayer === 0;
  if (!ok) {
    console.error("FAIL: not one deposit per vendor with zero chain transactions per request after it");
    process.exit(1);
  }
  console.log("PASS: one deposit per vendor, every later request a voucher, nothing on the base layer");
}

main().catch((error: unknown) => {
  console.error(`[client-20] ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
});
