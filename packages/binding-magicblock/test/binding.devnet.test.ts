// The real binding against the devnet TEE and the Payments API. Run with `pnpm test:devnet`
// (needs .env with HELIUS_API_KEY, SOLANA_RPC_URL, MAGICBLOCK_TEE_RPC, MAGICBLOCK_PAYMENTS_API,
// USDC_MINT and ESCROW_KEYPAIR). Reads only: attestation, two logins, one balance.
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { address, createKeyPairFromBytes } from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { expect, it } from "vitest";
import { assertDevnetRpcUrl } from "../../../scripts/lib/devnet.js";
import { assertNotMainnetKeyPath } from "../../../scripts/lib/keypairs.js";
import { skipUnless } from "../../../scripts/lib/skip-unless.js";
import { MagicBlockBinding } from "../src/index.js";

const root = resolve(import.meta.dirname, "../../..");

skipUnless("HELIUS_API_KEY", "the MagicBlock binding is constructed against the devnet TEE")("MagicBlockBinding on devnet", () => {
  it("real binding constructs and reads privateBalance", async () => {
    const rpcUrl = process.env.SOLANA_RPC_URL!;
    assertDevnetRpcUrl(rpcUrl);
    const keyPath = resolve(root, process.env.ESCROW_KEYPAIR || "keys/escrow.json");
    assertNotMainnetKeyPath(keyPath);
    const escrow = await createKeyPairFromBytes(Uint8Array.from(JSON.parse(readFileSync(keyPath, "utf8")) as number[]));
    const reportPath = resolve(root, "docs/attestation-devnet.json");
    const before = JSON.parse(readFileSync(reportPath, "utf8")) as { validatorIdentity: string };

    const binding = await MagicBlockBinding.create({
      network: DEVNET_CAIP2,
      baseRpcUrl: rpcUrl,
      teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC!,
      paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API!,
      mint: address(process.env.USDC_MINT!),
      escrow,
    });
    expect(binding.attestation.verified).toBe(true);
    expect(binding.attestation.host).toBe("devnet-tee.magicblock.app");
    expect(binding.attestation.validatorIdentity).toBe(before.validatorIdentity);
    expect(binding.network()).toBe(DEVNET_CAIP2);
    const balance = await binding.privateBalance();
    expect(typeof balance).toBe("bigint");
    expect(balance).toBeGreaterThanOrEqual(0n);
  }, 120_000);
});
