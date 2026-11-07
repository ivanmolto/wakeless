// Every Wakeless signature of the recorded run, read from devnet through the Helius RPC,
// passes the four checks. The run is described in docs/watcher/wakeless-run.json (the
// owner's addresses and amounts, the signatures and who made each). Needs .env.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, it } from "vitest";
import { skipUnless } from "../../../scripts/lib/skip-unless.js";
import { formatFailures, observe, runChecks, subjectFor } from "../src/observer.js";
import { reconstruct } from "../src/reconstruct.js";
import { createDevnetReader } from "../src/rpc.js";
import { parseRunFile } from "../src/run-file.js";

const RUN_FILE = join(import.meta.dirname, "..", "..", "..", "docs", "watcher", "wakeless-run.json");

skipUnless("SOLANA_RPC_URL", "needs the devnet RPC")("observer on devnet", () => {
  it("every Wakeless signature from the run passes the four checks", async () => {
    const run = parseRunFile(JSON.parse(readFileSync(RUN_FILE, "utf8")));
    expect(run.rail).toBe("wakeless");
    const read = createDevnetReader(process.env.SOLANA_RPC_URL!);
    const report = await observe(run, read);
    expect(formatFailures(report)).toEqual([]);
    expect(report.failures).toEqual([]);
    expect(report.rows).toHaveLength(run.signatures.length);
    // The checks ran, they did not skip: a vendor's withdrawal checked against the vendors would fail.
    const withdrawal = run.signatures.find((s) => s.party === "vendor");
    if (withdrawal !== undefined) {
      const tx = await read(withdrawal.signature);
      expect(runChecks(tx, subjectFor(run, "buyer")).some((c) => !c.pass)).toBe(true);
    }
    // And reconstruct() over the same signatures recovers no vendor.
    const transactions = [];
    for (const s of run.signatures) transactions.push(await read(s.signature));
    const trajectory = reconstruct(transactions);
    expect(trajectory.vendors).toEqual([]);
    expect(trajectory.spendPerVendor).toEqual({});
  });
});
