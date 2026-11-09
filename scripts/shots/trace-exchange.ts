// Evidence capture (docs/shots/agent.png): one vendor route paid twice through the real
// client against the facilitator and vendors already running for an agent run, with a
// tracing `fetch` around the client so the frame shows the wire: the 402 with its
// PAYMENT-REQUIRED header, the resend with PAYMENT-SIGNATURE, the 200 with its body.
// The client is unchanged; only the fetch it is handed prints. Devnet only. Prints no
// signature, no token and no channel amount: payload kinds, channel ids and hashes only.
//
//   ATTESTATION_REPORT_PATH=docs/shots/trace-attestation.json pnpm shots:trace [symbol]
import { readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join, resolve } from "node:path";
import { wrapFetchWithWakeless } from "@wakeless/client";
import { assertDevnetRpcUrl } from "../lib/devnet.js";
import { loadDotEnv } from "../lib/env.js";

const ROOT = join(import.meta.dirname, "..", "..");
const VENDOR1 = "http://127.0.0.1:4021";
const DEVNET = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

function keyBytes(envVar: string, fallback: string): Uint8Array {
  const path = resolve(ROOT, process.env[envVar] || fallback);
  if (path.includes(`${"/keys/mainnet/"}`)) throw new Error("devnet code path: refusing a mainnet keypair");
  const bytes: unknown = JSON.parse(readFileSync(path, "utf8"));
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${envVar} is not an array of 64 bytes`);
  return Uint8Array.from(bytes as number[]);
}

const short = (s: string) => (s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s);
const decodeB64 = (s: string): unknown => JSON.parse(Buffer.from(s, "base64").toString("utf8"));
const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** What a reader learns from the PAYMENT-REQUIRED header, without the parts a log may not carry. */
function describeRequired(header: string): string[] {
  const body = decodeB64(header);
  if (!isObject(body) || !Array.isArray(body.accepts) || !isObject(body.accepts[0])) return ["  PAYMENT-REQUIRED  (unreadable)"];
  const a = body.accepts[0];
  const extra = isObject(a.extra) ? a.extra : {};
  const price = typeof a.amount === "string" ? `${a.amount} (${Number(a.amount) / 1e6} USDC per call)` : "?";
  return [
    `  PAYMENT-REQUIRED  x402Version ${String(body.x402Version)} · accepts[0].scheme ${String(a.scheme)}`,
    `                    network ${String(a.network) === DEVNET ? "solana devnet" : String(a.network)} · amount ${price} · payTo ${short(String(a.payTo))}`,
    `                    extra.binding ${String(extra.binding)} · teeValidator ${short(String(extra.teeValidator))} · minDeposit ${String(extra.minDeposit)} · privacyFeeBps ${String(extra.privacyFeeBps)}`,
  ];
}

/** The payload kind and channel the client sent back; the voucher's signature and amounts stay out of the frame. */
function describeSignature(header: string): string[] {
  const body = decodeB64(header);
  if (!isObject(body) || !isObject(body.payload)) return ["  PAYMENT-SIGNATURE  (unreadable)"];
  const payload = body.payload;
  const kinds = [payload.deposit !== undefined ? "deposit (client-signed private transfer into escrow)" : undefined, payload.voucher !== undefined ? "voucher (Ed25519, signed by the buyer)" : undefined].filter((k): k is string => k !== undefined);
  const voucher = isObject(payload.voucher) ? payload.voucher : {};
  const channel = typeof voucher.channelId === "string" ? voucher.channelId : typeof payload.channelId === "string" ? payload.channelId : "?";
  return [`  PAYMENT-SIGNATURE  base64 JSON, ${header.length} bytes · payload: ${kinds.join(" + ")}`, `                     channel ${short(channel)} · cumulative amount and signature not shown`];
}

async function main(): Promise<void> {
  loadDotEnv(ROOT);
  const symbol = process.argv[2] ?? "SOL";
  const lines: string[] = [];
  const out = (line: string) => {
    lines.push(line);
    console.log(line);
  };

  const tracing: typeof fetch = async (input, init) => {
    const request = input instanceof Request ? input : new Request(input, init);
    const signature = request.headers.get("PAYMENT-SIGNATURE");
    const path = new URL(request.url).pathname;
    out(`→ ${request.method} ${path}${signature === null ? "" : "  + PAYMENT-SIGNATURE"}`);
    if (signature !== null) for (const line of describeSignature(signature)) out(line);
    const response = await fetch(request);
    out(`← ${response.status} ${response.statusText}`);
    const required = response.headers.get("PAYMENT-REQUIRED");
    if (required !== null) for (const line of describeRequired(required)) out(line);
    const settled = response.headers.get("PAYMENT-RESPONSE");
    if (settled !== null) {
      const body = decodeB64(settled);
      out(`  PAYMENT-RESPONSE  ${isObject(body) ? `success ${String(body.success)} · network ${String(body.network) === DEVNET ? "solana devnet" : String(body.network)}` : "(unreadable)"}`);
    }
    if (response.status === 200) out(`  ${(await response.clone().text()).slice(0, 96)}`);
    return response;
  };

  const baseRpc = process.env.SOLANA_RPC_URL;
  if (!baseRpc) throw new Error("SOLANA_RPC_URL is not set; see .env.example");
  assertDevnetRpcUrl(baseRpc);
  const pay = wrapFetchWithWakeless(tracing, {
    buyerKeypair: keyBytes("BUYER_KEYPAIR", "keys/buyer.json"),
    baseRpc,
    teeRpc: process.env.MAGICBLOCK_TEE_RPC || "https://devnet-tee.magicblock.app",
    paymentsApi: process.env.MAGICBLOCK_PAYMENTS_API || "https://payments.magicblock.app",
    channelStoreLocal: process.env.SHOTS_CHANNEL_STORE ?? join(homedir(), ".wakeless", "shots-channels.json"),
    ...(process.env.ATTESTATION_REPORT_PATH === undefined ? {} : { attestationReportPath: process.env.ATTESTATION_REPORT_PATH }),
  });

  out(`$ GET ${VENDOR1}/price/${symbol}   (first call to vendor1: opens the channel)`);
  await pay(`${VENDOR1}/price/${symbol}`);
  out("");
  out(`$ GET ${VENDOR1}/price/${symbol}   (second call: voucher only)`);
  await pay(`${VENDOR1}/price/${symbol}`);

  const text = lines.join("\n");
  if (/[1-9A-HJ-NP-Za-km-z]{86,90}/.test(text) || /bearer /i.test(text)) throw new Error("the trace carries a signature or a token; not saved");
}

main().catch((error: unknown) => {
  console.error(`[shots:trace] ${error instanceof Error ? (process.env.SHOTS_DEBUG ? (error.stack ?? error.message) : error.message) : String(error)}`);
  process.exit(1);
});
