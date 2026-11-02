// The facilitator process: `pnpm --filter @wakeless/facilitator start`. Devnet only.
// Builds the MagicBlock binding (which attests the TEE first), picks the stores from the
// environment, and serves the app. If attestation fails the server still starts, with an
// empty `/supported`, so a vendor learns why instead of seeing a connection refused.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { serve } from "@hono/node-server";
import { createKeyPairFromBytes, type Address } from "@solana/kit";
import { DEVNET_CAIP2, isBindingError, BINDING_ERROR_CODES } from "@wakeless/binding";
import { MagicBlockBinding } from "@wakeless/binding-magicblock";
import { publicKeyOf } from "@wakeless/scheme";
import { createDepositHandler } from "./deposit.js";
import { createFacilitatorApp } from "./http/app.js";
import { parseReceiptTokens } from "./http/auth.js";
import type { BindingState } from "./http/binding-state.js";
import { createFacilitatorLogger, type FacilitatorLogger } from "./http/log.js";
import { DEFAULT_RATE_LIMITS, parseRateRule } from "./http/rate-limit.js";
import { DEFAULT_REDEEM_INTERVAL_SECS, createRedeemer, type Redeemer } from "./redeem.js";
import { createMemoryStores } from "./stores/memory.js";
import { createRedisStores } from "./stores/redis.js";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");

/** `<root>/.env`, set variables winning, `$NAME` expanded (node's parser leaves it alone). */
function loadDotEnv(): void {
  const path = resolve(ROOT, ".env");
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, "utf8"));
  const vars: Record<string, string | undefined> = { ...parsed, ...process.env };
  for (const [name, value] of Object.entries(parsed)) {
    if (process.env[name] === undefined && value !== undefined) {
      process.env[name] = value.replace(/\$(?:\{(\w+)\}|(\w+))/g, (_, braced?: string, bare?: string) => vars[(braced ?? bare) as string] ?? "");
    }
  }
}

function required(name: string): string {
  const value = process.env[name];
  if (!value) throw new Error(`${name} is not set; see .env.example`);
  return value;
}

/** Solana CLI format, 64 bytes. Never under keys/mainnet/. Errors never quote the file. */
function keyBytes(envVar: string, path: string): Uint8Array {
  if (/(^|[\\/])keys[\\/]mainnet([\\/]|$)/.test(path)) throw new Error("Refusing a key under keys/mainnet/: the facilitator runs on devnet only");
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
  } catch {
    throw new Error(`${envVar} is not a readable JSON keypair file; run pnpm keys`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${envVar} is not an array of 64 bytes`);
  return Uint8Array.from(bytes as number[]);
}

async function loadEscrow(path: string) {
  return createKeyPairFromBytes(keyBytes("ESCROW_KEYPAIR", path));
}

/** `REDEEM_INTERVAL` in seconds, `off` for admin-triggered runs only. Default 60 s (demo); production runs 3600. */
function parseRedeemInterval(text: string | undefined): number | false {
  if (text === undefined || text.trim() === "") return DEFAULT_REDEEM_INTERVAL_SECS;
  if (text.trim() === "off") return false;
  const seconds = Number(text);
  if (!Number.isSafeInteger(seconds) || seconds < 1) throw new Error("REDEEM_INTERVAL must be a whole number of seconds or off");
  return seconds;
}

async function bindingState(logger: FacilitatorLogger): Promise<BindingState> {
  const baseRpcUrl = required("SOLANA_RPC_URL");
  if (/mainnet/i.test(new URL(baseRpcUrl).hostname)) throw new Error("Refusing a mainnet RPC URL: the facilitator runs on devnet only");
  const escrow = await loadEscrow(process.env.ESCROW_KEYPAIR ?? "keys/escrow.json");
  try {
    const binding = await MagicBlockBinding.create({
      network: DEVNET_CAIP2,
      baseRpcUrl,
      teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
      paymentsApiUrl: process.env.MAGICBLOCK_PAYMENTS_API ?? "https://payments.magicblock.app",
      mint: required("USDC_MINT") as Address,
      escrow,
      // Its own file: docs/attestation-devnet.json is the spike's report and carries the raw quote.
      attestationReportPath: resolve(ROOT, process.env.ATTESTATION_REPORT_PATH ?? "docs/attestation-facilitator.json"),
    });
    const teeValidator = binding.attestation.validatorIdentity;
    if (teeValidator === null) throw new Error("the attested TEE RPC reported no validator identity");
    return { status: "ready", binding, teeValidator };
  } catch (error) {
    if (isBindingError(error, BINDING_ERROR_CODES.attestationFailed)) {
      logger.error({ event: "attestation_failed", code: BINDING_ERROR_CODES.attestationFailed }, `${error.message}; serving an empty /supported`);
      return { status: "attestation_failed", error: error.message };
    }
    throw error;
  }
}

async function main(): Promise<void> {
  loadDotEnv();
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured by the facilitator: it runs on devnet only");
  // Structured JSON lines on stdout (pino). `FACILITATOR_LOG_LEVEL` defaults to info.
  const logger = createFacilitatorLogger({ level: process.env.FACILITATOR_LOG_LEVEL ?? "info" });
  // `"<limit>/<seconds>"` or `"off"`; parsed before the binding so a typo fails fast.
  const rateLimits = {
    perIp: parseRateRule(process.env.FACILITATOR_RATE_IP, DEFAULT_RATE_LIMITS.perIp),
    perChannel: parseRateRule(process.env.FACILITATOR_RATE_CHANNEL, DEFAULT_RATE_LIMITS.perChannel),
  };
  const trustProxy = process.env.FACILITATOR_TRUST_PROXY === "true";
  // The receipt signer, the admin token and the vendors' receipt tokens, all parsed before the binding.
  const signer = { secretKey: keyBytes("FACILITATOR_KEYPAIR", process.env.FACILITATOR_KEYPAIR ?? "keys/facilitator.json") };
  const receiptTokens = parseReceiptTokens(process.env.FACILITATOR_RECEIPT_TOKENS);
  const adminToken = process.env.FACILITATOR_ADMIN_TOKEN || undefined;
  if (adminToken !== undefined && adminToken.length < 16) throw new Error("FACILITATOR_ADMIN_TOKEN must be at least 16 characters");
  const redeemInterval = parseRedeemInterval(process.env.REDEEM_INTERVAL);
  const binding = await bindingState(logger);
  const stores = process.env.REDIS_URL ? createRedisStores(process.env.REDIS_URL) : createMemoryStores();
  const deposits = binding.status === "ready" ? createDepositHandler({ binding: binding.binding, stores, logger }) : undefined;
  let redeemer: Redeemer | undefined;
  if (binding.status === "ready") {
    redeemer = createRedeemer({ binding: binding.binding, stores, signer, logger });
    // Startup: every `pending` settle operation is reconciled against the binding before anything is sent.
    const reconciled = await redeemer.reconcile();
    logger.info({ event: "reconciled", ...reconciled }, `reconciled ${reconciled.pending} pending settle operations`);
    if (redeemInterval !== false) redeemer.start(redeemInterval * 1000);
  }
  if (adminToken === undefined) logger.warn({ event: "admin_disabled" }, "FACILITATOR_ADMIN_TOKEN is not set: /admin/* is disabled");
  const app = createFacilitatorApp({ binding, stores, deposits, logger, rateLimits, trustProxy, redeemer, adminToken, receiptTokens, receiptSigners: [publicKeyOf(signer)] });
  const port = Number(process.env.FACILITATOR_PORT ?? 4020);
  const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info) => {
    logger.info(
      {
        event: "listening",
        url: `http://127.0.0.1:${info.port}`,
        binding: binding.status,
        stores: process.env.REDIS_URL ? "redis" : "memory",
        network: DEVNET_CAIP2,
        rateLimitPerIp: rateLimits.perIp === false ? "off" : `${rateLimits.perIp.limit}/${rateLimits.perIp.windowSeconds}`,
        rateLimitPerChannel: rateLimits.perChannel === false ? "off" : `${rateLimits.perChannel.limit}/${rateLimits.perChannel.windowSeconds}`,
        trustProxy,
        redeemInterval: redeemInterval === false ? "off" : redeemInterval,
        receiptSigner: publicKeyOf(signer),
        receiptVendors: receiptTokens.size,
        admin: adminToken === undefined ? "disabled" : "enabled",
      },
      `listening on http://127.0.0.1:${info.port}`,
    );
  });
  const stop = () => {
    redeemer?.stop();
    server.close();
    void stores.close().finally(() => process.exit(0));
  };
  process.once("SIGINT", stop);
  process.once("SIGTERM", stop);
}

main().catch((error: unknown) => {
  console.error(`[facilitator] ${error instanceof Error ? error.message : String(error)}`);
  process.exit(1);
});
