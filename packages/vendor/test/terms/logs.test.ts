// Nothing of a terms receipt reaches a log (CLAUDE.md, Relationship terms): not the vendor's
// (the middleware logs nothing), not the facilitator's, not the console.
import { randomBytes } from "node:crypto";
import { createDepositHandler, createFacilitatorApp, createMemoryStores } from "@wakeless/facilitator";
import { publicKeyOf } from "@wakeless/scheme";
import { Hono } from "hono";
import { afterEach, describe, expect, it, vi } from "vitest";
import { MemoryTermsHistory, x402Shielded, type TermsReceipt } from "../../src/index.js";
import { TEE_VALIDATOR, decodeRequired, fakeBinding, fundedBuyer, listen, shieldedEntry } from "../fixtures.js";

const ROUTE = "/price/:symbol";
const RESOURCE = "http://vendor.test/price/SOL";
const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  vi.restoreAllMocks();
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

describe("terms and logs", () => {
  it("no terms receipt appears in logs", async () => {
    const console_: string[] = [];
    for (const method of ["log", "info", "warn", "error", "debug"] as const) {
      vi.spyOn(console, method).mockImplementation((...args: unknown[]) => void console_.push(args.map(String).join(" ")));
    }
    const stdout: string[] = [];
    vi.spyOn(process.stdout, "write").mockImplementation(((chunk: unknown) => {
      stdout.push(String(chunk));
      return true;
    }) as typeof process.stdout.write);

    const facilitatorLog: string[] = [];
    const binding = fakeBinding();
    const stores = createMemoryStores();
    const facilitator = createFacilitatorApp({ binding: { status: "ready", binding, teeValidator: TEE_VALIDATOR }, stores, deposits: createDepositHandler({ binding, stores, log: (line) => facilitatorLog.push(line) }), log: (line) => facilitatorLog.push(line) });
    const served = await listen(facilitator.fetch);
    cleanups.push(served.close);

    const signer = { secretKey: new Uint8Array(randomBytes(32)) };
    const history = new MemoryTermsHistory();
    const app = new Hono();
    app.use("*", x402Shielded({ facilitatorUrl: served.url, payTo: publicKeyOf(signer), amountPerRoute: { [ROUTE]: "1000" }, terms: { signer, history } }));
    app.get(ROUTE, (c) => c.json({ price: 1 }));

    const standard = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    const receipt = standard.extra.termsReceipt as unknown as TermsReceipt;
    const buyer = await fundedBuyer({ url: served.url, stores, close: served.close }, standard);
    for (let p = 1; p <= 3; p++) history.redeemed({ channelId: buyer.channelId, buyer: buyer.buyerAddress, period: p, owed: 0n });
    const quoted = await app.request(RESOURCE, { headers: buyer.payment(1001n, standard) });
    expect(quoted.status).toBe(402);
    const mine = shieldedEntry(decodeRequired(quoted));
    const paid = await app.request(RESOURCE, { headers: buyer.payment(BigInt(mine.amount) + 1n, mine) });
    expect(paid.status).toBe(200);

    const everything = [...console_, ...stdout, ...facilitatorLog].join("\n");
    expect(facilitatorLog.length).toBeGreaterThan(0);
    for (const forbidden of ["termsReceipt", "inputsDigest", "relationship capital", receipt.vendorSignature, (mine.extra.termsReceipt as unknown as TermsReceipt).vendorSignature, receipt.inputsDigest]) {
      expect(everything).not.toContain(forbidden);
    }
    // No signature and no bearer token either (CLAUDE.md, Secrets).
    expect(everything).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
    expect(everything).not.toMatch(/bearer/i);
  });
});
