// The definition of done for task 8.1 on devnet: the buyer deposits 2 USDC into a channel,
// spends 0.5 USDC on one paid call, closes the channel through the client, and after the
// grace period the worker pays vendor1 first (one private transfer escrow → vendor1) and
// refunds the rest (one private transfer escrow → buyer) to the buyer's private balance:
// 2 − 0.5 − the buyer's fee share. The client then offers, and does not perform, the
// withdrawal to the buyer's base token account.
// Run with `pnpm test:devnet` (.env as redeem.devnet.test.ts). The buyer's private balance
// must hold 2 USDC; vendor1 must already have a private balance. The grace period is
// skipped by moving the facilitator's clock, not by waiting fifteen minutes.
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { resolve } from "node:path";
import { serve } from "@hono/node-server";
import { address, createKeyPairFromBytes, type Signature } from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { MagicBlockBinding, MagicBlockBuyer } from "@wakeless/binding-magicblock";
import { chargeOf, createMagicBlockRail, wrapFetchWithWakeless } from "@wakeless/client";
import { publicKeyOf } from "@wakeless/scheme";
import { x402Shielded } from "@wakeless/vendor";
import { Hono } from "hono";
import { expect, it } from "vitest";
import { assertDevnetRpcUrl } from "../../../scripts/lib/devnet.js";
import { assertNotMainnetKeyPath } from "../../../scripts/lib/keypairs.js";
import { skipUnless } from "../../../scripts/lib/skip-unless.js";
import { REFUND_OP_ID, createDepositHandler, createFacilitatorApp, createMemoryStores, createRedeemer, feeOf, settleOpId } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const DEPOSIT = 2_000_000n; // 2 USDC
const PRICE = 500_000n; // 0.5 USDC for the one call
const WITHDRAW_DELAY = 900;
const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;

function keyBytes(envVar: string, fallback: string): Uint8Array {
  const path = resolve(root, process.env[envVar] || fallback);
  assertNotMainnetKeyPath(path);
  return Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
}

skipUnless("HELIUS_API_KEY", "deposit 2, spend 0.5, close: the remainder comes back to the buyer's private balance on devnet")("close on devnet", () => {
  it("deposit 2, spend 0.5, close returns 1.5 minus fee to the buyer's private balance", async () => {
    const rpcUrl = process.env.SOLANA_RPC_URL!;
    assertDevnetRpcUrl(rpcUrl);
    const common = {
      network: DEVNET_CAIP2,
      baseRpcUrl: rpcUrl,
      teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
      paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app",
      mint: address(process.env.USDC_MINT!),
    };
    const buyerBytes = keyBytes("BUYER_KEYPAIR", "keys/buyer.json");
    const vendorBytes = keyBytes("VENDOR1_KEYPAIR", "keys/vendor1.json");
    const payTo = publicKeyOf({ secretKey: vendorBytes });

    // The facilitator over the real escrow binding, with a clock the test can move past the grace period.
    const skew = { seconds: 0 };
    const now = () => Math.floor(Date.now() / 1000) + skew.seconds;
    const signatures: Signature[] = [];
    const escrow = await MagicBlockBinding.create({ ...common, escrow: await createKeyPairFromBytes(keyBytes("ESCROW_KEYPAIR", "keys/escrow.json")), delayWindowMs: { min: 0, max: 5_000 } });
    const binding = {
      ...escrow,
      id: escrow.id,
      network: () => escrow.network(),
      escrowAddress: () => escrow.escrowAddress(),
      readDeposit: escrow.readDeposit.bind(escrow),
      privateBalance: escrow.privateBalance.bind(escrow),
      transferStatus: escrow.transferStatus.bind(escrow),
      observe: escrow.observe.bind(escrow),
      async settle(...args: Parameters<MagicBlockBinding["settle"]>) {
        const result = await escrow.settle(...args);
        signatures.push(result.sig);
        return result;
      },
      async refund(...args: Parameters<MagicBlockBinding["refund"]>) {
        const result = await escrow.refund(...args);
        signatures.push(result.sig);
        return result;
      },
    };
    const stores = createMemoryStores();
    const logs: string[] = [];
    const log = (line: string) => logs.push(line);
    const redeemer = createRedeemer({ binding, stores, signer: { secretKey: keyBytes("FACILITATOR_KEYPAIR", "keys/facilitator.json") }, now, log });
    const app = createFacilitatorApp({ binding: { status: "ready", binding, teeValidator: escrow.attestation.validatorIdentity! }, stores, deposits: createDepositHandler({ binding, stores, log }), redeemer, now, log, receiptSigners: [redeemer.signer] });
    const facilitator = await new Promise<{ url: string; close: () => void }>((done) => {
      const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => done({ url: `http://127.0.0.1:${info.port}`, close: () => server.close() }));
    });
    try {
      // Vendor1's route at 0.5 USDC with a 2 USDC deposit target and the shortest grace the scheme allows.
      const vendor = new Hono();
      vendor.use("*", x402Shielded({ facilitatorUrl: facilitator.url, payTo, amountPerRoute: { "/price/:symbol": PRICE.toString() }, minDeposit: DEPOSIT.toString(), withdrawDelay: WITHDRAW_DELAY }));
      vendor.get("/price/:symbol", (c) => c.json({ symbol: c.req.param("symbol"), price: 1 }));
      const fetchImpl: typeof fetch = async (input, init) => {
        const request = new Request(input, init);
        return new URL(request.url).hostname === "vendor1.test" ? vendor.fetch(request) : fetch(request);
      };

      // The buyer: the real rail (attested once), the client wrapper, a fresh channel file.
      const buyerRail = await MagicBlockBuyer.create({ ...common, buyer: await createKeyPairFromBytes(buyerBytes) });
      const buyerBefore = await buyerRail.privateBalance();
      expect(buyerBefore, "the buyer's private balance must hold the 2 USDC deposit; pnpm fund:private --role buyer --usdc 2").toBeGreaterThanOrEqual(DEPOSIT);
      const vendorRail = await MagicBlockBuyer.create({ ...common, buyer: await createKeyPairFromBytes(vendorBytes) });
      const vendorBefore = await vendorRail.privateBalance();
      const clientLog: string[] = [];
      const pay = wrapFetchWithWakeless(fetchImpl, {
        buyerKeypair: buyerBytes,
        rail: () => createMagicBlockRail(buyerBytes, { ...common, baseRpc: common.baseRpcUrl, teeRpc: common.teeRpcUrl, paymentsApi: common.paymentsApiUrl }),
        channelStoreLocal: resolve(root, "keys", `close-devnet-${Date.now()}.json`),
        facilitatorUrl: facilitator.url,
        log: (line) => clientLog.push(line),
      });

      // Deposit 2, spend 0.5: one paid call.
      const paid = await pay("http://vendor1.test/price/SOL");
      expect(paid.status).toBe(200);
      await paid.arrayBuffer();
      const charge = chargeOf(PRICE, 10); // 500 500: the price plus the buyer's fee share
      const [channel] = pay.getChannels();
      expect(channel).toBeDefined();
      expect(channel!.deposit).toBe(DEPOSIT.toString());
      expect(channel!.accepted).toBe(charge.toString());
      expect(await buyerRail.privateBalance()).toBe(buyerBefore - DEPOSIT);

      // Close: closing, nothing moves until the grace has passed.
      const requested = await pay.close(channel!.channelId);
      expect(requested.state).toBe("closing");
      expect(requested.withdraw).toBeUndefined();
      expect(await redeemer.closeOnce()).toMatchObject({ due: 0, settled: 0, refunded: 0 });
      expect(signatures).toHaveLength(0);

      // Past the grace: the vendor is paid first, then the buyer is refunded; two private transfers.
      skew.seconds += WITHDRAW_DELAY;
      const run = await redeemer.closeOnce();
      expect(run).toEqual({ idle: 0, due: 1, settled: 1, refunded: 1, closed: 1, failed: 0, rejected: 0, skipped: 0 });
      expect(signatures).toHaveLength(2);
      const net = charge - feeOf(charge, 10); // 500 000: the vendor nets the price
      const refund = DEPOSIT - charge; // 1 499 500: 1.5 USDC minus the buyer's fee share
      const ops = (await stores.operations.list(channel!.channelId)).filter((o) => o.type !== "deposit");
      expect(ops.map((o) => [o.opId, o.status, o.signature])).toEqual([
        [settleOpId(1), "confirmed", signatures[0]],
        [REFUND_OP_ID, "confirmed", signatures[1]],
      ]);
      expect(ops[1]!.payload.amount).toBe(refund.toString());
      expect((await stores.channels.get(channel!.channelId))).toMatchObject({ state: "closed", settled: charge });
      expect((await vendorRail.privateBalance()) - vendorBefore).toBe(net);
      expect(await buyerRail.privateBalance()).toBe(buyerBefore - DEPOSIT + refund);

      // The client sees the refund and offers the withdrawal; it performs nothing: the private balance holds the refund.
      const closed = await pay.close(channel!.channelId);
      expect(closed.state).toBe("closed");
      expect(closed.refund).toEqual({ amount: refund, signature: signatures[1] });
      expect(closed.withdraw).toBeDefined();
      expect(closed.withdraw!.amount).toBe(refund);
      expect(closed.withdraw!.note).toMatch(/public base-layer transaction/);
      expect(pay.getChannels()[0]!.close).toMatchObject({ state: "closed", refund: { amount: refund.toString(), signature: signatures[1] }, withdraw: { note: expect.stringContaining("public base-layer") } });
      expect(pay.getChannels()[0]!.close!.withdraw!.performed).toBeUndefined();
      expect(await buyerRail.privateBalance()).toBe(buyerBefore - DEPOSIT + refund);

      // Both transfers executed inside the rollup: the public ledger shows nothing of either.
      for (const signature of signatures) {
        const view = await escrow.observe(signature);
        expect(view.onBaseLayer).toBe(false);
        expect(view.memoText).toEqual([]);
        expect(view.plaintextRecipients).toEqual([]);
      }
      for (const line of [...logs, ...clientLog]) {
        expect(line).not.toMatch(BASE58_88);
        expect(line).not.toMatch(/bearer/i);
      }
    } finally {
      facilitator.close();
    }
  }, 600_000);
});
