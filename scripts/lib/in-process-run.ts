// The setup `pnpm client:20` and `pnpm e2e` share. Devnet only. The facilitator (real
// MagicBlock binding, memory stores) and the three vendors run in this process on
// loopback; the buyer pays through `wrapFetchWithWakeless` over the real `MagicBlockBuyer`.
// Every signature either side's binding returns is counted. Each run gets a fresh channel
// file, so it opens one deposit per vendor at 100 × the route's price (0.6 USDC in all)
// from the buyer's private balance.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { address, createKeyPairFromBytes, type Signature } from "@solana/kit";
import { DEVNET_CAIP2, type BuyerBinding, type ObserverView, type SettlementBinding } from "@wakeless/binding";
import { MagicBlockBinding, MagicBlockBuyer } from "@wakeless/binding-magicblock";
import { wrapFetchWithWakeless } from "@wakeless/client";
import { createDepositHandler, createFacilitatorApp, createMemoryStores, createRedeemer, type CloseRunSummary, type RedeemRunSummary, type Stores } from "@wakeless/facilitator";
import { publicKeyOf } from "@wakeless/scheme";
import type { TermsOptions } from "@wakeless/vendor";
import { VENDORS, startVendors, type RunningVendors, type VendorDefinition } from "@wakeless/vendors";
import { createDevnetReader, observe, type ObserverReport, type SignatureInput } from "@wakeless/watcher";
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

/** Every signature a run emits, with who made it, for the watcher's four checks. */
type Emitted = (entry: SignatureInput) => void;

/** The buyer's rail with its deposits counted. */
function countedBuyer(rail: BuyerBinding, emitted: Emitted): BuyerBinding {
  return {
    id: rail.id,
    ...(rail.teeValidator === undefined ? {} : { teeValidator: rail.teeValidator }),
    network: () => rail.network(),
    async deposit(to, amount, ref) {
      const result = await rail.deposit(to, amount, ref);
      emitted({ signature: result.sig, label: "channel deposit (private transfer)", party: "buyer" });
      return result;
    },
  };
}

/** The escrow's binding with its transfers counted, so redemptions land in the metric when the facilitator makes them. */
function countedEscrow(binding: SettlementBinding, emitted: Emitted): SettlementBinding {
  return {
    id: binding.id,
    network: () => binding.network(),
    escrowAddress: () => binding.escrowAddress(),
    readDeposit: (sig, ref) => binding.readDeposit(sig, ref),
    privateBalance: () => binding.privateBalance(),
    transferStatus: (sig) => binding.transferStatus(sig),
    observe: (sig) => binding.observe(sig),
    async settle(to, amount, ref) {
      const result = await binding.settle(to, amount, ref);
      emitted({ signature: result.sig, label: "settlement (private transfer)", party: "escrow" });
      return result;
    },
    async refund(to, amount, ref) {
      const result = await binding.refund(to, amount, ref);
      emitted({ signature: result.sig, label: "refund (private transfer)", party: "escrow" });
      return result;
    },
  };
}

/** What the public ledger shows of this signature: anything at all counts as visible. */
export function isVisibleOnBaseLayer(view: ObserverView): boolean {
  return view.onBaseLayer || view.memoText.length > 0 || view.plaintextRecipients.length > 0;
}

/** Another buyer in the same run (task 12.1T's fresh buyer): its own key, rail login and channel file. */
export interface ExtraBuyerSpec {
  readonly name: string;
  readonly keyBytes: Uint8Array;
}

export interface ExtraBuyer {
  readonly name: string;
  readonly address: string;
  readonly pay: ReturnType<typeof wrapFetchWithWakeless>;
  readonly balanceBefore: bigint;
  privateBalance(): Promise<bigint>;
}

export interface InProcessRunOptions {
  /** Each vendor's relationship-terms layer, when the flag is on (task 12.1T). Default: none, the vendors as `pnpm e2e` runs them. */
  readonly vendorTerms?: (name: VendorDefinition["name"], payTo: string) => TermsOptions | undefined;
  /** The private balance every buyer must hold before anything is spent. Default: the three channel deposits at 100 × price. */
  readonly minPrivateBalance?: bigint;
  readonly extraBuyers?: readonly ExtraBuyerSpec[];
  /**
   * Sees every response a buyer's fetch gets, by buyer name (`"buyer"` for the primary), for
   * recording 402 headers. Headers only: the body belongs to the client, and reading or cloning
   * it here stalls the payment.
   */
  readonly onResponse?: (buyer: string, response: Response) => void;
}

export interface InProcessRun {
  readonly vendors: RunningVendors;
  readonly pay: ReturnType<typeof wrapFetchWithWakeless>;
  readonly buyerAddress: string;
  readonly extraBuyers: readonly ExtraBuyer[];
  readonly facilitatorUrl: string;
  readonly stores: Stores;
  /** The receipt signer's public key, as `/supported` `signers` lists it. */
  readonly receiptSigner: string;
  /** This run's admin bearer token for `POST /admin/redeem` and `GET /admin/alerts`. */
  readonly adminToken: string;
  /** This run's receipt bearer token per vendor name, for `GET /receipts/:channelId`. */
  readonly receiptTokens: Readonly<Record<string, string>>;
  /** One redemption run through the worker: one private transfer per channel owed. The worker runs on no timer here. */
  redeem(): Promise<RedeemRunSummary>;
  /** One close pass of the worker (task 8.1): idle closes, then due closes (vendor paid, buyer refunded, closed). `pay.close(channelId)` requests a close. */
  closeRun(): Promise<CloseRunSummary>;
  /** Grows as the run emits: every deposit, settle and refund, in order. */
  readonly signatures: readonly Signature[];
  readonly channelStoreLocal: string;
  readonly balanceBefore: bigint;
  privateBalance(): Promise<bigint>;
  /** How many of the signatures so far the public ledger shows. */
  countVisibleOnBaseLayer(): Promise<number>;
  /**
   * The watcher's four checks on every signature emitted so far, read from the base layer by
   * the watcher's own reader (`@wakeless/watcher`), against the three vendors and every
   * amount the trajectory paid them. `report.failures` non-empty fails the run.
   */
  watcherReport(): Promise<ObserverReport>;
  /** Throws if a log line carries a signature or a bearer token. */
  assertLogsClean(): void;
  /** The facilitator's log lines so far: ids, codes and error names, never an amount or a signature. */
  readonly facilitatorLog: readonly string[];
  close(): Promise<void>;
}

export async function startInProcessRun(label: string, options: InProcessRunOptions = {}): Promise<InProcessRun> {
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
  const emittedInputs: SignatureInput[] = [];
  const emitted: Emitted = (entry) => {
    signatures.push(entry.signature);
    emittedInputs.push(entry);
  };

  // The facilitator, in process, over the real escrow binding.
  const escrow = await createKeyPairFromBytes(keyBytes("ESCROW_KEYPAIR", "keys/escrow.json"));
  const realBinding = await MagicBlockBinding.create({ ...common, escrow, attestationReportPath: resolve(ROOT, "docs/attestation-facilitator.json") });
  const binding = countedEscrow(realBinding, emitted);
  const stores = createMemoryStores();
  const facilitatorLog: string[] = [];
  const log = (line: string) => facilitatorLog.push(line);
  // The redemption worker, admin-triggered only here (`redeem()`), with this run's own tokens.
  const signer = { secretKey: keyBytes("FACILITATOR_KEYPAIR", "keys/facilitator.json") };
  const redeemer = createRedeemer({ binding, stores, signer, log });
  const vendorKeys = VENDORS.map((definition) => ({ definition, payTo: publicKeyOf({ secretKey: keyBytes(`${definition.name.toUpperCase()}_KEYPAIR`, `keys/${definition.name}.json`) }) }));
  const adminToken = randomBytes(24).toString("base64url");
  const receiptTokens: Record<string, string> = Object.fromEntries(vendorKeys.map((v) => [v.definition.name, randomBytes(24).toString("base64url")]));
  const app = createFacilitatorApp({
    binding: { status: "ready", binding, teeValidator: realBinding.attestation.validatorIdentity! },
    stores,
    deposits: createDepositHandler({ binding, stores, log }),
    log,
    redeemer,
    adminToken,
    receiptTokens: new Map(vendorKeys.map((v) => [v.payTo, receiptTokens[v.definition.name]!])),
    receiptSigners: [redeemer.signer],
  });
  const facilitator = await new Promise<{ url: string; close: () => void }>((done) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => done({ url: `http://127.0.0.1:${info.port}`, close: () => server.close() }));
  });

  // The three vendors, each on its own keypair's public key.
  const vendors = await startVendors(
    vendorKeys.map(({ definition, payTo }) => {
      const terms = options.vendorTerms?.(definition.name, payTo);
      return { definition, payTo, port: 0, ...(terms === undefined ? {} : { terms }) };
    }),
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
    const need = options.minPrivateBalance ?? VENDORS.reduce((sum, v) => sum + BigInt(v.amount) * 100n, 0n);
    const balanceBefore = await buyerRail.privateBalance();
    if (balanceBefore < need) {
      throw new Error(`the buyer's private balance is below what the run needs (${Number(need) / 1e6} USDC); fund it with pnpm fund:private --role buyer first`);
    }
    const stamp = new Date().toISOString().replace(/[:.]/g, "-");
    const channelStoreLocal = resolve(homedir(), ".wakeless", `${label}-${stamp}.json`);
    const clientLog: string[] = [];
    const seenBy = (name: string): typeof fetch =>
      options.onResponse === undefined
        ? fetch
        : (async (input, init) => {
            const response = await fetch(input, init);
            options.onResponse!(name, response);
            return response;
          }) as typeof fetch;
    const pay = wrapFetchWithWakeless(seenBy("buyer"), { buyerKeypair, rail: countedBuyer(buyerRail, emitted), channelStoreLocal, facilitatorUrl: facilitator.url, log: (line) => clientLog.push(line) });
    const buyerAddress = address(publicKeyOf({ secretKey: buyerKeypair }));
    const readBaseLayer = createDevnetReader(baseRpcUrl);

    // Other buyers (task 12.1T): each attests its own rail login; its attestation report stays private under ~/.wakeless.
    const extraBuyers: ExtraBuyer[] = [];
    for (const spec of options.extraBuyers ?? []) {
      const extraRail = await MagicBlockBuyer.create({ ...common, buyer: await createKeyPairFromBytes(spec.keyBytes), attestationReportPath: resolve(homedir(), ".wakeless", `attestation-${spec.name}.json`) });
      const extraBalance = await extraRail.privateBalance();
      if (extraBalance < need) throw new Error(`${spec.name}'s private balance is below what the run needs (${Number(need) / 1e6} USDC); fund it with pnpm fund:private --keypair <its file> first`);
      extraBuyers.push({
        name: spec.name,
        address: publicKeyOf({ secretKey: spec.keyBytes }),
        pay: wrapFetchWithWakeless(seenBy(spec.name), { buyerKeypair: spec.keyBytes, rail: countedBuyer(extraRail, emitted), channelStoreLocal: resolve(homedir(), ".wakeless", `${label}-${spec.name}-${stamp}.json`), facilitatorUrl: facilitator.url, log: (line) => clientLog.push(line) }),
        balanceBefore: extraBalance,
        privateBalance: () => extraRail.privateBalance(),
      });
    }

    return {
      vendors,
      pay,
      buyerAddress,
      extraBuyers,
      facilitatorUrl: facilitator.url,
      stores,
      receiptSigner: redeemer.signer,
      adminToken,
      receiptTokens,
      redeem: () => redeemer.runOnce(),
      closeRun: () => redeemer.closeOnce(),
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
      watcherReport() {
        const trajectory = [...pay.getTrajectory(), ...extraBuyers.flatMap((b) => b.pay.getTrajectory())];
        const amounts = new Set<bigint>();
        for (const entry of trajectory) {
          for (const value of [entry.amount, entry.cumulative, entry.deposit]) if (value !== undefined && /^[1-9][0-9]*$/.test(value)) amounts.add(BigInt(value));
        }
        return observe(
          {
            rail: "wakeless",
            buyer: buyerAddress,
            escrow: realBinding.escrowAddress(),
            vendors: vendorKeys.map((v) => address(v.payTo)),
            attributableAmounts: [...amounts],
            signatures: emittedInputs.map((entry, i) => ({ ...entry, label: `${i + 1}. ${entry.label}` })),
          },
          readBaseLayer,
        );
      },
      assertLogsClean() {
        for (const line of [...clientLog, ...facilitatorLog]) {
          if (/[1-9A-HJ-NP-Za-km-z]{87,88}/.test(line) || /bearer/i.test(line)) throw new Error("a log line carries a signature or a token");
        }
      },
      facilitatorLog,
      close,
    };
  } catch (error) {
    await close();
    throw error;
  }
}
