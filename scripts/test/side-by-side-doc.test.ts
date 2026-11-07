import type { Address } from "@solana/kit";
import type { ObserverReport, Reconstruction, Trajectory } from "@wakeless/watcher";
import { describe, expect, it } from "vitest";
import { differenceParagraph, headlineOf, labelPublicTransaction, perCall, renderSideBySide, sideBySideJson, verdicts, type RailRun, type SideBySideInput } from "../lib/side-by-side-doc.js";

const PAYER = "94BRf9UjVLdNUBGGeKuFqWSk4sA67EDtAmS9pm6RTjzT" as Address;
const V = ["9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy", "6ZyZr5kfZ924Fv6ZmU6Mrji67L6XhhhReCCvFs47srrQ", "GJZXBks8C3edcBCdE6Se9qQiFsBBGDMMvLTWM4YYUwS6"] as Address[];
const W = ["ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm", "3Qdg6oJAoe6uHE7zeDGz9TNvmrQRRWAYrMEqJyPZm9Sc", "5Vckjt8WpuA4gWv13qqHKe4jnA5BQyUedrGUZhSLKFtJ"] as Address[];

function trajectory(vendors: Address[], spend: bigint[], times: number[]): Trajectory {
  return { payer: PAYER, vendors, firstContactOrder: vendors, spendPerVendor: Object.fromEntries(vendors.map((v, i) => [v, spend[i]!])) as Record<Address, bigint>, settlementTimes: times };
}

function rebuilt(t: Partial<Trajectory>, edges: Reconstruction["edges"] = []): Reconstruction {
  return { vendors: [], firstContactOrder: [], spendPerVendor: {}, settlementTimes: [], ...t, edges };
}

function report(rail: "public" | "wakeless", onBaseLayer: number, notOnBaseLayer: number, failures: ObserverReport["failures"] = []): ObserverReport {
  return { rail, rows: [], failures, counts: { signatures: onBaseLayer + notOnBaseLayer, onBaseLayer, notOnBaseLayer } };
}

const publicActual = trajectory(V, [100_000n, 100_000n, 100_000n], [1, 2, 3]);
const publicRail: RailRun = {
  rail: "public",
  title: "public",
  provenance: "stock examples",
  calls: 30,
  railTransactions: 9,
  setup: [],
  report: report("public", 9, 0),
  rebuilt: rebuilt(publicActual),
  actual: publicActual,
};
const wakelessActual = trajectory(W, [10_010n, 20_020n, 30_030n], [4, 5, 6]);
const wakeless: RailRun = {
  rail: "wakeless",
  title: "wakeless",
  provenance: "in-process run",
  calls: 30,
  railTransactions: 0,
  setup: [],
  report: report("wakeless", 0, 6),
  rebuilt: rebuilt({}),
  actual: wakelessActual,
  ownerView: "### Paid calls\n\nowner rows\n",
};
const good: SideBySideInput = { date: "2026-11-07", workload: "Workload: 30 calls.", publicRail, wakeless };

describe("headlines", () => {
  it("transactions per call is transactions over served calls, two decimals", () => {
    expect(perCall(9, 30)).toBe("0.30");
    expect(perCall(0, 30)).toBe("0.00");
    expect(perCall(3, 10)).toBe("0.30");
    expect(() => perCall(3, 0)).toThrow(/no paid call/);
  });

  it("the public rail recovers everything and Wakeless nothing on the published shape", () => {
    expect(headlineOf(publicRail).comparison).toEqual({ vendorsRecovered: 3, vendorsActual: 3, spendRecoveredBps: 10_000, orderRecovered: true });
    expect(headlineOf(wakeless).comparison).toEqual({ vendorsRecovered: 0, vendorsActual: 3, spendRecoveredBps: 0, orderRecovered: false });
  });
});

describe("verdicts", () => {
  it("both titles pass on the published shape", () => {
    expect(verdicts(good).map((v) => v.failures)).toEqual([[], []]);
    expect(verdicts(good).map((v) => v.title)).toEqual(["side-by-side: Wakeless leaks zero and the public rail leaks more than zero", "side-by-side: compare recovers every vendor on the public rail and none on Wakeless"]);
  });

  it("one Wakeless base-layer transaction fails the first title", () => {
    const [leaks] = verdicts({ ...good, wakeless: { ...wakeless, railTransactions: 1 } });
    expect(leaks!.failures).toEqual(["Wakeless put 1 transactions on the base layer"]);
  });

  it("a failed watcher check fails the first title", () => {
    const failure = { signature: "x" as never, label: "deposit", check: 1 as const, name: "no vendor address", evidence: [] };
    const [leaks] = verdicts({ ...good, wakeless: { ...wakeless, report: report("wakeless", 0, 6, [failure]) } });
    expect(leaks!.failures).toEqual(["1 watcher check(s) failed on Wakeless"]);
  });

  it("a Wakeless reconstruction that recovers a vendor fails both titles, not a tunable", () => {
    const leaky = { ...wakeless, rebuilt: rebuilt({ vendors: [W[0]!], firstContactOrder: [W[0]!], spendPerVendor: { [W[0]!]: 10_010n } }) };
    const [leaks, recovers] = verdicts({ ...good, wakeless: leaky });
    expect(leaks!.failures).toEqual(["Wakeless spend recovered 16.66%"]);
    expect(recovers!.failures).toEqual(["Wakeless recovered 1 / 3 vendors"]);
  });

  it("a public rail that recovers two of three vendors fails the second title", () => {
    const partial = { ...publicRail, rebuilt: rebuilt(trajectory(V.slice(0, 2), [100_000n, 100_000n], [1, 2])) };
    const [, recovers] = verdicts({ ...good, publicRail: partial });
    expect(recovers!.failures).toEqual(["public rail recovered 2 / 3 vendors"]);
  });

  it("a public rail with nothing on the base layer fails the first title: the comparison needs a leak to compare against", () => {
    const silent = { ...publicRail, railTransactions: 0, rebuilt: rebuilt({}) };
    const [leaks] = verdicts({ ...good, publicRail: silent });
    expect(leaks!.failures).toEqual(["the public rail put nothing on the base layer", "the public rail leaked no spend"]);
  });
});

describe("the difference paragraph", () => {
  it("has the four sentences: numbers, the base layer for Wakeless, what remains, the trust boundary", () => {
    const text = differenceParagraph(good);
    expect(text).toContain("9 transactions on the base layer through the public rail (0.30 per call) and 0 through Wakeless (0.00 per call)");
    expect(text).toContain("rebuilt 3 of 3 vendors, 100.00% of the spend and the order of first contact");
    expect(text).toContain("base layer shows vault deposits and withdrawals only");
    expect(text).toContain("no vault deposit or withdrawal by any party landed in the window");
    expect(text).toContain("What remains recoverable is the edge of the pool");
    for (const operator of ["facilitator sees the vouchers", "MagicBlock's enclave sees the private transfers", "NEAR's private shard"]) expect(text).toContain(operator);
  });

  it("lists vault edges when the window holds them, shortened", () => {
    const edge = { signature: "s" as never, blockTime: 1, program: "SPLx" as Address, from: W[0]!, to: W[1]!, amount: 250_000n };
    const text = differenceParagraph({ ...good, wakeless: { ...wakeless, rebuilt: rebuilt({}, [edge]) } });
    expect(text).toContain("1 vault edge (250000 from `ATvA…hetm` to `3Qdg…m9Sc`)");
  });

  it("calls a leak a failure of the rail instead of explaining it away", () => {
    const leaky = { ...wakeless, railTransactions: 2, rebuilt: rebuilt({ vendors: [W[0]!], firstContactOrder: [W[0]!], spendPerVendor: { [W[0]!]: 10_010n } }) };
    const text = differenceParagraph({ ...good, wakeless: leaky });
    expect(text).toContain("this run put 2 rail transactions there, which is a failure of the rail");
    expect(text).toContain("recovered 1 of 3 vendors and 16.66% of the spend from the Wakeless signatures, which is a failure of the rail");
    expect(text).not.toContain("edge of the pool");
  });
});

describe("renderSideBySide", () => {
  it("carries both headline numbers in the table and again in each rail's section", () => {
    const md = renderSideBySide(good);
    expect(md).toContain("| Base-layer transactions per call | 9 / 30 = 0.30 | 0 / 30 = 0.00 |");
    expect(md).toContain("| Vendors recovered / actual | 3 / 3 | 0 / 3 |");
    expect(md.match(/^\*\*Base-layer transactions per call: /gm)).toHaveLength(2);
    expect(md.match(/^\*\*Vendors recovered \/ actual: /gm)).toHaveLength(2);
    expect(md).toContain("### The owner table");
    expect(md).toContain("owner rows");
    expect(md).not.toContain("The public rail was not driven");
  });

  it("says in bold at the top when the public rail came from the log", () => {
    const md = renderSideBySide({ ...good, publicFallback: "Driving the stock examples failed: port 4021 is in use." });
    expect(md).toContain("**The public rail was not driven in this run.** Driving the stock examples failed: port 4021 is in use. Its numbers below come from the signatures in `docs/public-rail-log.md`.");
  });

  it("the JSON carries the same numbers as the markdown, amounts as strings", () => {
    const json = JSON.parse(sideBySideJson(good)) as { public: { transactionsPerCall: string; comparison: { vendorsRecovered: number }; actual: { spendPerVendor: Record<string, string> } }; wakeless: { transactionsPerCall: string; comparison: { vendorsRecovered: number } } };
    expect(json.public.transactionsPerCall).toBe("0.30");
    expect(json.wakeless.transactionsPerCall).toBe("0.00");
    expect(json.public.comparison.vendorsRecovered).toBe(3);
    expect(json.wakeless.comparison.vendorsRecovered).toBe(0);
    expect(json.public.actual.spendPerVendor[V[0]!]).toBe("100000");
  });
});

describe("labelPublicTransaction", () => {
  it("names the recipients of an open and a distribute", () => {
    expect(labelPublicTransaction({ instruction: "open", discriminator: 1, deposit: 100_000n, recipientVendors: [2] })).toBe("open, vendor 2 (deposit 100000, call 1)");
    expect(labelPublicTransaction({ instruction: "distribute", discriminator: 7, recipientVendors: [3] })).toBe("distribute, payout to vendor 3");
  });

  it("lists every recipient of a split open, and says when one is not the run's", () => {
    expect(labelPublicTransaction({ instruction: "open", discriminator: 1, deposit: 5n, recipientVendors: [1, 0] })).toBe("open, 2 recipients: vendor 1, a recipient outside the run (deposit 5, call 1)");
  });

  it("marks a settle whose open fell outside the window as vendor unknown instead of guessing", () => {
    expect(labelPublicTransaction({ instruction: "settle", discriminator: 2 })).toBe("settle (claim of the latest voucher), vendor unknown (the channel's open is outside the window)");
    expect(labelPublicTransaction({ instruction: "settle", discriminator: 2, channelVendors: [1] })).toBe("settle (claim of the latest voucher), vendor 1");
    expect(labelPublicTransaction({ instruction: "topUp", discriminator: 3, channelVendors: [2] })).toBe("top-up, vendor 2");
    expect(labelPublicTransaction({ instruction: "settleAndSeal", discriminator: 4 })).toBe("settle and seal, vendor unknown (the channel's open is outside the window)");
  });

  it("names an unknown instruction by its discriminator", () => {
    expect(labelPublicTransaction({ instruction: "other", discriminator: 9 })).toBe("payment-channels instruction 9");
    expect(labelPublicTransaction({ instruction: "other", discriminator: undefined })).toBe("payment-channels instruction ?");
  });
});
