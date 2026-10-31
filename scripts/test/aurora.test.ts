import fc from "fast-check";
import { describe, expect, it } from "vitest";
import {
  type AuroraToken,
  buildQuoteRequest,
  findUsdc,
  formatUnits,
  parseTokens,
  redactKey,
  redactReferral,
  renderDoc,
  runDryRun,
} from "../lib/aurora.js";

const KEY = "test-key-not-real";
const NOW = new Date("2026-10-31T12:00:00.000Z");

const usdc = (blockchain: string, assetId = `nep141:${blockchain}-usdc`): AuroraToken => ({
  assetId,
  decimals: 6,
  blockchain,
  symbol: "USDC",
});
const TOKENS = [usdc("base"), usdc("near"), usdc("sol")];

function json(status: number, body: unknown): Response {
  return new Response(JSON.stringify(body), { status });
}

/** Answers per path; records every call. The status route echoes its path, as Aurora's errors do. */
type QuoteBody = { originAsset: string; dry: boolean };

function fakeFetch(quote: (body: QuoteBody) => Response = () => json(200, { quote: {} })) {
  const calls: { url: string; init?: RequestInit }[] = [];
  const fetch = (async (input: string | URL | Request, init?: RequestInit) => {
    const url = String(input);
    calls.push({ url, init });
    if (url.includes("/api/tokens/")) return json(200, { tokens: TOKENS });
    if (url.includes("/api/quote/")) return quote(JSON.parse(String(init?.body)) as QuoteBody);
    return json(400, { message: "not found", path: new URL(url).pathname });
  }) as typeof globalThis.fetch;
  return { fetch, calls };
}

describe("aurora dry-run", () => {
  it("every quote is dry, confidential, 5 USDC, with a 20 minute deadline", () => {
    const request = buildQuoteRequest({
      origin: usdc("base"),
      destination: usdc("sol"),
      recipient: "fresh",
      refundTo: "0xplaceholder",
      now: NOW,
    });
    expect(request).toMatchObject({
      dry: true,
      confidentiality: "advanced",
      swapType: "EXACT_INPUT",
      amount: "5000000",
      depositType: "ORIGIN_CHAIN",
      recipientType: "DESTINATION_CHAIN",
      refundType: "ORIGIN_CHAIN",
      slippageTolerance: 100,
      deadline: "2026-10-31T12:20:00.000Z",
    });
  });

  it("takes asset ids from the token list and sends one quote per origin", async () => {
    const { fetch, calls } = fakeFetch();
    const result = await runDryRun({ apiKey: KEY, fetch, now: () => NOW });

    const bodies = calls
      .filter((c) => c.url.includes("/api/quote/"))
      .map((c) => JSON.parse(String(c.init?.body)) as Record<string, unknown>);
    expect(bodies.map((b) => b.originAsset)).toEqual(["nep141:base-usdc", "nep141:near-usdc"]);
    expect(bodies.every((b) => b.dry === true && b.destinationAsset === "nep141:sol-usdc")).toBe(true);
    expect(bodies[0]!.recipient).not.toEqual(bodies[1]!.recipient);
    expect(String(bodies[0]!.refundTo).toLowerCase()).not.toContain("dead");
    expect(result.statusProbes).toHaveLength(2);
  });

  it("a rejected route is an answer; a 404, 429 or 500 stops the run", async () => {
    const rejected = fakeFetch(() => json(400, { message: "route not supported" }));
    const result = await runDryRun({ apiKey: KEY, fetch: rejected.fetch, now: () => NOW });
    expect(renderDoc(result)).toContain("**Base: not established.** The request was rejected with 400: route not supported");

    for (const status of [404, 429, 500]) {
      const { fetch } = fakeFetch(() => json(status, { message: "nope" }));
      await expect(runDryRun({ apiKey: KEY, fetch, now: () => NOW })).rejects.toThrow(`answered ${status}`);
    }
  });

  it("a response that echoes the key never reaches the document or an error", async () => {
    const echoing = fakeFetch(() => json(400, { message: "bad", path: `/api/quote/${KEY}` }));
    const doc = renderDoc(await runDryRun({ apiKey: KEY, fetch: echoing.fetch, now: () => NOW }));
    expect(doc).toContain("/api/quote/[redacted]");
    expect(doc).not.toContain(KEY);

    const unassigned = (async (input: string | URL | Request) =>
      json(404, { message: "unassigned", path: new URL(String(input)).pathname })) as typeof globalThis.fetch;
    const error = await runDryRun({ apiKey: KEY, fetch: unassigned, now: () => NOW }).catch((e: Error) => e);
    expect(String(error)).not.toContain(KEY);

    const down = (async () => {
      throw new Error(`connect failed for /api/tokens/${KEY}`);
    }) as typeof globalThis.fetch;
    const failure = await runDryRun({ apiKey: KEY, fetch: down, now: () => NOW }).catch((e: Error) => e);
    expect(String(failure)).not.toContain(KEY);
  });

  it("the referral is redacted at the boundary, at any depth", async () => {
    const { fetch } = fakeFetch(() =>
      json(200, { quoteRequest: { referral: "aurora-acct" }, quote: {}, nested: [{ referral: "aurora-acct" }] }),
    );
    const result = await runDryRun({ apiKey: KEY, fetch, now: () => NOW });
    expect(JSON.stringify(result)).not.toContain("aurora-acct");
    expect(renderDoc(result)).not.toContain("aurora-acct");
    expect(redactReferral({ a: [{ referral: "x", keep: 1 }], referral: "y" })).toEqual({
      a: [{ referral: "[redacted]", keep: 1 }],
      referral: "[redacted]",
    });
  });

  it("--live-quote sends exactly one dry:false quote, from NEAR, and keeps four fields", async () => {
    const live = {
      signature: "ed25519:secretish",
      quote: { depositAddress: "dep.near", deadline: "2026-10-31T12:20:00.000Z", timeWhenInactive: "t", amountOut: "1" },
    };
    const { fetch, calls } = fakeFetch((body) => json(200, body.dry ? { quote: {} } : live));
    const result = await runDryRun({ apiKey: KEY, fetch, now: () => NOW }, { liveQuote: true });

    const bodies = calls
      .filter((c) => c.url.includes("/api/quote/"))
      .map((c) => JSON.parse(String(c.init?.body)) as { dry: boolean; originAsset: string });
    expect(bodies.map((b) => b.dry)).toEqual([true, true, false]);
    expect(bodies[2]!.originAsset).toBe("nep141:near-usdc");
    expect(result.liveQuote).toEqual({
      origin: "NEAR",
      status: 200,
      fields: { depositAddress: "dep.near", depositMemo: undefined, deadline: "2026-10-31T12:20:00.000Z", timeWhenInactive: "t" },
    });
    expect(JSON.stringify(result)).not.toContain("secretish");
    expect(renderDoc(result)).toContain("`quote.depositAddress` `dep.near`");

    const off = await runDryRun({ apiKey: KEY, fetch: fakeFetch().fetch, now: () => NOW });
    expect(off.liveQuote).toBeUndefined();
    expect(renderDoc(off)).toContain("--live-quote");
  });

  it("costs are computed from the response in integer units", async () => {
    const { fetch } = fakeFetch(() =>
      json(200, { quote: { amountIn: "5000000", amountOut: "4741878", withdrawFee: "255510" } }),
    );
    const doc = renderDoc(await runDryRun({ apiKey: KEY, fetch, now: () => NOW }));
    expect(doc).toContain(
      "- **Base:** 5.000000 USDC in, 4.741878 USDC out. `withdrawFee` 0.255510 USDC (5.11% of the input); total spread 0.258122 USDC (5.16%).",
    );
    expect(formatUnits(5n, 6)).toBe("0.000005");
    expect(formatUnits(123n, 0)).toBe("123");

    const bare = renderDoc(await runDryRun({ apiKey: KEY, fetch: fakeFetch().fetch, now: () => NOW }));
    expect(bare).toContain("No quote answered 200, so no cost is observed.");
  });

  it("findUsdc refuses zero or several matches", () => {
    expect(findUsdc(TOKENS, "base").assetId).toBe("nep141:base-usdc");
    expect(() => findUsdc(TOKENS, "arb")).toThrow("found: none");
    expect(() => findUsdc([usdc("near", "a"), usdc("near", "b")], "near")).toThrow("found: a, b");
  });

  it("parseTokens never throws on an object with a tokens array and keeps only well-formed entries", () => {
    fc.assert(
      fc.property(fc.array(fc.anything()), (tokens) => {
        for (const t of parseTokens({ tokens })) {
          expect(typeof t.assetId).toBe("string");
          expect(Number.isInteger(t.decimals)).toBe(true);
        }
      }),
    );
  });

  it("parseTokens refuses any body with no tokens array", () => {
    fc.assert(
      fc.property(fc.anything(), (body) => {
        fc.pre(!Array.isArray((body as { tokens?: unknown } | null | undefined)?.tokens));
        expect(() => parseTokens(body)).toThrow("no tokens array");
      }),
    );
  });

  it("redactKey removes every occurrence", () => {
    expect(redactKey(`a ${KEY} b ${KEY}`, KEY)).toBe("a [redacted] b [redacted]");
  });
});
