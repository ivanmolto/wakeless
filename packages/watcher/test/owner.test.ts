import { readFileSync } from "node:fs";
import { join } from "node:path";
import { type Address } from "@solana/kit";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  OwnerDataError,
  ownerTrajectory,
  parseOwnerChannelFile,
  parseOwnerTrajectory,
  readOwnerView,
  renderOwnerView,
  type BalanceSample,
  type OwnerInput,
} from "../src/owner.js";
import { compare, reconstruct, trajectoryToJson } from "../src/reconstruct.js";
import { parseTrajectory } from "../src/run-file.js";
import { parsed, wakelessRaw } from "./fixtures/index.js";

/** Run-1 (`docs/runs/run-1.md`), the owner's trajectory as `getTrajectory()` exported it. */
const RUN_1 = parseOwnerTrajectory(JSON.parse(readFileSync(join(import.meta.dirname, "..", "..", "..", "docs", "runs", "run-1-trajectory.json"), "utf8")));
const RUN_1_BUYER = "3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba" as Address;
const PRICE = "ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm" as Address;
const SENTIMENT = "3Qdg6oJAoe6uHE7zeDGz9TNvmrQRRWAYrMEqJyPZm9Sc" as Address;
const NEWS = "5Vckjt8WpuA4gWv13qqHKe4jnA5BQyUedrGUZhSLKFtJ" as Address;
/** The reading `scripts/agent-run.ts before run-1` took through the TEE RPC (`~/.wakeless/agent-run-1-before.json`). */
const RUN_1_BEFORE: BalanceSample = { at: "2026-11-01T19:13:18.718Z", balance: 3_990_000n, label: "before run-1 (agent-run)" };

const RUN_1_INPUT: OwnerInput = { payer: RUN_1_BUYER, trajectory: RUN_1, channels: [], balances: [RUN_1_BEFORE] };

const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{88}/;

describe("owner view", () => {
  it("owner view renders the fixture trajectory", async () => {
    const markdown = renderOwnerView(RUN_1_INPUT);
    await expect(markdown).toMatchFileSnapshot("./snapshots/owner-run-1.md");
    // The snapshot pins the layout; these assert the numbers against the trajectory itself.
    const callRows = markdown.match(/^\| \d+ \| 2026-11-01 .* \|$/gm) ?? [];
    expect(callRows).toHaveLength(RUN_1.length);
    RUN_1.forEach((e, i) => expect(callRows[i]).toBe(`| ${i + 1} | ${e.timestamp.replace("T", " ")} | \`${e.vendor}\` | ${e.route} | ${e.amount} | ${e.cumulative} |`));
    expect(markdown.match(/\| deposit \|/g)).toHaveLength(RUN_1.filter((e) => e.deposit !== undefined).length);
    // Per vendor, the spend column equals the last cumulative the trajectory holds for that vendor, computed here without ownerTrajectory().
    for (const vendor of [PRICE, SENTIMENT, NEWS]) {
      const mine = RUN_1.filter((e) => e.vendor === vendor);
      const net = mine.reduce((s, e) => s + BigInt(e.amount), 0n);
      const spend = BigInt(mine.at(-1)!.cumulative);
      const deposited = mine.reduce((s, e) => s + BigInt(e.deposit ?? "0"), 0n);
      expect(markdown).toContain(`| \`${vendor}\` | ${mine.length} | ${net} | ${spend} | ${deposited} | 0 | ${deposited - spend} |`);
    }
    expect(markdown).toContain("| **Total** | 9 | 18000 | 18018 | 600000 | 0 | 581982 |");
    expect(markdown).toContain("= **3390000** (3.390000 USDC)");
    for (const operator of ["facilitator", "MagicBlock's enclave", "NEAR's private shard"]) expect(markdown).toContain(operator);
    expect(markdown).not.toMatch(BASE58_88);
  });

  it("exported Trajectory validates and compare(actual, actual) is full recovery", () => {
    const actual = ownerTrajectory(RUN_1_INPUT);
    expect(actual).toEqual({
      payer: RUN_1_BUYER,
      vendors: [PRICE, SENTIMENT, NEWS],
      firstContactOrder: [PRICE, SENTIMENT, NEWS],
      spendPerVendor: { [PRICE]: 3003n, [SENTIMENT]: 6006n, [NEWS]: 9009n },
      settlementTimes: RUN_1.map((e) => Math.floor(Date.parse(e.timestamp) / 1000)),
    });
    expect(parseTrajectory(JSON.parse(trajectoryToJson(actual)))).toEqual(actual);
    expect(compare(actual, actual)).toEqual({ vendorsRecovered: 3, vendorsActual: 3, spendRecoveredBps: 10000, orderRecovered: true });
    // Against what the observer rebuilds from the Wakeless base layer: nothing.
    expect(compare(reconstruct(parsed(wakelessRaw)), actual)).toEqual({ vendorsRecovered: 0, vendorsActual: 3, spendRecoveredBps: 0, orderRecovered: false });
  });

  it("renders fundings, refunds and withdrawals, and reconciles the private balance with them", () => {
    const fundingSig = "5".repeat(88);
    const input: OwnerInput = {
      payer: RUN_1_BUYER,
      trajectory: [
        { vendor: "aurora", route: "fund", amount: "2000000", cumulative: "0", timestamp: "2026-11-03T10:00:00.000Z", fundingSource: { originChain: "base", amount: "2000000", solanaArrivalSignature: fundingSig } },
        { vendor: PRICE, route: "/price/SOL", amount: "1000", cumulative: "1001", timestamp: "2026-11-03T10:10:00.000Z", deposit: "100000", depositSignature: "4".repeat(88), fundingSource: "base" },
        { vendor: PRICE, route: "/price/BTC", amount: "1000", cumulative: "2002", timestamp: "2026-11-03T10:11:00.000Z" },
      ],
      channels: [
        {
          buyer: RUN_1_BUYER,
          vendor: PRICE,
          channelId: "chan",
          deposit: "100000",
          accepted: "2002",
          close: { state: "closed", refund: { amount: "97998", signature: "3".repeat(88), confirmedAt: "2026-11-03T11:00:00.000Z" }, withdraw: { performed: { amount: "50000", signature: "2".repeat(88), at: "2026-11-03T11:05:00.000Z" } } },
        },
      ],
      balances: [
        { at: "2026-11-03T10:05:00.000Z", balance: 1_000_000n, label: "before" },
        { at: "2026-11-03T11:10:00.000Z", balance: 947_998n, label: "after" },
      ],
    };
    const markdown = renderOwnerView(input);
    expect(markdown).toContain("| 2026-11-03 10:00:00Z | funding | — | 2000000 | Aurora Confidential Intents, from base, Solana arrival `5555…5555`;");
    expect(markdown).toContain("| 2026-11-03 11:00:00Z | refund | `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` | 97998 | private transfer from the escrow |");
    expect(markdown).toContain("| 2026-11-03 11:05:00Z | withdrawal |");
    expect(markdown).toContain("| `ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm` | 2 | 2000 | 2002 | 100000 | 97998 | 0 |");
    expect(markdown).toContain("1000000 − deposits 100000 + refunds 97998 − withdrawals 50000 = **947998**");
    expect(markdown).toContain("The reading at 2026-11-03 11:10:00Z matches.");
    expect(markdown).not.toMatch(BASE58_88);
    // A funding is not vendor spend.
    expect(ownerTrajectory(input).vendors).toEqual([PRICE]);
  });

  it("a vendor paid through a closed channel and then a new one sums both channels' cumulatives", () => {
    const input: OwnerInput = {
      trajectory: [
        { vendor: PRICE, route: "/price/SOL", amount: "1000", cumulative: "1001", timestamp: "2026-11-03T10:00:00.000Z", deposit: "100000" },
        { vendor: PRICE, route: "/price/SOL", amount: "1000", cumulative: "2002", timestamp: "2026-11-03T10:01:00.000Z" },
        { vendor: NEWS, route: "/news/SOL", amount: "3000", cumulative: "3003", timestamp: "2026-11-03T10:02:00.000Z", deposit: "300000" },
        { vendor: PRICE, route: "/price/SOL", amount: "1000", cumulative: "1001", timestamp: "2026-11-03T12:00:00.000Z", deposit: "100000" },
      ],
      channels: [],
      balances: [],
    };
    const actual = ownerTrajectory(input);
    expect(actual.spendPerVendor).toEqual({ [PRICE]: 3003n, [NEWS]: 3003n });
    expect(actual.firstContactOrder).toEqual([PRICE, NEWS]);
    expect(actual.payer).toBeUndefined();
  });

  it("readOwnerView reads getTrajectory() and appends a private-balance reading", async () => {
    const view = await readOwnerView({
      trajectory: { getTrajectory: () => JSON.parse(JSON.stringify(RUN_1)) as unknown[] },
      balance: { privateBalance: async () => 3_390_000n },
      history: [RUN_1_BEFORE],
      payer: RUN_1_BUYER,
      now: () => new Date("2026-11-01T19:26:00.000Z"),
    });
    expect(view.trajectory).toEqual(RUN_1);
    expect(view.balances).toEqual([RUN_1_BEFORE, { at: "2026-11-01T19:26:00.000Z", balance: 3_390_000n, label: "now" }]);
    expect(renderOwnerView(view)).toContain("The reading at 2026-11-01 19:26:00Z matches.");
  });

  it("parses the owner's channel file and keeps the buyer's channels only", () => {
    const file = {
      version: 1,
      channels: {
        a: { buyer: RUN_1_BUYER, vendor: PRICE, channelId: "a", deposit: "100000", accepted: "3003", close: null },
        b: { buyer: "other", vendor: NEWS, channelId: "b", deposit: "1", accepted: "0" },
      },
      trajectory: JSON.parse(JSON.stringify(RUN_1)) as unknown[],
    };
    const { channels, trajectory } = parseOwnerChannelFile(file, RUN_1_BUYER);
    expect(channels).toEqual([{ buyer: RUN_1_BUYER, vendor: PRICE, channelId: "a", deposit: "100000", accepted: "3003" }]);
    expect(trajectory).toEqual(RUN_1);
    expect(() => parseOwnerChannelFile({ version: 2, channels: {}, trajectory: [] })).toThrow(OwnerDataError);
  });

  it("the trajectory parser refuses bad entries and never throws anything but OwnerDataError", () => {
    expect(() => parseOwnerTrajectory([{ ...RUN_1[0], amount: "-1" }])).toThrow(OwnerDataError);
    expect(() => parseOwnerTrajectory([{ ...RUN_1[0], vendor: "not-an-address" }])).toThrow(OwnerDataError);
    expect(() => parseOwnerTrajectory([{ ...RUN_1[0], cumulative: "18446744073709551616" }])).toThrow(OwnerDataError);
    expect(() => parseOwnerTrajectory([{ ...RUN_1[1], deposit: undefined, depositSignature: "x" }])).toThrow(OwnerDataError);
    fc.assert(
      fc.property(fc.jsonValue(), (value) => {
        try {
          parseOwnerTrajectory(value);
          parseOwnerChannelFile(value);
        } catch (error) {
          if (!(error instanceof OwnerDataError)) throw error;
        }
      }),
    );
    fc.assert(
      fc.property(fc.array(fc.record({ vendor: fc.constantFrom(PRICE, NEWS, "aurora", "x"), route: fc.constantFrom("/price/SOL", "fund"), amount: fc.oneof(fc.bigInt({ min: 0n, max: 2n ** 64n }).map(String), fc.string()), cumulative: fc.bigInt({ min: 0n, max: 2n ** 64n }).map(String), timestamp: fc.oneof(fc.date({ noInvalidDate: true }).map((d) => d.toISOString()), fc.string()) })), (value) => {
        try {
          const trajectory = parseOwnerTrajectory(value);
          renderOwnerView({ trajectory, channels: [], balances: [] });
        } catch (error) {
          if (!(error instanceof OwnerDataError)) throw error;
        }
      }),
    );
  });
});
