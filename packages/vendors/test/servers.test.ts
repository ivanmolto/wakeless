import { X402_VERSION, type PaymentRequirements } from "@wakeless/scheme";
import { PAYMENT_RESPONSE_HEADER } from "@wakeless/vendor";
import { afterEach, describe, expect, it } from "vitest";
import { address, decodeRequired, fundedBuyer, shieldedEntry, startFacilitator, type InProcessFacilitator } from "../../vendor/test/fixtures.js";
import { SYMBOL, VENDORS, createVendorApp, newsFeed, priceFeed, sentimentFeed, startVendors, type PricePoint } from "../src/index.js";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function facilitator(): Promise<InProcessFacilitator> {
  const started = await startFacilitator();
  cleanups.push(started.close);
  return started;
}

const vendor1 = VENDORS[0]!;

/** Pays for `path` on a fresh channel and returns the response. */
async function pay(f: InProcessFacilitator, seed: string, payTo: string, salt: string, path: string) {
  const app = createVendorApp(vendor1, { facilitatorUrl: f.url, payTo, seed });
  const url = `http://vendor.test${path}`;
  const accept: PaymentRequirements = shieldedEntry(decodeRequired(await app.request(url)));
  const buyer = await fundedBuyer(f, accept, salt);
  return app.request(url, { headers: buyer.payment(BigInt(accept.amount) + 1n) });
}

describe("vendors", () => {
  it("three vendors start on distinct ports and each returns 402 unpaid", async () => {
    const f = await facilitator();
    const running = await startVendors(
      VENDORS.map((definition) => ({ definition, payTo: address(), port: 0 })),
      { facilitatorUrl: f.url, seed: "test" },
    );
    cleanups.push(running.close);

    expect(new Set(running.vendors.map((v) => v.port)).size).toBe(3);
    expect(new Set(VENDORS.map((v) => v.defaultPort)).size).toBe(3);
    expect(new Set(running.vendors.map((v) => v.payTo)).size).toBe(3);

    // Concurrently, over real sockets.
    const responses = await Promise.all(running.vendors.map((v) => fetch(`${v.url}${v.route.replace(":symbol", "SOLX")}`)));
    responses.forEach((res, i) => {
      const definition = VENDORS[i]!;
      expect(res.status).toBe(402);
      const required = decodeRequired(res);
      expect(required.x402Version).toBe(X402_VERSION);
      const entry = shieldedEntry(required);
      expect(entry.payTo).toBe(running.vendors[i]!.payTo);
      expect(entry.amount).toBe(definition.amount);
    });
  });

  it("a taken port fails the whole start and closes what had started", async () => {
    const f = await facilitator();
    const first = await startVendors([{ definition: vendor1, payTo: address(), port: 0 }], { facilitatorUrl: f.url, seed: "test" });
    cleanups.push(first.close);
    await expect(
      startVendors(
        [
          { definition: VENDORS[1]!, payTo: address(), port: 0 },
          { definition: VENDORS[2]!, payTo: address(), port: first.vendors[0]!.port },
        ],
        { facilitatorUrl: f.url, seed: "test" },
      ),
    ).rejects.toThrow(/EADDRINUSE/);
  });

  it("vendor data is deterministic for a seed", async () => {
    const f = await facilitator();
    const payTo = address();
    const [a, b, other] = await Promise.all([
      pay(f, "seed-1", payTo, "1", "/price/SOLX"),
      pay(f, "seed-1", payTo, "2", "/price/SOLX"),
      pay(f, "seed-2", payTo, "3", "/price/SOLX"),
    ]);
    expect(a.status).toBe(200);
    expect(a.headers.get(PAYMENT_RESPONSE_HEADER)).not.toBeNull();
    const [bodyA, bodyB, bodyOther] = (await Promise.all([a.json(), b.json(), other.json()])) as PricePoint[];
    expect(bodyA).toEqual(bodyB);
    expect(bodyA!.symbol).toBe("SOLX");
    expect(bodyA!.synthetic).toBe(true);
    expect(bodyOther!.price).not.toBe(bodyA!.price);

    for (const feed of [priceFeed, sentimentFeed, newsFeed]) {
      const [one, two] = [feed("s"), feed("s")];
      expect([one("SOLX"), one("SOLX"), one("ABCD")]).toEqual([two("SOLX"), two("SOLX"), two("ABCD")]);
    }
  });

  it("the price walks in small steps and each feed is plausible", () => {
    const feed = priceFeed("walk");
    let previous = feed("SOLX");
    expect(previous.price).toBeGreaterThanOrEqual(1);
    expect(previous.price).toBeLessThan(500);
    for (let i = 1; i <= 200; i += 1) {
      const point = feed("SOLX");
      expect(point.step).toBe(i);
      expect(Math.abs(point.price / previous.price - 1)).toBeLessThanOrEqual(0.0151);
      previous = point;
    }
    const mood = sentimentFeed("walk")("SOLX");
    expect(mood.sentiment).toBeGreaterThanOrEqual(-1);
    expect(mood.sentiment).toBeLessThanOrEqual(1);
    const news = newsFeed("walk")("SOLX");
    expect(news.items).toHaveLength(3);
    for (const item of news.items) expect(item.headline).toContain("SOLX");
  });

  it("a bad symbol is a 400 and costs nothing", async () => {
    const f = await facilitator();
    const payTo = address();
    const app = createVendorApp(vendor1, { facilitatorUrl: f.url, payTo, seed: "test" });
    const url = "http://vendor.test/price/not-a-symbol";
    expect(SYMBOL.test("NOT-A-SYMBOL")).toBe(false);
    const accept = shieldedEntry(decodeRequired(await app.request(url)));
    const buyer = await fundedBuyer(f, accept);

    const res = await app.request(url, { headers: buyer.payment(BigInt(accept.amount) + 1n) });
    expect(res.status).toBe(400);
    expect(res.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(0n);
  });
});
