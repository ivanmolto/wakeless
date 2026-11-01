// The definition of done for task 4.1 on devnet: the client helper makes a real private
// transfer buyer → escrow inside the TEE, and /settle on an in-process facilitator over the
// real MagicBlock binding confirms it and creates the channel with that amount.
// Run with `pnpm test:devnet` (.env with HELIUS_API_KEY, SOLANA_RPC_URL, MAGICBLOCK_TEE_RPC,
// MAGICBLOCK_PAYMENTS_API, USDC_MINT, ESCROW_KEYPAIR, BUYER_KEYPAIR, VENDOR1_KEYPAIR). The
// buyer's private balance must hold the deposit (0.01 USDC). Spends devnet USDC only.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { address, createKeyPairFromBytes } from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { MagicBlockBinding, MagicBlockBuyer } from "@wakeless/binding-magicblock";
import { deposit } from "@wakeless/client";
import { SCHEME_ID, encodeBase58, type PaymentPayload, type PaymentRequirements, type SupportedResponse } from "@wakeless/scheme";
import { expect, it } from "vitest";
import { assertDevnetRpcUrl } from "../../../scripts/lib/devnet.js";
import { assertNotMainnetKeyPath } from "../../../scripts/lib/keypairs.js";
import { skipUnless } from "../../../scripts/lib/skip-unless.js";
import { createDepositHandler, createFacilitatorApp, createMemoryStores } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");
const DEPOSIT = 10_000n; // 0.01 USDC
const AMOUNT = 1_000n; // 0.001 USDC per request
const CHARGE = AMOUNT + 1n; // plus the 10 bps fee share, rounded up

function keyBytes(envVar: string, fallback: string): Uint8Array {
  const path = resolve(root, process.env[envVar] || fallback);
  assertNotMainnetKeyPath(path);
  return Uint8Array.from(JSON.parse(readFileSync(path, "utf8")) as number[]);
}

skipUnless("HELIUS_API_KEY", "a real private deposit buyer → escrow is confirmed by /settle on devnet")("deposit on devnet", () => {
  it("client helper deposit is recognised by /settle on devnet", async () => {
    const rpcUrl = process.env.SOLANA_RPC_URL!;
    assertDevnetRpcUrl(rpcUrl);
    const common = {
      network: DEVNET_CAIP2,
      baseRpcUrl: rpcUrl,
      teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC!,
      paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API!,
      mint: address(process.env.USDC_MINT!),
    };
    const buyerBytes = keyBytes("BUYER_KEYPAIR", "keys/buyer.json");
    const vendorBytes = keyBytes("VENDOR1_KEYPAIR", "keys/vendor1.json");
    const vendor = encodeBase58(vendorBytes.subarray(32));

    // The facilitator, in process, over the real escrow binding.
    const binding = await MagicBlockBinding.create({ ...common, escrow: await createKeyPairFromBytes(keyBytes("ESCROW_KEYPAIR", "keys/escrow.json")) });
    expect(binding.attestation.verified).toBe(true);
    const stores = createMemoryStores();
    const logs: string[] = [];
    const app = createFacilitatorApp({
      binding: { status: "ready", binding, teeValidator: binding.attestation.validatorIdentity! },
      stores,
      deposits: createDepositHandler({ binding, stores, log: (line) => logs.push(line) }),
      log: (line) => logs.push(line),
    });
    const supported = (await (await app.request("/supported")).json()) as SupportedResponse;
    const kind = supported.kinds[0]!;
    const requirements: PaymentRequirements = {
      scheme: SCHEME_ID,
      network: kind.network,
      amount: AMOUNT.toString(),
      asset: common.mint,
      payTo: vendor,
      maxTimeoutSeconds: 60,
      extra: {
        paymentFlow: "authorization",
        voucherSigner: "client",
        withdrawDelay: 900,
        tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
        escrowAddress: kind.extra!.escrowAddress,
        binding: "magicblock",
        teeValidator: kind.extra!.teeValidator,
        privacyFeeBps: kind.extra!.privacyFeeBps,
        maxIdleSecs: kind.extra!.maxIdleSecs,
      },
    };

    // The buyer, through the client helper and the real rail.
    const rail = await MagicBlockBuyer.create({ ...common, buyer: await createKeyPairFromBytes(buyerBytes) });
    expect(rail.teeValidator).toBe(requirements.extra.teeValidator);
    const before = await rail.privateBalance();
    expect(before, "the buyer's private balance must hold the deposit; fund it with POST /v1/spl/deposit (private: true)").toBeGreaterThanOrEqual(DEPOSIT);
    const salt = BigInt(Date.now()).toString();
    const result = await deposit({ rail, requirements, buyer: { secretKey: buyerBytes }, salt, amount: DEPOSIT, cumulative: CHARGE });
    expect(result.payload.depositSignature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/);

    // /verify, then /settle, as the vendor middleware will.
    const paymentPayload: PaymentPayload = { x402Version: 2, accepted: requirements, payload: result.payload };
    const body = JSON.stringify({ x402Version: 2, paymentPayload, paymentRequirements: requirements });
    const post = async (path: string) => {
      const res = await app.request(path, { method: "POST", body, headers: { "content-type": "application/json" } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const verify = await post("/verify");
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ isValid: true, payer: result.payload.channelConfig.buyer });

    const settle = await post("/settle");
    expect(settle.status).toBe(200);
    expect(settle.body).toMatchObject({
      success: true,
      transaction: result.signature,
      network: DEVNET_CAIP2,
      payer: result.payload.channelConfig.buyer,
      amount: DEPOSIT.toString(),
      extra: { commitmentId: `${result.channelId}:${CHARGE}`, channelState: { channelId: result.channelId, balance: DEPOSIT.toString(), totalClaimed: "0" } },
    });

    // The channel exists with the amount; the deposit is on record once; the buyer paid it.
    const record = await stores.channels.get(result.channelId);
    expect(record?.deposit).toBe(DEPOSIT);
    expect(record?.accepted).toBe(CHARGE);
    expect(record?.clientRef).toBe(result.clientRef);
    expect((await stores.operations.list(result.channelId)).map((o) => o.status)).toEqual(["confirmed"]);
    expect(await rail.privateBalance()).toBe(before - DEPOSIT);

    // The same payload again is a replay, not a second credit.
    const replay = await post("/settle");
    expect(replay.body.extra).toMatchObject({ replayed: true });
    expect((await stores.channels.get(result.channelId))?.deposit).toBe(DEPOSIT);

    // The deposit executed inside the rollup: the public ledger has no transaction for it.
    const view = await binding.observe(result.signature as Parameters<typeof binding.observe>[0]);
    expect(view.onBaseLayer).toBe(false);
    expect(view.memoText).toEqual([]);
    expect(view.plaintextRecipients).toEqual([]);

    for (const line of logs) expect(line).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
  }, 180_000);
});
