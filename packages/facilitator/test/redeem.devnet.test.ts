// The definition of done for task 7.2 on devnet: twenty paid calls to vendor1 through the
// real client, vendor middleware and facilitator over the real MagicBlock rail, then one
// admin redeem makes exactly one private transfer escrow → vendor1 for the amount owed net
// of the 0.1% fee; vendor1's private balance grows by that amount; the receipt is served by
// GET /receipts/:channelId under vendor1's token and verifies against the advertised signer.
// Run with `pnpm test:devnet` (.env as deposit.devnet.test.ts; `pnpm keys` for keys/facilitator.json).
// The buyer's private balance must hold the three deposits (0.6 USDC); vendor1 must already
// have a private balance (it has since the spike). Spends 0.1 USDC of devnet USDC into escrow.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { address, createKeyPairFromBytes, type Signature } from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { MagicBlockBinding, MagicBlockBuyer } from "@wakeless/binding-magicblock";
import { verifyReceipt, type SupportedResponse } from "@wakeless/scheme";
import { expect, it } from "vitest";
import { assertNotMainnetKeyPath } from "../../../scripts/lib/keypairs.js";
import { startInProcessRun } from "../../../scripts/lib/in-process-run.js";
import { skipUnless } from "../../../scripts/lib/skip-unless.js";
import { feeOf, type ReceiptsResponse, type RedeemRunSummary } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const CALLS = 20;
/** Vendor1's `/price/:symbol` price in base units (`packages/vendors/src/servers.ts`, `VENDORS`). */
const PRICE = 1_000n;
const SYMBOLS = ["SOL", "BTC", "ETH", "USDC", "JUP"];

skipUnless("HELIUS_API_KEY", "twenty paid calls and one real private redemption escrow → vendor1 on devnet")("redeem on devnet", () => {
  it("twenty paid calls then one redeem produce one private transfer", async () => {
    const run = await startInProcessRun("redeem-devnet");
    try {
      const vendor1 = run.vendors.vendors.find((v) => v.name === "vendor1")!;
      // Vendor1's own view of its private balance, through the rail's buyer side (a read).
      const vendorPath = resolve(root, process.env.VENDOR1_KEYPAIR || "keys/vendor1.json");
      assertNotMainnetKeyPath(vendorPath);
      const vendorKey = await createKeyPairFromBytes(Uint8Array.from(JSON.parse(readFileSync(vendorPath, "utf8")) as number[]));
      const vendorRail = await MagicBlockBuyer.create({
        network: DEVNET_CAIP2,
        baseRpcUrl: process.env.SOLANA_RPC_URL!,
        teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
        paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app",
        mint: address(process.env.USDC_MINT!),
        buyer: vendorKey,
      });
      const vendorBefore = await vendorRail.privateBalance();

      // Twenty paid calls to vendor1: one deposit, then vouchers.
      for (let i = 0; i < CALLS; i++) {
        const response = await run.pay(`${vendor1.url}${vendor1.route.replace(":symbol", SYMBOLS[i % SYMBOLS.length]!)}`);
        await response.arrayBuffer();
        expect(response.status, `call ${i + 1}`).toBe(200);
      }
      const channels = await run.stores.channels.list();
      expect(channels).toHaveLength(1);
      const channel = channels[0]!;
      const owed = channel.accepted - channel.settled;
      expect(channel.settled).toBe(0n);
      expect(owed).toBe((PRICE + 1n) * BigInt(CALLS)); // price plus the 10 bps share, rounded up, per call
      const signaturesBefore = run.signatures.length;
      expect(signaturesBefore).toBe(1); // the deposit

      // One admin redeem, over HTTP with the admin token: exactly one private transfer.
      const redeem = await fetch(`${run.facilitatorUrl}/admin/redeem`, { method: "POST", headers: { authorization: `Bearer ${run.adminToken}` } });
      expect(redeem.status).toBe(200);
      expect((await redeem.json()) as RedeemRunSummary).toEqual({ owed: 1, confirmed: 1, failed: 0, rejected: 0, skipped: 0 });
      expect(run.signatures).toHaveLength(signaturesBefore + 1);
      const transfer = run.signatures.at(-1)!;
      const net = owed - feeOf(owed, 10);
      expect((await run.stores.channels.get(channel.channelId))?.settled).toBe(channel.accepted);
      const ops = await run.stores.operations.list(channel.channelId);
      expect(ops.filter((o) => o.type === "settle").map((o) => [o.opId, o.status, o.signature])).toEqual([["settle:1", "confirmed", transfer]]);

      // The vendor's private balance grew by the amount minus the 0.1% fee.
      expect((await vendorRail.privateBalance()) - vendorBefore).toBe(net);

      // The receipt, under the vendor's token, matches and verifies against the advertised signer.
      const supported = (await (await fetch(`${run.facilitatorUrl}/supported`)).json()) as SupportedResponse;
      expect(supported.signers["solana:*"]).toEqual([run.receiptSigner]);
      expect((await fetch(`${run.facilitatorUrl}/receipts/${channel.channelId}`)).status).toBe(401);
      const res = await fetch(`${run.facilitatorUrl}/receipts/${channel.channelId}`, { headers: { authorization: `Bearer ${run.receiptTokens.vendor1}` } });
      expect(res.status).toBe(200);
      const body = (await res.json()) as ReceiptsResponse;
      expect(body.signer).toBe(run.receiptSigner);
      expect(body.receipts).toHaveLength(1);
      expect(body.receipts[0]).toMatchObject({ channelId: channel.channelId, period: 1, cumulative: channel.accepted.toString(), amount: net.toString(), signature: transfer });
      expect(verifyReceipt(run.receiptSigner, body.receipts[0]!)).toBe(true);
      // Another vendor's token learns nothing.
      expect((await fetch(`${run.facilitatorUrl}/receipts/${channel.channelId}`, { headers: { authorization: `Bearer ${run.receiptTokens.vendor2}` } })).status).toBe(404);

      // A second redeem has nothing to transfer.
      expect(await run.redeem()).toEqual({ owed: 0, confirmed: 0, failed: 0, rejected: 0, skipped: 0 });
      expect(run.signatures).toHaveLength(signaturesBefore + 1);

      // The transfer executed inside the rollup: the public ledger shows nothing of it.
      expect(await run.countVisibleOnBaseLayer()).toBe(0);
      const observer = await MagicBlockBinding.create({
        network: DEVNET_CAIP2,
        baseRpcUrl: process.env.SOLANA_RPC_URL!,
        teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
        paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app",
        mint: address(process.env.USDC_MINT!),
        escrow: await createKeyPairFromBytes(Uint8Array.from(JSON.parse(readFileSync(resolve(root, process.env.ESCROW_KEYPAIR || "keys/escrow.json"), "utf8")) as number[])),
      });
      const view = await observer.observe(transfer as Signature);
      expect(view.onBaseLayer).toBe(false);
      expect(view.memoText).toEqual([]);
      expect(view.plaintextRecipients).toEqual([]);
      run.assertLogsClean();
    } finally {
      await run.close();
    }
  }, 300_000);
});
