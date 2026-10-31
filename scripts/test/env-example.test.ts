import { readFileSync } from "node:fs";
import { join } from "node:path";
import { parseEnv } from "node:util";
import { describe, expect, it } from "vitest";

const REQUIRED = [
  "HELIUS_API_KEY",
  "SOLANA_RPC_URL",
  "MAGICBLOCK_TEE_RPC",
  "MAGICBLOCK_PAYMENTS_API",
  "MAGICBLOCK_CLUSTER",
  "USDC_MINT",
  "AURORA_API_KEY",
  "FUNDING",
  "MAINNET_ENABLED",
  "DEMO_CONFIRM",
  "BUYER_KEYPAIR",
  "ESCROW_KEYPAIR",
  "VENDOR1_KEYPAIR",
  "VENDOR2_KEYPAIR",
  "VENDOR3_KEYPAIR",
];

describe(".env.example", () => {
  const parsed = parseEnv(readFileSync(join(import.meta.dirname, "..", "..", ".env.example"), "utf8"));

  it("env example lists every required variable", () => {
    expect(REQUIRED).toHaveLength(15);
    for (const name of REQUIRED) expect(parsed, name).toHaveProperty(name);
    expect(parsed.MAINNET_ENABLED).toBe("false");
  });

  it("env example holds no secret and points at devnet", () => {
    expect(parsed.HELIUS_API_KEY).toBe("");
    expect(parsed.AURORA_API_KEY).toBe("");
    expect(parsed.DEMO_CONFIRM).toBe("");
    expect(parsed.SOLANA_RPC_URL).toBe("https://devnet.helius-rpc.com/?api-key=$HELIUS_API_KEY");
    expect(parsed.MAGICBLOCK_CLUSTER).toBe("devnet");
  });
});
