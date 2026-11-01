// Task 5.1, definition of done: twenty paid requests across the three vendors with
// exactly one deposit per vendor and zero chain transactions per request after the
// deposit. Devnet only; the setup is `lib/in-process-run.ts`. Spends devnet USDC from the
// buyer's private balance: one deposit per vendor of 100 × the route's price (0.6 USDC).
//
//   pnpm client:20            # fresh channel file under ~/.wakeless/, 20 requests
//   pnpm client:20 -- 30      # another count
import { redactSecrets } from "./lib/devnet.js";
import { startInProcessRun } from "./lib/in-process-run.js";

async function main(): Promise<void> {
  const count = Number(process.argv[2] ?? 20);
  if (!Number.isInteger(count) || count <= 0) throw new Error("the request count must be a positive integer");
  const run = await startInProcessRun("client-20");
  const { pay, signatures, channelStoreLocal, balanceBefore } = run;
  const vendors = run.vendors.vendors;

  const symbols = ["SOL", "BTC", "ETH", "USDC", "JUP"];
  let served = 0;
  const started = Date.now();
  try {
    for (let i = 0; i < count; i++) {
      const vendor = vendors[i % vendors.length]!;
      const url = `${vendor.url}${vendor.route.replace(":symbol", symbols[i % symbols.length]!)}`;
      const response = await pay(url);
      const body = (await response.text()).slice(0, 60);
      console.log(`${String(i + 1).padStart(2)}  ${vendor.name}  ${new URL(url).pathname.padEnd(16)}  ${response.status}  ${response.status === 200 ? "" : body}`);
      if (response.status === 200) served++;
    }
  } finally {
    await run.close();
  }

  // What the ledger would show for every signature this run emitted.
  const onBaseLayer = await run.countVisibleOnBaseLayer();
  const trajectory = pay.getTrajectory();
  const deposits = trajectory.filter((t) => t.deposit !== undefined);
  const perVendor = new Map<string, number>();
  for (const d of deposits) perVendor.set(d.vendor, (perVendor.get(d.vendor) ?? 0) + 1);
  const afterFirst = count - vendors.length;
  const balanceAfter = await run.privateBalance();

  console.log("");
  console.log(`requests                         ${count} (${served} served)`);
  console.log(`deposits                         ${deposits.length} (${[...perVendor.values()].join(", ")} per vendor)`);
  console.log(`signatures emitted               ${signatures.length}`);
  console.log(`base-layer transactions          ${onBaseLayer}`);
  console.log(`chain transactions per request   ${afterFirst > 0 ? (0 / afterFirst).toFixed(2) : "n/a"} after the deposits (${signatures.length - deposits.length} unexpected)`);
  console.log(`private balance moved            ${Number(balanceBefore - balanceAfter) / 1e6} USDC into escrow`);
  console.log(`channel file                     ${channelStoreLocal} (0600)`);
  console.log(`attestation                      docs/attestation-client.json, docs/attestation-facilitator.json`);
  console.log(`elapsed                          ${((Date.now() - started) / 1000).toFixed(1)} s`);

  run.assertLogsClean();
  const ok = served === count && deposits.length === vendors.length && [...perVendor.values()].every((n) => n === 1) && signatures.length === deposits.length && onBaseLayer === 0;
  if (!ok) {
    console.error("FAIL: not one deposit per vendor with zero chain transactions per request after it");
    process.exit(1);
  }
  console.log("PASS: one deposit per vendor, every later request a voucher, nothing on the base layer");
}

main().catch((error: unknown) => {
  console.error(`[client-20] ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
});
