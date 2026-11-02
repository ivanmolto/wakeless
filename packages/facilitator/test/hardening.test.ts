// Task 6.3: the hardening of the facilitator's HTTP surface. Idempotent /settle by
// payload hash, unknown channels refused, the verify-to-settle window, the per-IP and
// per-channel rate limits, and GET /health. In process over the binding fake of
// `fixtures.ts`; nothing is transferred and nothing private is simulated.
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { SCHEME_ERROR_CODES, SCHEME_ID, type SettlementResponse } from "@wakeless/scheme";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { DEFAULT_RATE_LIMITS, RateLimiter, createFacilitatorApp, createMemoryStores, parseRateRule, type FacilitatorOptions, type HealthResponse, type Stores } from "../src/index.js";
import { CHARGE, DEPOSIT, envelope, fakeBinding, ready, scenario, voucherPayload, type Scenario } from "./fixtures.js";

type Body = Record<string, unknown> & { error?: string; code?: string; retryable?: boolean };

interface Harness {
  app: Hono;
  stores: Stores;
  s: Scenario;
  clock: { now: number };
}

async function harness(options: Partial<FacilitatorOptions> = {}, seed = true): Promise<Harness> {
  const binding = fakeBinding();
  const s = scenario(binding.escrowAddress());
  const stores = createMemoryStores();
  if (seed) await stores.channels.put(s.record);
  const clock = { now: 1_700_000_100 };
  const app = createFacilitatorApp({ binding: ready(binding), stores, now: () => clock.now, ...options });
  return { app, stores, s, clock };
}

async function post(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: Body }> {
  const res = await app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Body };
}

async function get(app: Hono, path: string, headers: Record<string, string> = {}): Promise<{ status: number; headers: Headers; body: Body }> {
  const res = await app.request(path, { headers });
  return { status: res.status, headers: res.headers, body: (await res.json()) as Body };
}

describe("facilitator hardening", () => {
  it("duplicate settle returns the stored result with replayed true", async () => {
    const h = await harness();
    const body = envelope(h.s, voucherPayload(h.s, CHARGE));
    expect((await post(h.app, "/verify", body)).body.isValid).toBe(true);

    const first = await post(h.app, "/settle", body);
    expect(first.status).toBe(200);
    expect(first.body.success).toBe(true);
    expect(first.body.extra).not.toHaveProperty("replayed");

    // The same bytes again, and again: the stored result each time, the watermark unmoved.
    for (let i = 0; i < 3; i++) {
      const again = await post(h.app, "/settle", body);
      expect(again.status).toBe(200);
      const { extra: firstExtra, ...firstRest } = first.body as unknown as SettlementResponse;
      const { extra: againExtra, ...againRest } = again.body as unknown as SettlementResponse;
      expect(againRest).toEqual(firstRest);
      expect(againExtra).toEqual({ ...firstExtra, replayed: true });
    }
    // Key order in the envelope does not matter: the hash is over canonical JSON.
    const reordered = { paymentRequirements: body.paymentRequirements, paymentPayload: { payload: body.paymentPayload.payload, accepted: body.paymentPayload.accepted, x402Version: 2 }, x402Version: 2 };
    expect((await post(h.app, "/settle", reordered)).body.extra).toMatchObject({ replayed: true });

    const stored = await h.stores.channels.get(h.s.channelId);
    expect(stored?.accepted).toBe(CHARGE);
    expect(await h.stores.operations.list(h.s.channelId)).toEqual([]);
  });

  it("a voucher for an unknown channel is rejected", async () => {
    const h = await harness();
    const unknown = scenario(h.s.escrow); // Same escrow, a buyer and salt no record was ever put for.
    const body = envelope(unknown, voucherPayload(unknown, CHARGE));

    const verify = await post(h.app, "/verify", body);
    expect(verify.status).toBe(200);
    expect(verify.body).toMatchObject({ isValid: false, invalidReason: SCHEME_ERROR_CODES.channelState, code: SCHEME_ERROR_CODES.channelState, retryable: false, payer: unknown.buyerAddress });
    // Nothing a seller could copy onto a corrective 402: the facilitator holds no record.
    expect(verify.body.extra).toBeUndefined();

    const settle = await post(h.app, "/settle", body);
    expect(settle.status).toBe(200);
    expect(settle.body).toMatchObject({ success: false, errorReason: SCHEME_ERROR_CODES.channelState, code: SCHEME_ERROR_CODES.channelState, transaction: "", network: DEVNET_CAIP2 });

    expect(await h.stores.channels.get(unknown.channelId)).toBeUndefined();
    expect((await h.stores.channels.list()).map((r) => r.channelId)).toEqual([h.s.channelId]);
  });

  it("settle after maxTimeoutSeconds since verify is rejected", async () => {
    const h = await harness();
    const body = envelope(h.s, voucherPayload(h.s, CHARGE));
    const window = h.s.requirements.maxTimeoutSeconds;

    await post(h.app, "/verify", body);
    h.clock.now += window; // Exactly at expiry: gone.
    const late = await post(h.app, "/settle", body);
    expect(late.status).toBe(200);
    expect(late.body).toMatchObject({ success: false, errorReason: SCHEME_ERROR_CODES.shieldedVerifyRequired, retryable: false, payer: h.s.buyerAddress });
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(0n);

    // A fresh verify re-opens the window; one second short of it, the settle lands.
    await post(h.app, "/verify", body);
    h.clock.now += window - 1;
    const inTime = await post(h.app, "/settle", body);
    expect(inTime.body.success).toBe(true);
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(CHARGE);

    // Once settled, the window no longer matters: the stored result answers.
    h.clock.now += window * 10;
    expect((await post(h.app, "/settle", body)).body.extra).toMatchObject({ replayed: true });
  });

  it("rate limits return 429 per IP and per channel", async () => {
    const ipOf = (c: { req: { header: (name: string) => string | undefined } }) => c.req.header("x-test-ip");

    // Per IP: every request counts, before the body is read.
    const byIp = await harness({ rateLimits: { perIp: { limit: 3, windowSeconds: 60 }, perChannel: false }, clientAddress: ipOf });
    for (let i = 0; i < 3; i++) expect((await get(byIp.app, "/supported", { "x-test-ip": "10.0.0.1" })).status).toBe(200);
    const limited = await get(byIp.app, "/supported", { "x-test-ip": "10.0.0.1" });
    expect(limited.status).toBe(429);
    expect(limited.body).toEqual({ error: expect.any(String), code: SCHEME_ERROR_CODES.shieldedRateLimited, retryable: true });
    expect(Number(limited.headers.get("retry-after"))).toBeGreaterThan(0);
    expect(Number(limited.headers.get("retry-after"))).toBeLessThanOrEqual(60);
    // A settle over the limit is refused before anything is parsed, and nothing moves.
    const body = envelope(byIp.s, voucherPayload(byIp.s, CHARGE));
    expect((await post(byIp.app, "/settle", body, { "x-test-ip": "10.0.0.1" })).status).toBe(429);
    expect((await byIp.stores.channels.get(byIp.s.channelId))?.accepted).toBe(0n);
    // Another address is not affected; a request with no address is not counted.
    expect((await get(byIp.app, "/supported", { "x-test-ip": "10.0.0.2" })).status).toBe(200);
    expect((await get(byIp.app, "/supported")).status).toBe(200);
    // The window passes and the address is allowed again.
    byIp.clock.now += 60;
    expect((await get(byIp.app, "/supported", { "x-test-ip": "10.0.0.1" })).status).toBe(200);

    // Per channel: /verify and /settle count against the channel the payload derives, whatever the address.
    const byChannel = await harness({ rateLimits: { perIp: false, perChannel: { limit: 2, windowSeconds: 60 } } });
    const other = scenario(byChannel.s.escrow);
    await byChannel.stores.channels.put(other.record);
    const first = envelope(byChannel.s, voucherPayload(byChannel.s, CHARGE));
    expect((await post(byChannel.app, "/verify", first)).body.isValid).toBe(true);
    expect((await post(byChannel.app, "/settle", first)).body.success).toBe(true);
    const next = envelope(byChannel.s, voucherPayload(byChannel.s, CHARGE * 2n));
    const third = await post(byChannel.app, "/verify", next);
    expect(third.status).toBe(429);
    expect(third.body).toMatchObject({ code: SCHEME_ERROR_CODES.shieldedRateLimited, retryable: true });
    expect(third.headers.get("retry-after")).not.toBeNull();
    // The other channel still gets through; the limited one stays where it was.
    expect((await post(byChannel.app, "/verify", envelope(other, voucherPayload(other, CHARGE)))).body.isValid).toBe(true);
    expect((await byChannel.stores.channels.get(byChannel.s.channelId))?.accepted).toBe(CHARGE);
    byChannel.clock.now += 60;
    expect((await post(byChannel.app, "/verify", next)).body.isValid).toBe(true);

    // The defaults are on unless switched off; a malformed envelope is a 400 even over a channel limit, since it names no channel.
    expect(DEFAULT_RATE_LIMITS.perIp.limit).toBeGreaterThan(0);
    expect(DEFAULT_RATE_LIMITS.perChannel.limit).toBeGreaterThan(0);
    const malformed = await post(byChannel.app, "/verify", { x402Version: 1 });
    expect(malformed.status).toBe(400);
  });

  it("GET /health returns 200", async () => {
    const h = await harness();
    h.clock.now += 5;
    const res = await get(h.app, "/health");
    expect(res.status).toBe(200);
    expect(res.headers.get("cache-control")).toBe("no-store");
    expect(res.body).toEqual({ status: "ok", binding: "ready", scheme: SCHEME_ID, network: DEVNET_CAIP2, uptimeSeconds: 5 } satisfies HealthResponse);
    // No channel, amount, address or key leaves through the health body.
    expect(JSON.stringify(res.body)).not.toContain(h.s.channelId);
    expect(JSON.stringify(res.body)).not.toContain(DEPOSIT.toString());

    // Alive with a failed attestation too: a vendor can tell "down" from "refusing".
    const failed = createFacilitatorApp({ binding: { status: "attestation_failed", error: "verifier returned false" }, stores: createMemoryStores() });
    const down = await get(failed, "/health");
    expect(down.status).toBe(200);
    expect(down.body).toMatchObject({ status: "ok", binding: "attestation_failed", network: null });
    expect(JSON.stringify(down.body)).not.toContain("verifier returned false");
  });

  it("rate rules parse from the environment and count fixed windows", () => {
    expect(parseRateRule(undefined, DEFAULT_RATE_LIMITS.perIp)).toEqual(DEFAULT_RATE_LIMITS.perIp);
    expect(parseRateRule("", DEFAULT_RATE_LIMITS.perIp)).toEqual(DEFAULT_RATE_LIMITS.perIp);
    expect(parseRateRule("off", DEFAULT_RATE_LIMITS.perIp)).toBe(false);
    expect(parseRateRule(" 20 / 5 ", DEFAULT_RATE_LIMITS.perIp)).toEqual({ limit: 20, windowSeconds: 5 });
    for (const bad of ["20", "a/b", "0/60", "20/0", "-1/60"]) expect(() => parseRateRule(bad, DEFAULT_RATE_LIMITS.perIp), bad).toThrow();

    let now = 1000;
    const limiter = new RateLimiter({ limit: 2, windowSeconds: 10 }, () => now);
    expect(limiter.hit("a")).toEqual({ allowed: true });
    expect(limiter.hit("a")).toEqual({ allowed: true });
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 10 });
    now += 7;
    expect(limiter.hit("a")).toEqual({ allowed: false, retryAfterSeconds: 3 });
    expect(limiter.hit("b")).toEqual({ allowed: true });
    expect(limiter.size).toBe(2);
    now += 3;
    expect(limiter.hit("a")).toEqual({ allowed: true });
    now += 100;
    expect(limiter.size).toBe(0);
    expect(() => new RateLimiter({ limit: 0, windowSeconds: 1 }, () => now)).toThrow(RangeError);
  });
});
