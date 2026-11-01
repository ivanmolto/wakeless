// The setup `pnpm client:20` and `pnpm e2e` share. Devnet only. The facilitator (real
// MagicBlock binding, memory stores) and the three vendors run in this process on
// loopback; the buyer pays through `wrapFetchWithWakeless` over the real `MagicBlockBuyer`.
// Every signature either side's binding returns is counted. Each run gets a fresh channel
// file, so it opens one deposit per vendor at 100 × the route's price (0.6 USDC in all)
// from the buyer's private balance.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { address, createKeyPairFromBytes, type Signature } from "@solana/kit";
import { DEVNET_CAIP2, type BuyerBinding, type ObserverView, type SettlementBinding } from "@wakeless/binding";
import { MagicBlockBinding, MagicBlockBuyer } from "@wakeless/binding-magicblock";
import { wrapFetchWithWakeless } from "@wakeless/client";
import { createDepositHandler, createFacilitatorApp, createMemoryStores } from "@wakeless/facilitator";
import { publicKeyOf } from "@wakeless/scheme";
import { VENDORS, startVendors, type RunningVendors } from "@wakeless/vendors";
import { assertDevnetRpcUrl } from "./devnet.js";
import { loadDotEnv } from "./env.js";
import { assertNotMainnetKeyPath } from "./keypairs.js";

const ROOT = resolve(import.meta.dirname, "../..");

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

/** The buyer's rail with its deposits counted. */
function countedBuyer(rail: BuyerBinding, signatures: Signature[]): BuyerBinding {
  return {
    id: rail.id,
    ...(rail.teeValidator === undefined ? {} : { teeValidator: rail.teeValidator }),
    network: () => rail.network(),
    async deposit(to, amount, ref) {
      const result = await rail.deposit(to, amount, ref);
      signatures.push(result.sig);
      return result;
    },
  };
}

/** The escrow's binding with its transfers counted, so redemptions land in the metric when the facilitator makes them. */
function countedEscrow(binding: SettlementBinding, signatures: Signature[]): SettlementBinding {
  return {
    id: binding.id,
    network: () => binding.network(),
    escrowAddress: () => binding.escrowAddress(),
    readDeposit: (sig, ref) => binding.readDeposit(sig, ref),
    privateBalance: () => binding.privateBalance(),
    observe: (sig) => binding.observe(sig),
    async settle(to, amount, ref) {
      const result = await binding.settle(to, amount, ref);
      signatures.push(result.sig);
      return result;
    },
    async refund(to, amount, ref) {
      const result = await binding.refund(to, amount, ref);
      signatures.push(result.sig);
      return result;
    },
  };
}

/** What the public ledger shows of this signature: anything at all counts as visible. */
export function isVisibleOnBaseLayer(view: ObserverView): boolean {
  return view.onBaseLayer || view.memoText.length > 0 || view.plaintextRecipients.length > 0;
}

export interface InProcessRun {
  readonly vendors: RunningVendors;
  readonly pay: ReturnType<typeof wrapFetchWithWakeless>;
  /** Grows as the run emits: every deposit, settle and refund, in order. */
  readonly signatures: readonly Signature[];
  readonly channelStoreLocal: string;
  readonly balanceBefore: bigint;
  privateBalance(): Promise<bigint>;
  /** How many of the signatures so far the public ledger shows. */
  countVisibleOnBaseLayer(): Promise<number>;
  /** Throws if a log line carries a signature or a bearer token. */
  assertLogsClean(): void;
  close(): Promise<void>;
}

export async function startInProcessRun(label: string): Promise<InProcessRun> {
  loadDotEnv(ROOT);
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured here: this script runs on devnet only");
  const baseRpcUrl = required("SOLANA_RPC_URL");
  assertDevnetRpcUrl(baseRpcUrl);
  const common = {
    network: DEVNET_CAIP2,
    baseRpcUrl,
    teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
    paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app",
    mint: address(required("USDC_MINT")),
  };
  const signatures: Signature[] = [];

  // The facilitator, in process, over the real escrow binding.
  const escrow = await createKeyPairFromBytes(keyBytes("ESCROW_KEYPAIR", "keys/escrow.json"));
  const realBinding = await MagicBlockBinding.create({ ...common, escrow, attestationReportPath: resolve(ROOT, "docs/attestation-facilitator.json") });
  const binding = countedEscrow(realBinding, signatures);
  const stores = createMemoryStores();
  const facilitatorLog: string[] = [];
  const app = createFacilitatorApp({
    binding: { status: "ready", binding, teeValidator: realBinding.attestation.validatorIdentity! },
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

  const close = async (): Promise<void> => {
    await vendors.close();
    facilitator.close();
  };

  try {
    // The buyer: the real rail, attested once here, counted.
    const buyerKeypair = keyBytes("BUYER_KEYPAIR", "keys/buyer.json");
    const buyerRail = await MagicBlockBuyer.create({ ...common, buyer: await createKeyPairFromBytes(buyerKeypair), attestationReportPath: resolve(ROOT, "docs/attestation-client.json") });
    const need = VENDORS.reduce((sum, v) => sum + BigInt(v.amount) * 100n, 0n);
    const balanceBefore = await buyerRail.privateBalance();
    if (balanceBefore < need) {
      throw new Error(`the buyer's private balance is below the three deposits (${Number(need) / 1e6} USDC); fund it with POST /v1/spl/deposit (private: true) first`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const channelStoreLocal = resolve(homedir(), ".wakeless", `${label}-${stamp}.json`);
    const clientLog: string[] = [];
    const pay = wrapFetchWithWakeless(fetch, { buyerKeypair, rail: countedBuyer(buyerRail, signatures), channelStoreLocal, log: (line) => clientLog.push(line) });

    return {
      vendors,
      pay,
      signatures,
      channelStoreLocal,
      balanceBefore,
      privateBalance: () => buyerRail.privateBalance(),
      async countVisibleOnBaseLayer() {
        let visible = 0;
        for (const signature of signatures) {
          if (isVisibleOnBaseLayer(await realBinding.observe(signature))) visible++;
        }
        return visible;
      },
      assertLogsClean() {
        for (const line of [...clientLog, ...facilitatorLog]) {
          if (/[1-9A-HJ-NP-Za-km-z]{87,88}/.test(line) || /bearer/i.test(line)) throw new Error("a log line carries a signature or a token");
        }
      },
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
