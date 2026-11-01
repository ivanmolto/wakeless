// Task 5.2: the end-to-end script and its metric. Devnet only; the script is the test.
// Thirty paid requests spread evenly across the three vendors, through the real facilitator
// and client over the real MagicBlock rail, then a table. Exits non-zero unless base-layer
// transactions per request is below 0.2, on both counts: what the ledger shows of the
// signatures (the headline) and every signature emitted (the plan's conservative bound).
// Spends 0.6 devnet USDC from the buyer's private balance into escrow.
//
//   pnpm e2e
import { redactSecrets } from "./lib/devnet.js";
import { E2E_TITLE, evaluateE2e, formatE2eTable } from "./lib/e2e-metric.js";
import { startInProcessRun } from "./lib/in-process-run.js";

const REQUESTS = 30;
const SYMBOLS = ["SOL", "BTC", "ETH", "USDC", "JUP"];

async function main(): Promise<void> {
  const run = await startInProcessRun("e2e");
  const vendors = run.vendors.vendors;
  const servedPerVendor = vendors.map(() => 0);
  const started = Date.now();
  try {
    for (let i = 0; i < REQUESTS; i++) {
      const index = i % vendors.length;
      const vendor = vendors[index]!;
      const url = `${vendor.url}${vendor.route.replace(":symbol", SYMBOLS[i % SYMBOLS.length]!)}`;
      const response = await run.pay(url);
      await response.arrayBuffer();
      if (response.status === 200) servedPerVendor[index]!++;
      else console.error(`request ${i + 1} to ${vendor.name} answered ${response.status}`);
    }
  } finally {
    await run.close();
  }

  const counts = {
    requests: REQUESTS,
    served: servedPerVendor.reduce((sum, n) => sum + n, 0),
    servedPerVendor,
    deposits: run.pay.getTrajectory().filter((entry) => entry.deposit !== undefined).length,
    signatures: run.signatures.length,
    visibleOnBaseLayer: await run.countVisibleOnBaseLayer(),
  };
  run.assertLogsClean();
  const verdict = evaluateE2e(counts);

  console.log(formatE2eTable(counts, verdict));
  console.log("");
  console.log(`served per vendor       ${servedPerVendor.join(", ")}`);
  console.log(`private balance moved   ${Number(run.balanceBefore - (await run.privateBalance())) / 1e6} USDC into escrow`);
  console.log(`attestation             docs/attestation-client.json, docs/attestation-facilitator.json`);
  console.log(`elapsed                 ${((Date.now() - started) / 1000).toFixed(1)} s`);
  console.log("");
  if (verdict.failures.length > 0) {
    for (const failure of verdict.failures) console.error(`FAIL: ${failure}`);
    console.error(`FAIL ${E2E_TITLE}`);
    process.exit(1);
  }
  console.log(`PASS ${E2E_TITLE}`);
}

main().catch((error: unknown) => {
  console.error(`[e2e] ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
  process.exit(1);
});
