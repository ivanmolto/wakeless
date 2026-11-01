// `pnpm --filter @wakeless/mcp-server start`: the server over stdio. Devnet only. The
// buyer keypair comes from BUYER_KEYPAIR (Solana CLI JSON, 64 bytes), never from under
// keys/mainnet/; it signs vouchers and the deposit inside the client and goes nowhere
// else. stdout is the MCP wire, so every log line goes to stderr, and none carries an
// amount, a signature, a key or a token.
import { existsSync, readFileSync } from "node:fs";
import { resolve } from "node:path";
import { parseEnv } from "node:util";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { Budget, parseUsdc } from "./budget.js";
import { DEVNET_USDC, ROUTES, createBudgetedPay, createWakelessMcpServer, redactSecrets, type VendorUrls } from "./server.js";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");

function log(line: string): void {
  process.stderr.write(`[mcp-server] ${line}\n`);
}

/** `<root>/.env`, set variables winning, `$NAME` expanded. */
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
export function loadBuyerKeypair(path: string): Uint8Array {
  if (/(^|[\\/])keys[\\/]mainnet([\\/]|$)/.test(path)) throw new Error("Refusing a key under keys/mainnet/: the MCP server runs on devnet only");
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(resolve(ROOT, path), "utf8"));
  } catch {
    throw new Error("BUYER_KEYPAIR is not a readable JSON keypair file; run pnpm keys");
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new Error("BUYER_KEYPAIR is not an array of 64 bytes");
  }
  return Uint8Array.from(bytes as number[]);
}

/** Refuses before any RPC call. The message never contains the URL: it holds the API key. */
function assertDevnetRpcUrl(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error("SOLANA_RPC_URL is not a valid URL");
  }
  if (/mainnet/i.test(hostname)) throw new Error("Refusing a mainnet RPC URL: the MCP server runs on devnet only");
}

function vendorUrls(): VendorUrls {
  const url = (index: number, defaultPort: number): string => {
    const explicit = process.env[`VENDOR${index}_URL`];
    if (explicit) return explicit.replace(/\/+$/, "");
    const port = process.env[`VENDOR${index}_PORT`] || String(defaultPort);
    return `http://127.0.0.1:${port}`;
  };
  const [price, sentiment, news] = ROUTES;
  return { get_price: url(1, price!.defaultPort), get_sentiment: url(2, sentiment!.defaultPort), get_news: url(3, news!.defaultPort) };
}

async function main(): Promise<void> {
  loadDotEnv();
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured by the MCP server: it runs on devnet only");
  const baseRpc = required("SOLANA_RPC_URL");
  assertDevnetRpcUrl(baseRpc);
  const buyerKeypair = loadBuyerKeypair(process.env.BUYER_KEYPAIR || "keys/buyer.json");
  const mint = process.env.USDC_MINT || DEVNET_USDC;

  const budget = new Budget({
    ...(process.env.WAKELESS_BUDGET_FILE ? { path: resolve(ROOT, process.env.WAKELESS_BUDGET_FILE) } : {}),
    limits: {
      ...(process.env.WAKELESS_PER_PAYMENT_USDC ? { perPayment: parseUsdc(process.env.WAKELESS_PER_PAYMENT_USDC, "WAKELESS_PER_PAYMENT_USDC") } : {}),
      ...(process.env.WAKELESS_PER_DAY_USDC ? { perDay: parseUsdc(process.env.WAKELESS_PER_DAY_USDC, "WAKELESS_PER_DAY_USDC") } : {}),
    },
  });

  // The rail (MagicBlockBuyer) is built by the client on the first 402; that construction attests the TEE and writes the report.
  const pay = createBudgetedPay(fetch, {
    buyerKeypair,
    budget,
    asset: mint,
    mint,
    baseRpc,
    teeRpc: process.env.MAGICBLOCK_TEE_RPC || "https://devnet-tee.magicblock.app",
    paymentsApi: process.env.MAGICBLOCK_PAYMENTS_API || "https://payments.magicblock.app",
    attestationReportPath: resolve(ROOT, process.env.ATTESTATION_REPORT_PATH || "docs/attestation-mcp.json"),
    ...(process.env.WAKELESS_CHANNEL_STORE ? { channelStoreLocal: resolve(ROOT, process.env.WAKELESS_CHANNEL_STORE) } : {}),
    log: (line) => log(`client ${line}`),
  });

  const vendors = vendorUrls();
  const server = createWakelessMcpServer({ pay, budget, vendors, log });
  await server.connect(new StdioServerTransport());
  const { perPayment, perDay } = budget.status().limits;
  log(`ready over stdio: buyer ${pay.buyer}, caps ${perPayment} USDC per payment and ${perDay} USDC per 24 h, vendors ${Object.values(vendors).join(" ")}`);
}

main().catch((error: unknown) => {
  log(redactSecrets(error instanceof Error ? error.message : String(error)));
  process.exit(1);
});
