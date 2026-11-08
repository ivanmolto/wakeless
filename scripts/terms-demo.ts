// Task 12.1T: the relationship-terms demo beat. Devnet only; the script is the test.
//
// Two buyers call the same route (vendor1's GET /price/SOL) with RELATIONSHIP_TERMS on for
// vendor1: the repo's buyer (keys/buyer.json), whose seven clean periods with vendor1 are
// seeded through the vendor's history store from a recorded devnet run, and a fresh buyer
// (keys/buyer-fresh.json by default) vendor1 has never seen. The script prints both 402s and
// both terms receipt cards side by side, then runs the observer on every signature the run
// produced and prints its table beneath: empty of both buyers.
//
// The recorded run: the first time (or with --build-history), the script pays vendor1 seven
// times from the repo's buyer, redeeming after each call, and feeds vendor1's history store
// from the facilitator's receipts exactly as the vendor's receipt reader reads them
// (GET /admin/channels, GET /receipts/:channelId, task 7.3). The store, vendor1's private
// state, lives in ~/.wakeless/terms-vendor1.json; later runs seed from it. A period is clean
// when, once its transfer landed, nothing is owed.
//
//   pnpm terms:demo                   # seeds from the history file; builds it first if missing
//   pnpm terms:demo --build-history   # rebuilds the seven clean periods live
//
// Spends from the private balances: the repo's buyer about 0.03 devnet USDC on the first run
// (one 0.02 deposit for the history, one small deposit for the demo), under 0.01 after; the
// fresh buyer 0.02 (its one deposit). Redemptions pay vendor1 privately. Never prints a key, a
// token or a signature in full.
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { resolve } from "node:path";
import { parseSettlementReceipt, publicKeyOf } from "@wakeless/scheme";
import {
  FileTermsHistory,
  PAYMENT_REQUIRED_HEADER,
  parseTermsReceipt,
  shortId,
  sideBySide,
  termsCardLines,
  verifyTermsReceipt,
  type TermsOptions,
  type TermsReceipt,
  type VendorPaymentRequired,
} from "@wakeless/vendor";
import { parseAdminChannels, parseReceiptsResponse } from "@wakeless/vendors";
import { formatFailures, renderMarkdownTable } from "@wakeless/watcher";
import { redactSecrets } from "./lib/devnet.js";
import { loadDotEnv } from "./lib/env.js";
import { startInProcessRun, type InProcessRun } from "./lib/in-process-run.js";
import { assertNotMainnetKeyPath, generateKeypairJson } from "./lib/keypairs.js";

const ROOT = resolve(import.meta.dirname, "..");
const TITLE = "two buyers get two different terms and the observer table is empty";
const CLEAN_PERIODS = 7;
/** Enough for one standard deposit (20 calls × 0.001 USDC) and its fee shares. */
const MIN_PRIVATE_BALANCE = 25_000n;

function arg(name: string): string | undefined {
  const i = process.argv.findIndex((a) => a === `--${name}` || a.startsWith(`--${name}=`));
  if (i === -1) return undefined;
  return process.argv[i]!.includes("=") ? process.argv[i]!.split("=")[1] : process.argv[i + 1];
}

function keyBytes(path: string): Uint8Array {
  assertNotMainnetKeyPath(path);
  const bytes = JSON.parse(readFileSync(path, "utf8")) as unknown;
  if (!Array.isArray(bytes) || bytes.length !== 64) throw new Error(`${path.replace(ROOT + "/", "")} is not an array of 64 bytes`);
  return Uint8Array.from(bytes as number[]);
}

/** Long base58 runs (signatures, keys) never reach stdout. */
function mask(text: string): string {
  return redactSecrets(text).replace(/[1-9A-HJ-NP-Za-km-z]{64,88}/g, "[base58]");
}

function decode402(response: Response): VendorPaymentRequired | undefined {
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (header === null) return undefined;
  try {
    return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as VendorPaymentRequired;
  } catch {
    return undefined;
  }
}

/** The shielded entry of a 402 with its terms receipt, when it carries one. */
function termsEntry(required: VendorPaymentRequired | undefined, payTo: string): { amount: string; minDeposit: string; receipt: TermsReceipt } | undefined {
  const entry = required?.accepts.find((a) => a.scheme === "batch-settlement-shielded" && a.payTo === payTo);
  if (entry === undefined) return undefined;
  const extra = entry.extra as Record<string, unknown>;
  const receipt = parseTermsReceipt(extra.termsReceipt);
  if (receipt === undefined || typeof extra.minDeposit !== "string") return undefined;
  return { amount: entry.amount, minDeposit: extra.minDeposit, receipt };
}

/**
 * Feeds vendor1's history from the facilitator as the vendor's own receipt reader would:
 * each receipt is a redeemed period; it is clean when the channel owes nothing once the
 * transfer landed. Returns how many new periods were recorded.
 */
async function feedFromReceipts(run: InProcessRun, history: FileTermsHistory, vendor1: string, recorded: Set<string>): Promise<number> {
  const admin = await fetch(`${run.facilitatorUrl}/admin/channels?vendor=${vendor1}`, { headers: { authorization: `Bearer ${run.adminToken}` } });
  if (admin.status !== 200) throw new Error(`GET /admin/channels → HTTP ${admin.status}`);
  const channels = parseAdminChannels(await admin.json());
  let added = 0;
  for (const channel of channels) {
    const res = await fetch(`${run.facilitatorUrl}/receipts/${channel.channelId}`, { headers: { authorization: `Bearer ${run.receiptTokens.vendor1!}` } });
    if (res.status !== 200) throw new Error(`GET /receipts/:channelId → HTTP ${res.status}`);
    const view = parseReceiptsResponse(await res.json());
    const receipts = view.receipts.map((raw) => {
      const parsed = parseSettlementReceipt(raw);
      if (!parsed.ok) throw new Error(`a receipt did not parse: ${parsed.message}`);
      return parsed.value;
    });
    for (const receipt of receipts.sort((a, b) => a.period - b.period)) {
      const key = `${channel.channelId}:${receipt.period}`;
      if (recorded.has(key)) continue;
      recorded.add(key);
      history.redeemed({ channelId: channel.channelId, period: receipt.period, owed: channel.accepted - channel.settled });
      added++;
    }
  }
  return added;
}

function vendorTermsFor(signer: Uint8Array, history: FileTermsHistory): (name: string) => TermsOptions | undefined {
  return (name) => (name === "vendor1" ? { signer: { secretKey: signer }, history } : undefined);
}

/** Seven clean periods, live: pay, redeem, record; the history file is the recorded run. */
async function buildHistory(signer: Uint8Array, history: FileTermsHistory, buyer: string, vendor1: string): Promise<void> {
  const have = history.get(buyer)?.cleanPeriods ?? 0;
  const want = Math.max(0, CLEAN_PERIODS - have);
  console.log(`history: ${buyer === "" ? "" : shortId(buyer)} has ${have} clean period${have === 1 ? "" : "s"} with vendor1; recording ${want} more from a live devnet run`);
  if (want === 0) return;
  const run = await startInProcessRun("terms-history", { vendorTerms: vendorTermsFor(signer, history), minPrivateBalance: MIN_PRIVATE_BALANCE });
  const recorded = new Set<string>();
  try {
    const v1 = run.vendors.vendors.find((v) => v.name === "vendor1")!;
    for (let i = 0; i < want; i++) {
      const response = await run.pay(`${v1.url}${v1.route.replace(":symbol", "SOL")}`);
      await response.arrayBuffer();
      if (response.status !== 200) throw new Error(`history call ${i + 1} answered ${response.status}`);
      const redeemed = await run.redeem();
      if (redeemed.confirmed < 1) throw new Error(`redemption ${i + 1} paid nothing (owed ${redeemed.owed}, failed ${redeemed.failed}, skipped ${redeemed.skipped}); the vendor's private deposit is the usual cause (@wakeless/vendor README)`);
      const added = await feedFromReceipts(run, history, vendor1, recorded);
      console.log(`history: period ${have + i + 1} redeemed and recorded (${added} receipt${added === 1 ? "" : "s"}); vendor1 now holds ${history.get(buyer)?.cleanPeriods ?? 0} clean periods for ${shortId(buyer)}`);
    }
    run.assertLogsClean();
    const watcher = await run.watcherReport();
    const failures = formatFailures(watcher);
    if (failures.length > 0) {
      for (const f of failures) console.error(f);
      throw new Error("the history run failed the watcher's checks");
    }
  } finally {
    await run.close();
  }
}

async function main(): Promise<void> {
  loadDotEnv(ROOT);
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured here: this script runs on devnet only");
  // The flag, on for this script and visible as such; the vendors read it through the options below.
  process.env.RELATIONSHIP_TERMS = "true";

  const signer = keyBytes(resolve(ROOT, process.env.VENDOR1_KEYPAIR || "keys/vendor1.json"));
  const vendor1 = publicKeyOf({ secretKey: signer });
  const buyerA = publicKeyOf({ secretKey: keyBytes(resolve(ROOT, process.env.BUYER_KEYPAIR || "keys/buyer.json")) });
  const freshPath = resolve(ROOT, arg("fresh-buyer") ?? "keys/buyer-fresh.json");
  assertNotMainnetKeyPath(freshPath);
  if (!existsSync(freshPath)) {
    writeFileSync(freshPath, generateKeypairJson(), { mode: 0o600 });
    const rel = freshPath.replace(ROOT + "/", "");
    console.error(`generated ${rel} (the fresh buyer). It needs a private balance before the demo can run; nothing was spent:`);
    console.error(`  1. send it 0.02 devnet SOL and 0.1 devnet USDC (base layer; pnpm airdrop and pnpm tokens name the faucets)`);
    console.error(`  2. pnpm fund:private --keypair ${rel} --usdc 0.1`);
    console.error(`  3. pnpm terms:demo`);
    process.exit(2);
  }
  const freshBytes = keyBytes(freshPath);
  const buyerB = publicKeyOf({ secretKey: freshBytes });
  if (buyerB === buyerA) throw new Error("the fresh buyer must be a different key from the repo's buyer");

  const historyPath = resolve(process.env.TERMS_HISTORY_DIR || resolve(homedir(), ".wakeless"), "terms-vendor1.json");
  const history = new FileTermsHistory(historyPath);
  if (history.get(buyerB) !== undefined) throw new Error(`vendor1's history already knows the fresh buyer (${shortId(buyerB)}); use another key with --fresh-buyer`);
  if (process.argv.includes("--build-history") || (history.get(buyerA)?.cleanPeriods ?? 0) < CLEAN_PERIODS) await buildHistory(signer, history, buyerA, vendor1);
  const seeded = history.get(buyerA);
  if (seeded === undefined || seeded.cleanPeriods < CLEAN_PERIODS) throw new Error("the history could not be built");
  console.log(`history: seeded from ${historyPath.replace(homedir(), "~")}: ${seeded.cleanPeriods} clean periods over ${seeded.channels.length} channel${seeded.channels.length === 1 ? "" : "s"} for ${shortId(buyerA)}; ${shortId(buyerB)} unknown`);
  console.log("");

  // The demo: both buyers, one route, every 402 recorded.
  const seen = new Map<string, VendorPaymentRequired[]>();
  const run = await startInProcessRun("terms-demo", {
    vendorTerms: vendorTermsFor(signer, history),
    minPrivateBalance: MIN_PRIVATE_BALANCE,
    extraBuyers: [{ name: "fresh", keyBytes: freshBytes }],
    onResponse: (buyer, response) => {
      if (response.status !== 402) return;
      const required = decode402(response);
      if (required !== undefined) seen.set(buyer, [...(seen.get(buyer) ?? []), required]);
    },
  });
  const started = Date.now();
  let failures: string[];
  let quotes: { a: ReturnType<typeof termsEntry>; b: ReturnType<typeof termsEntry> } = { a: undefined, b: undefined };
  try {
    const v1 = run.vendors.vendors.find((v) => v.name === "vendor1")!;
    const url = `${v1.url}${v1.route.replace(":symbol", "SOL")}`;
    const fresh = run.extraBuyers[0]!;
    for (const [name, pay] of [
      ["buyer", run.pay],
      ["fresh", fresh.pay],
    ] as const) {
      const response = await pay(url);
      await response.arrayBuffer();
      if (response.status !== 200) throw new Error(`${name}'s call answered ${response.status} ${mask(JSON.stringify(seen.get(name)?.at(-1)?.error ?? ""))}`);
    }
    // The 402 each buyer paid against: the last one carrying this buyer's terms.
    const lastTerms = (name: string) => [...(seen.get(name) ?? [])].reverse().map((r) => termsEntry(r, vendor1)).find((t) => t !== undefined);
    quotes = { a: lastTerms("buyer"), b: lastTerms("fresh") };
    if (quotes.a === undefined || quotes.b === undefined) throw new Error("a buyer saw no 402 with a terms receipt");
    for (const [who, q] of [
      [shortId(buyerA), quotes.a],
      [shortId(buyerB), quotes.b],
    ] as const) {
      if (!verifyTermsReceipt(vendor1, q.receipt)) throw new Error(`the terms receipt quoted to ${who} does not verify against vendor1's key`);
    }

    const route = `GET ${v1.route}`;
    const show = (q: NonNullable<typeof quotes.a>) => JSON.stringify({ amount: q.amount, extra: { minDeposit: q.minDeposit, termsReceipt: { ...q.receipt, vendorSignature: shortId(q.receipt.vendorSignature) } } }, null, 1).split("\n");
    console.log(`THE TWO 402s · ${route} · vendor1 ${shortId(vendor1)} · left ${shortId(buyerA)} (${seeded.cleanPeriods} clean periods), right ${shortId(buyerB)} (first contact)`);
    console.log(sideBySide(show(quotes.a), show(quotes.b)));
    console.log("");
    console.log(sideBySide(termsCardLines(quotes.a.receipt, { route, buyer: buyerA, signedBy: "vendor1" }), termsCardLines(quotes.b.receipt, { route, buyer: buyerB, signedBy: "vendor1" })));
    console.log("");

    // Redemption pays vendor1 privately and, read back as receipts, gives the known buyer one more clean period.
    const redeemed = await run.redeem();
    const added = await feedFromReceipts(run, history, vendor1, new Set());
    console.log(`redemption: ${redeemed.owed} channels owed, ${redeemed.confirmed} redeemed by private transfer; ${added} receipt${added === 1 ? "" : "s"} fed to vendor1's history (${shortId(buyerA)} now ${history.get(buyerA)?.cleanPeriods} clean periods, ${shortId(buyerB)} ${history.get(buyerB)?.cleanPeriods ?? 0})`);
    run.assertLogsClean();

    const watcher = await run.watcherReport();
    failures = formatFailures(watcher);
    const table = renderMarkdownTable(watcher);
    console.log("");
    console.log(`OBSERVER · every signature the run produced (${watcher.counts.signatures}), read from the base layer`);
    console.log(table);
    console.log("");
    for (const addr of [buyerA, buyerB, vendor1]) {
      if (table.includes(addr)) failures.push(`FAIL the observer table names ${shortId(addr)}`);
    }
    if (quotes.a.amount === quotes.b.amount && quotes.a.minDeposit === quotes.b.minDeposit) failures.push("FAIL the two buyers got the same terms");
    if (BigInt(quotes.b.amount) < BigInt(quotes.a.amount) && quotes.b.receipt.adjustments.length === 0 && quotes.a.receipt.adjustments.every((a) => a.bps < 0)) failures.push("FAIL the unknown buyer's price is below a clean buyer's");
  } finally {
    await run.close();
  }

  console.log(`elapsed ${((Date.now() - started) / 1000).toFixed(1)} s · history ${historyPath.replace(homedir(), "~")} (vendor1's private state; not committed)`);
  if (failures.length > 0) {
    for (const f of failures) console.error(mask(f));
    console.error(`FAIL ${TITLE}`);
    process.exit(1);
  }
  console.log(`PASS ${TITLE}`);
}

main().catch((error: unknown) => {
  console.error(`[terms-demo] ${mask(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
});
