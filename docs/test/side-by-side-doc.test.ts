import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const DOCS = join(import.meta.dirname, "..");

describe("docs/side-by-side.md", () => {
  it("side-by-side.md carries both headline numbers for both rails", () => {
    const text = readFileSync(join(DOCS, "side-by-side.md"), "utf8");

    // The headline table: one row per number, one column per rail.
    const perCall = /^\| Base-layer transactions per call \| (\d+) \/ (\d+) = (\d+\.\d{2}) \| (\d+) \/ (\d+) = (\d+\.\d{2}) \|$/m.exec(text);
    expect(perCall, "transactions per call row").not.toBeNull();
    const [, pTx, pCalls, pPer, wTx, wCalls, wPer] = perCall!;
    expect(Number(pCalls)).toBe(30);
    expect(Number(wCalls)).toBe(30);
    expect(pPer).toBe((Number(pTx) / Number(pCalls)).toFixed(2));
    expect(wPer).toBe((Number(wTx) / Number(wCalls)).toFixed(2));
    expect(Number(pTx)).toBeGreaterThan(0);
    expect(Number(wTx)).toBe(0);

    const vendors = /^\| Vendors recovered \/ actual \| (\d+) \/ (\d+) \| (\d+) \/ (\d+) \|$/m.exec(text);
    expect(vendors, "vendors recovered row").not.toBeNull();
    const [, pRec, pAct, wRec, wAct] = vendors!.map(Number);
    expect(pAct).toBe(3);
    expect(wAct).toBe(3);
    expect(pRec).toBe(pAct);
    expect(wRec).toBe(0);

    // Each rail's section repeats both numbers, so each appears twice in all.
    const sectionPerCall = [...text.matchAll(/^\*\*Base-layer transactions per call: (\d+) \/ (\d+) = (\d+\.\d{2})\*\*$/gm)].map((m) => `${m[1]} / ${m[2]} = ${m[3]}`);
    expect(sectionPerCall).toEqual([`${pTx} / ${pCalls} = ${pPer}`, `${wTx} / ${wCalls} = ${wPer}`]);
    const sectionVendors = [...text.matchAll(/^\*\*Vendors recovered \/ actual: (\d+) \/ (\d+)\*\*$/gm)].map((m) => `${m[1]} / ${m[2]}`);
    expect(sectionVendors).toEqual([`${pRec} / ${pAct}`, `${wRec} / ${wAct}`]);
    // And compare()'s own table under each rail agrees.
    const compared = [...text.matchAll(/^\| Vendors recovered \/ actual \| (\d+ \/ \d+) \|$/gm)].map((m) => m[1]);
    expect(compared).toEqual([`${pRec} / ${pAct}`, `${wRec} / ${wAct}`]);
  });

  it("side-by-side.md names the three operators and does not fall back silently", () => {
    const text = readFileSync(join(DOCS, "side-by-side.md"), "utf8");
    expect(text).toMatch(/facilitator sees the vouchers/);
    expect(text).toMatch(/MagicBlock's enclave sees the private transfers/);
    expect(text).toMatch(/NEAR's private shard/);
    expect(text).toMatch(/base layer shows vault deposits and withdrawals only/);
    // A run that fell back to docs/public-rail-log.md says so in bold at the top.
    if (/fell back|public-from-log/.test(text)) expect(text).toMatch(/\*\*The public rail was not driven in this run\.\*\*/);
  });
});
