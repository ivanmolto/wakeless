#!/usr/bin/env node
// `wakeless fund --from <chain> --amount <usdc> [--to <solana address>] [--refund-to <addr>]
// [--confirm <DEMO_CONFIRM>] [--no-wait]` (task 8.3). Reads `.env` in the current
// directory, loads no keypair (the recipient is the public half of
// MAINNET_BUYER_KEYPAIR when --to is not given), and runs `fund()`. Exit 0 on SUCCESS
// and REFUNDED, 1 on FAILED or a polling timeout, 2 when refused before anything was sent.
import { existsSync, readFileSync, realpathSync } from "node:fs";
import { join, resolve } from "node:path";
import { pathToFileURL } from "node:url";
import { parseEnv } from "node:util";
import { encodeBase58 } from "@wakeless/scheme";
import { FUND_ERROR_CODES, FundRefusedError, fund, redactKey } from "./fund.js";
import { LocalChannelStore, defaultStorePath } from "./store.js";

const USAGE = `usage: wakeless fund --from <chain> --amount <usdc> [--to <solana address>] [--refund-to <origin address>] [--confirm <DEMO_CONFIRM>] [--no-wait]

Funds a Wakeless buyer address with USDC from another chain through Aurora Intents in confidential mode.
Mainnet only, and off by default: needs FUNDING=aurora, MAINNET_ENABLED=true, DEMO_CONFIRM set in .env and
repeated with --confirm, and AURORA_API_KEY. --amount is whole USDC, at most FUND_MAX_USDC (default 5).
--to defaults to the public key of MAINNET_BUYER_KEYPAIR (keys/mainnet/buyer.json); only that half is read.
--refund-to defaults to FUND_REFUND_TO in .env. See docs/FUNDING.md.`;

function loadDotEnv(root: string): void {
  const path = join(root, ".env");
  if (!existsSync(path)) return;
  const parsed = parseEnv(readFileSync(path, "utf8"));
  for (const [name, value] of Object.entries(parsed)) {
    if (process.env[name] === undefined && value !== undefined) process.env[name] = value;
  }
}

export function parseArgs(argv: readonly string[]): { readonly values: Readonly<Record<string, string>>; readonly flags: ReadonlySet<string> } {
  const values: Record<string, string> = {};
  const flags = new Set<string>();
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]!;
    if (!arg.startsWith("--")) continue;
    const [name, inline] = arg.slice(2).split("=", 2) as [string, string | undefined];
    if (name === "no-wait" || name === "help") {
      flags.add(name);
      continue;
    }
    const next = inline ?? argv[i + 1];
    if (next === undefined || (inline === undefined && next.startsWith("--"))) throw new FundRefusedError(FUND_ERROR_CODES.input, `--${name} needs a value`);
    values[name] = next;
    if (inline === undefined) i += 1;
  }
  return { values, flags };
}

/** The public key only: bytes 32 to 64 of a Solana CLI keypair file. The seed is never decoded or kept. */
export function publicKeyOfKeypairFile(path: string): string {
  let bytes: unknown;
  try {
    bytes = JSON.parse(readFileSync(path, "utf8"));
  } catch {
    throw new FundRefusedError(FUND_ERROR_CODES.input, `the keypair file at ${path} is missing or not JSON; pass --to <solana address> instead`);
  }
  if (!Array.isArray(bytes) || bytes.length !== 64 || !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)) {
    throw new FundRefusedError(FUND_ERROR_CODES.input, "the keypair file is not an array of 64 bytes; pass --to <solana address> instead");
  }
  return encodeBase58(Uint8Array.from(bytes.slice(32)));
}

export async function main(argv: readonly string[], root: string = process.cwd()): Promise<number> {
  const [command, ...rest] = argv;
  const { values, flags } = parseArgs(rest);
  if (command !== "fund" || flags.has("help")) {
    console.log(USAGE);
    return command === "fund" ? 0 : 2;
  }
  loadDotEnv(root);
  const env = process.env;
  const from = values.from ?? "";
  const amount = values.amount ?? "";
  if (from === "" || amount === "") {
    console.error(USAGE);
    return 2;
  }
  const recipient = values.to ?? publicKeyOfKeypairFile(resolve(root, env.MAINNET_BUYER_KEYPAIR || "keys/mainnet/buyer.json"));
  const refundTo = values["refund-to"] ?? env.FUND_REFUND_TO ?? "";
  const store = new LocalChannelStore(env.WAKELESS_CHANNEL_STORE ? resolve(root, env.WAKELESS_CHANNEL_STORE) : defaultStorePath());
  const outcome = await fund(
    { from, amount, recipient, refundTo, confirm: values.confirm, noWait: flags.has("no-wait") },
    {
      env,
      fetch: globalThis.fetch,
      store,
      print: (line) => console.log(line),
      // The channel deposit itself is the first paid request's (`wrapFetchWithWakeless`), made by the
      // demo runner against a vendor; this process has no vendor to pay, so the scheduled step is the handover.
      deposit: () => console.log("funds are in the buyer's base token account: move them to its private balance and pay a vendor from the demo runner now, not later (docs/FUNDING.md, \"After the arrival\")"),
    },
  );
  return outcome.exitCode;
}

// realpath: npm installs the `wakeless` bin as a symlink, and import.meta.url names the real file.
const invokedDirectly = process.argv[1] !== undefined && existsSync(process.argv[1]) && import.meta.url === pathToFileURL(realpathSync(process.argv[1])).href;
if (invokedDirectly) {
  main(process.argv.slice(2)).then(
    (code) => {
      process.exitCode = code;
    },
    (error: unknown) => {
      const text = error instanceof Error ? error.message : String(error);
      console.error(redactKey(text, process.env.AURORA_API_KEY ?? ""));
      process.exitCode = error instanceof FundRefusedError ? 2 : 1;
    },
  );
}
