// The definition of done for task 7.3 on devnet: paid calls to vendor1 through the real
// client, vendor middleware and facilitator over the real MagicBlock rail, one admin redeem,
// then vendor1's receipt reader, logged in to the attested TEE RPC with keys/vendor1.json:
// the table matches the facilitator's stores, every receipt verifies against the advertised
// signer, the rail finds every transfer under vendor1's own login, and nothing is flagged.
// Run with `pnpm test:devnet` (.env as redeem.devnet.test.ts). Spends one 0.1 USDC devnet
// deposit into escrow from the buyer's private balance, and redeems it to vendor1.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { address, createKeyPairFromBytes } from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { MagicBlockPayee } from "@wakeless/binding-magicblock";
import { expect, it } from "vitest";
import { assertNotMainnetKeyPath } from "../../../scripts/lib/keypairs.js";
import { startInProcessRun } from "../../../scripts/lib/in-process-run.js";
import { skipUnless } from "../../../scripts/lib/skip-unless.js";
import { formatReport, isClean, readVendorReceipts } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const CALLS = 5;
const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;

skipUnless("HELIUS_API_KEY", "vendor1's receipt reader against a real private redemption on devnet")("vendor receipts on devnet", () => {
  it("receipt table matches facilitator state after a devnet redeem", async () => {
    const run = await startInProcessRun("receipts-devnet");
    try {
      const vendor1 = run.vendors.vendors.find((v) => v.name === "vendor1")!;
      for (let i = 0; i < CALLS; i++) {
        const response = await run.pay(`${vendor1.url}${vendor1.route.replace(":symbol", "SOL")}`);
        await response.arrayBuffer();
        expect(response.status, `call ${i + 1}`).toBe(200);
      }
      const redeem = await fetch(`${run.facilitatorUrl}/admin/redeem`, { method: "POST", headers: { authorization: `Bearer ${run.adminToken}` } });
      expect(redeem.status).toBe(200);

      const vendorPath = resolve(root, process.env.VENDOR1_KEYPAIR || "keys/vendor1.json");
      assertNotMainnetKeyPath(vendorPath);
      const payee = await MagicBlockPayee.create({
        network: DEVNET_CAIP2,
        baseRpcUrl: process.env.SOLANA_RPC_URL!,
        teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
        paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app",
        mint: address(process.env.USDC_MINT!),
        payee: await createKeyPairFromBytes(Uint8Array.from(JSON.parse(readFileSync(vendorPath, "utf8")) as number[])),
        attestationReportPath: resolve(root, "docs/attestation-vendor.json"),
      });
      expect(payee.attestation.verified).toBe(true);
      expect(payee.address()).toBe(vendor1.payTo);

      const report = await readVendorReceipts({ payee, facilitatorUrl: run.facilitatorUrl, adminToken: run.adminToken, receiptToken: run.receiptTokens.vendor1! });

      // The facilitator's own state, straight from its stores.
      const channels = (await run.stores.channels.list()).filter((c) => c.vendor === vendor1.payTo);
      expect(channels).toHaveLength(1);
      const channel = channels[0]!;
      const confirmed = (await run.stores.operations.list(channel.channelId)).filter((o) => o.type === "settle" && o.status === "confirmed");
      expect(confirmed).toHaveLength(1);
      expect(report.channels.map((c) => [c.channelId, c.accepted, c.settled, c.settle.confirmed])).toEqual([[channel.channelId, channel.accepted, channel.settled, 1]]);
      expect(report.rows.map((r) => [r.channelId, r.period, r.cumulative, r.amount, r.transferSignature])).toEqual([
        [channel.channelId, 1, channel.settled, BigInt(confirmed[0]!.payload.amount as string), confirmed[0]!.signature],
      ]);
      expect(report.rows.every((r) => r.verified && r.transfer === "landed")).toBe(true);
      expect(report.signers).toEqual([run.receiptSigner]);
      expect(report.referenceIds).toEqual([]);
      expect(report.mismatches).toEqual([]);
      expect(isClean(report)).toBe(true);

      const out = formatReport(report, "vendor1", [run.adminToken, ...Object.values(run.receiptTokens)]);
      expect(out).not.toMatch(BASE58_88);
      for (const token of [run.adminToken, ...Object.values(run.receiptTokens)]) expect(out).not.toContain(token);
      run.assertLogsClean();
    } finally {
      await run.close();
    }
  }, 300_000);
});
