// The wrapper against a vendor with the relationship-terms layer on (task 12.1T): a known
// buyer is quoted its terms on its first voucher and pays against them once more, the spend
// policy sees the quoted price, and later calls pay against the remembered terms first.
import { randomBytes } from "node:crypto";
import { publicKeyOf } from "@wakeless/scheme";
import { MemoryTermsHistory, x402Shielded } from "@wakeless/vendor";
import { Hono } from "hono";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { chargeOf, wrapFetchWithWakeless, type PendingPayment } from "../src/index.js";
import { PAYMENT_REQUIRED_HEADER } from "../src/parse.js";
import { fakeRail, paidEnvelopes, startFacilitator, tempStore, type Facilitator, type Seen } from "./harness.js";

const ROUTE = "/price/:symbol";
const URL_ = "http://vendor1.test/price/SOL";
const STANDARD = 1_000n;

let facilitator: Facilitator;
beforeAll(async () => {
  facilitator = await startFacilitator();
});
afterAll(async () => {
  await facilitator.close();
});

function termsVendor() {
  const signer = { secretKey: new Uint8Array(randomBytes(32)) };
  const payTo = publicKeyOf(signer);
  const history = new MemoryTermsHistory();
  const app = new Hono();
  app.use("*", x402Shielded({ facilitatorUrl: facilitator.url, payTo, amountPerRoute: { [ROUTE]: STANDARD.toString() }, terms: { signer, history } }));
  app.get(ROUTE, (c) => c.json({ served: true }));
  const seen: Seen[] = [];
  const doFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    seen.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), body: "" });
    return app.fetch(request);
  };
  return { payTo, history, seen, fetch: doFetch as typeof fetch };
}

const codes = (seen: readonly Seen[]) => seen.length;

describe("wrapFetchWithWakeless with relationship terms", () => {
  it("adopts the terms a vendor quotes, runs the policy at the quoted price and pays once more", async () => {
    const v = termsVendor();
    const buyerKeypair = new Uint8Array(randomBytes(32));
    const buyer = publicKeyOf({ secretKey: buyerKeypair });
    for (let p = 1; p <= 7; p++) v.history.redeemed({ channelId: publicKeyOf({ secretKey: new Uint8Array(randomBytes(32)) }), buyer, period: p, owed: 0n });
    const policy: PendingPayment[] = [];
    const logs: string[] = [];
    const rail = fakeRail();
    const pay = wrapFetchWithWakeless(v.fetch, { buyerKeypair, rail, channelStoreLocal: tempStore(), log: (l) => logs.push(l), beforePayment: (p) => void policy.push(p) });

    const first = await pay(URL_);
    expect(first.status).toBe(200);
    // Anonymous 402, the standard-terms attempt refused with the quote, the paid attempt: three requests.
    expect(codes(v.seen)).toBe(3);
    const envelopes = paidEnvelopes(v.seen);
    expect(envelopes.map((e) => e.payload.type)).toEqual(["deposit", "deposit"]);
    // The deposit was made once at the standard target and resent; the voucher moved to the buyer's price.
    expect(rail.calls).toHaveLength(1);
    expect(rail.calls[0]!.amount).toBe(STANDARD * 20n);
    expect(envelopes[0]!.payload.voucher.maxClaimableAmount).toBe(chargeOf(STANDARD, 10).toString());
    expect(envelopes[1]!.payload.voucher.maxClaimableAmount).toBe(chargeOf(825n, 10).toString());
    // The spend policy saw both prices, the quoted one last.
    expect(policy.map((p) => p.amount)).toEqual([STANDARD, 825n]);
    const [entry] = pay.getTrajectory();
    expect(entry).toMatchObject({ amount: "825", cumulative: chargeOf(825n, 10).toString(), deposit: (STANDARD * 20n).toString() });
    expect(pay.getChannels()[0]!.accept?.amount).toBe("825");
    expect(pay.getChannels()[0]!.accept?.extra.termsReceipt).toBeDefined();
    expect(logs.some((l) => l.startsWith("terms quoted for channel"))).toBe(true);
    for (const line of logs) expect(line).not.toMatch(/825|4950|termsReceipt/);

    // The next call pays against the remembered terms first: anonymous 402, then paid. Two requests.
    v.seen.length = 0;
    expect((await pay(URL_)).status).toBe(200);
    expect(codes(v.seen)).toBe(2);
    expect(paidEnvelopes(v.seen).map((e) => e.payload.type)).toEqual(["voucher"]);
    expect(pay.getTrajectory().at(-1)).toMatchObject({ amount: "825" });

    // The vendor's history moved (one more clean period, 2000 bps): the remembered terms are corrected once, then paid.
    v.history.redeemed({ channelId: pay.getChannels()[0]!.channelId, period: 1, owed: 0n });
    v.seen.length = 0;
    expect((await pay(URL_)).status).toBe(200);
    expect(codes(v.seen)).toBe(3);
    expect(pay.getTrajectory().at(-1)).toMatchObject({ amount: "800" });
    expect(pay.getChannels()[0]!.accept?.amount).toBe("800");
    // The facilitator agrees on the watermark: 826 + 826 + 801 fee-inclusive steps.
    const record = await facilitator.stores.channels.get(pay.getChannels()[0]!.channelId);
    expect(record?.accepted).toBe(826n + 826n + 801n);
  });

  it("an unknown buyer pays standard terms on the first try and a quote is adopted at most once", async () => {
    const v = termsVendor();
    const pay = wrapFetchWithWakeless(v.fetch, { buyerKeypair: new Uint8Array(randomBytes(32)), rail: fakeRail(), channelStoreLocal: tempStore() });
    expect((await pay(URL_)).status).toBe(200);
    expect(codes(v.seen)).toBe(2);
    expect(pay.getTrajectory()[0]).toMatchObject({ amount: STANDARD.toString(), deposit: (STANDARD * 20n).toString() });
    // The standard-terms receipt for an unknown buyer is kept with the channel too.
    expect(pay.getChannels()[0]!.accept?.extra.termsReceipt).toBeDefined();

    // A vendor that answers shielded_terms_quoted to every payment gets one retry, then its refusal comes back unpaid.
    const quoting = new Hono();
    let payments = 0;
    quoting.all("*", async (c) => {
      if (c.req.header("payment-signature") === undefined) return v.fetch(new Request(c.req.raw));
      payments++;
      // The same quote the anonymous 402 gives, under the terms code: nothing is forwarded or served.
      const anon = await v.fetch(new Request(URL_));
      const header = Buffer.from(JSON.stringify({ ...(JSON.parse(Buffer.from(anon.headers.get(PAYMENT_REQUIRED_HEADER)!, "base64").toString("utf8")) as object), error: "shielded_terms_quoted" })).toString("base64");
      return new Response(JSON.stringify({ error: "quoted", code: "shielded_terms_quoted", retryable: true }), { status: 402, headers: { "content-type": "application/json", [PAYMENT_REQUIRED_HEADER]: header } });
    });
    const stubborn = wrapFetchWithWakeless(((i: string | URL | Request, init?: RequestInit) => quoting.fetch(new Request(i, init))) as typeof fetch, { buyerKeypair: new Uint8Array(randomBytes(32)), rail: fakeRail(), channelStoreLocal: tempStore() });
    const res = await stubborn(URL_);
    expect(res.status).toBe(402);
    expect(payments).toBe(2);
    expect(stubborn.getTrajectory()).toEqual([]);
  });
});
