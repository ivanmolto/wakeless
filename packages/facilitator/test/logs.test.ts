// Task 6.3: the structured log carries nothing secret. A pino stream is captured over a
// full cycle (a deposit that opens the channel, confirmed through the deposit handler over
// a binding fake; vouchers verified and settled; a replay; refusals; a rate limit; /health)
// and every line is checked for signatures, bearer tokens and channel amounts. There is no
// redeem endpoint yet (the redemption worker is a later task), so the cycle ends at settle.
import type { SettlementBinding } from "@wakeless/binding";
import { SCHEME_ERROR_CODES, clientRefOf } from "@wakeless/scheme";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { REDACTED_PATHS, createDepositHandler, createFacilitatorApp, createFacilitatorLogger, createMemoryStores, scrubbingDestination } from "../src/index.js";
import { AMOUNT, CHARGE, DEPOSIT, depositPayload, envelope, fakeBinding, ready, scenario, voucherOf, voucherPayload } from "./fixtures.js";

const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;
const BEARER = /bearer/i;

/** The fields a signature, token or amount travels under in any payload or record. */
const FORBIDDEN_KEYS = ["signature", "depositSignature", "token", "authorization", "secretKey", "amount", "maxClaimableAmount", "deposit", "balance", "accepted", "settled", "chargedAmount", "chargedCumulativeAmount", "transaction", "voucher", "payload"];

async function post(app: Hono, path: string, body: unknown, headers: Record<string, string> = {}): Promise<Record<string, unknown>> {
  const res = await app.request(path, { method: "POST", body: typeof body === "string" ? body : JSON.stringify(body), headers: { "content-type": "application/json", ...headers } });
  return (await res.json()) as Record<string, unknown>;
}

describe("facilitator logs", () => {
  it("log output contains no 88-character base58 strings, no bearer tokens, no channel amounts", async () => {
    const lines: string[] = [];
    const logger = createFacilitatorLogger({ destination: { write: (chunk: string) => lines.push(...chunk.split("\n").filter((l) => l.length > 0)) } });

    // A binding fake that confirms exactly the private transfers the buyer "made", once each.
    const seen: { signature: string; ref: string; buyer: string; amount: bigint; transaction: string }[] = [];
    const credited = new Set<string>();
    const binding: SettlementBinding = {
      ...fakeBinding(),
      readDeposit: async (sig, ref) => {
        if (credited.has(sig)) return null;
        const match = seen.find((d) => d.signature === sig && d.ref === ref.id && d.buyer === ref.buyer && d.amount === ref.amount && d.transaction === ref.transaction);
        if (!match) return null;
        credited.add(sig);
        return { amount: ref.amount, buyer: ref.buyer };
      },
    };
    const s = scenario(binding.escrowAddress());
    const stores = createMemoryStores();
    const clock = { now: 1_700_000_100 };
    const deposits = createDepositHandler({ binding, stores, now: () => clock.now, logger });
    const app = createFacilitatorApp({
      binding: ready(binding),
      stores,
      deposits,
      logger,
      now: () => clock.now,
      rateLimits: { perIp: { limit: 50, windowSeconds: 60 }, perChannel: { limit: 7, windowSeconds: 60 } },
      clientAddress: (c) => c.req.header("x-test-ip"),
    });

    // The cycle.
    expect((await app.request("/health")).status).toBe(200);
    expect((await app.request("/supported")).status).toBe(200);

    const opening = depositPayload(s, DEPOSIT, CHARGE);
    seen.push({ signature: opening.depositSignature, ref: clientRefOf(s.channelId), buyer: s.buyerAddress, amount: DEPOSIT, transaction: opening.deposit.transaction });
    const open = envelope(s, opening);
    expect((await post(app, "/verify", open)).isValid).toBe(true);
    expect((await post(app, "/settle", open)).success).toBe(true);
    expect((await post(app, "/settle", open)).extra).toMatchObject({ replayed: true });

    const second = envelope(s, voucherPayload(s, CHARGE * 2n));
    expect((await post(app, "/verify", second)).isValid).toBe(true);
    expect((await post(app, "/settle", second)).success).toBe(true);

    // Refusals of every HTTP class: a verdict, a 400, a 404, a 429, and a settle with no verify.
    expect((await post(app, "/verify", envelope(s, voucherPayload(s, CHARGE, voucherOf(s, CHARGE, { secretKey: new Uint8Array(32).fill(9) }))))).invalidReason).toBe(SCHEME_ERROR_CODES.voucherSignature);
    expect((await post(app, "/verify", envelope(s, voucherPayload(s, DEPOSIT * 2n)))).invalidReason).toBe(SCHEME_ERROR_CODES.cumulativeExceedsDeposit);
    expect((await post(app, "/settle", envelope(s, voucherPayload(s, CHARGE * 3n)))).errorReason).toBe(SCHEME_ERROR_CODES.shieldedVerifyRequired);
    expect((await post(app, "/verify", "{")).code).toBe(SCHEME_ERROR_CODES.invalidPayload);
    expect((await app.request("/nowhere")).status).toBe(404);
    // Seven requests named the channel so far (the replay answers before the count); the eighth is over the limit of 7.
    const limited = await app.request("/verify", { method: "POST", body: JSON.stringify(second), headers: { "content-type": "application/json" } });
    expect(limited.status).toBe(429);
    // An unexpected error: a store that throws inside /settle gives a 500 whose line names the class only.
    const broken = createFacilitatorApp({ binding: ready(binding), stores: { ...stores, channels: { ...stores.channels, get: () => Promise.reject(new Error(`boom ${opening.depositSignature} Bearer abc.def`)) } }, logger, now: () => clock.now });
    expect((await broken.request("/verify", { method: "POST", body: JSON.stringify(second), headers: { "content-type": "application/json" } })).status).toBe(500);

    // Every line is JSON, and the cycle did log: a verify, a settle, a replay, a deposit confirmation, a 429, a 500.
    const parsed = lines.map((line) => JSON.parse(line) as Record<string, unknown>);
    expect(parsed.length).toBeGreaterThanOrEqual(14);
    const events = parsed.map((entry) => entry.event);
    expect(events).toContain("deposit_confirmed");
    expect(parsed.filter((entry) => entry.outcome === "settled")).toHaveLength(2);
    expect(parsed.filter((entry) => entry.outcome === "replayed")).toHaveLength(1);
    expect(parsed.filter((entry) => entry.status === 429).length).toBeGreaterThanOrEqual(1);
    expect(parsed.filter((entry) => entry.status === 500)).toHaveLength(1);
    expect(parsed.some((entry) => entry.channelId === s.channelId)).toBe(true);

    // The scrub never fired: nothing was in the lines for it to remove.
    expect(events).not.toContain("log_redacted");

    // Nothing secret, on any line. Times are dropped first so a timestamp cannot collide with an amount string.
    const amounts = [DEPOSIT, CHARGE, CHARGE * 2n, AMOUNT, DEPOSIT * 2n].map(String);
    for (const entry of parsed) {
      const { time: _time, ...rest } = entry;
      void _time;
      const text = JSON.stringify(rest);
      expect(text).not.toMatch(BASE58_88);
      expect(text).not.toMatch(BEARER);
      expect(text).not.toContain(opening.depositSignature);
      expect(text).not.toContain(opening.deposit.transaction.slice(0, 32));
      for (const amount of amounts) expect(text, text).not.toMatch(new RegExp(`[^0-9a-f]${amount}[^0-9a-f]`));
      for (const key of FORBIDDEN_KEYS) expect(Object.keys(rest), text).not.toContain(key);
      // A verify or settle line names the request by its hash, never by its contents.
      if (rest.path === "/verify" || rest.path === "/settle") {
        if (rest.status === 200) expect(rest.hash).toMatch(/^[0-9a-f]{64}$/);
      }
    }

    // The scrub is a last resort and reports itself: a line that did carry a signature or a token is censored and counted.
    const scrubbed: string[] = [];
    const guard = scrubbingDestination({ write: (line: string) => scrubbed.push(line) });
    guard.stream.write(`sig ${opening.depositSignature} Authorization: Bearer abc.def-ghi\n`);
    expect(scrubbed[0]).toBe("sig [redacted] Authorization: [redacted]\n");
    expect(guard.scrubbed()).toBe(2);
    expect(REDACTED_PATHS).toContain("signature");
  });
});
