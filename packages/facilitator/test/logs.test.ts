// Task 6.3: the structured log carries nothing secret. A pino stream is captured over a
// full cycle (a deposit that opens the channel, confirmed through the deposit handler over
// a binding fake; vouchers verified and settled; a replay; refusals; a rate limit; /health)
// then a redeem run (one confirmed private transfer, one rejected by the rail) through the
// admin route, the alerts and the vendor's receipts) and every line is checked for
// signatures, bearer tokens and channel amounts.
import { randomBytes } from "node:crypto";
import type { Signature } from "@solana/kit";
import { BINDING_ERROR_CODES, BindingError, type SettlementBinding } from "@wakeless/binding";
import { SCHEME_ERROR_CODES, clientRefOf, encodeBase58 } from "@wakeless/scheme";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { REDACTED_PATHS, createDepositHandler, createFacilitatorApp, createFacilitatorLogger, createMemoryStores, createRedeemer, scrubbingDestination } from "../src/index.js";
import { AMOUNT, CHARGE, DEPOSIT, depositPayload, envelope, fakeBinding, keypair, ready, scenario, voucherOf, voucherPayload } from "./fixtures.js";

const ADMIN_TOKEN = "admin-token-for-the-log-test";
const VENDOR_TOKEN = "vendor-token-for-the-log-test";

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
      // The first settle is a private transfer; the second is refused by the rail.
      settle: async (_to, amount, ref) => {
        settles++;
        if (settles > 1) throw new BindingError(BINDING_ERROR_CODES.bindingRejected, `refused ${settleSignature} Bearer abc.def`, { apiCode: "UNSUPPORTED_TRANSFER_ROUTE" });
        return { sig: settleSignature, receipt: { channelId: ref.channelId, period: ref.period, cumulative: ref.cumulative, amount, signature: settleSignature, ref: ref.id } };
      },
    };
    let settles = 0;
    const settleSignature = encodeBase58(randomBytes(64)) as Signature;
    const s = scenario(binding.escrowAddress());
    const other = scenario(binding.escrowAddress());
    const stores = createMemoryStores();
    const clock = { now: 1_700_000_100 };
    const deposits = createDepositHandler({ binding, stores, now: () => clock.now, logger });
    const redeemer = createRedeemer({ binding, stores, signer: keypair(), now: () => clock.now, logger });
    const app = createFacilitatorApp({
      binding: ready(binding),
      stores,
      deposits,
      logger,
      now: () => clock.now,
      rateLimits: { perIp: { limit: 50, windowSeconds: 60 }, perChannel: { limit: 7, windowSeconds: 60 } },
      clientAddress: (c) => c.req.header("x-test-ip"),
      redeemer,
      adminToken: ADMIN_TOKEN,
      receiptTokens: new Map([[s.vendor, VENDOR_TOKEN]]),
      receiptSigners: [redeemer.signer],
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

    // The redeem cycle: the first channel's owed amount is transferred, a second channel's is refused by the rail.
    await stores.channels.put({ ...other.record, accepted: CHARGE * 4n });
    const admin = { authorization: `Bearer ${ADMIN_TOKEN}` };
    expect((await app.request("/admin/redeem", { method: "POST", headers: { authorization: "Bearer wrong-token-xxxxxxxxxx" } })).status).toBe(401);
    const run = await app.request("/admin/redeem", { method: "POST", headers: admin });
    expect(run.status).toBe(200);
    expect(await run.json()).toEqual({ owed: 2, confirmed: 1, failed: 0, rejected: 1, skipped: 0 });
    const alerts = (await (await app.request("/admin/alerts", { headers: admin })).json()) as { alerts: { kind: string }[] };
    expect(alerts.alerts.map((a) => a.kind)).toEqual(["settle_rejected"]);
    expect((await app.request(`/receipts/${s.channelId}`)).status).toBe(401);
    const receipts = (await (await app.request(`/receipts/${s.channelId}`, { headers: { authorization: `Bearer ${VENDOR_TOKEN}` } })).json()) as { receipts: { signature: string }[] };
    expect(receipts.receipts.map((r) => r.signature)).toEqual([settleSignature]);

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
    for (const event of ["settle_pending", "settle_confirmed", "settle_rejected", "redeem_run"]) expect(events).toContain(event);
    expect(parsed.filter((entry) => entry.outcome === "redeemed")).toHaveLength(1);
    expect(parsed.filter((entry) => entry.outcome === "receipts")).toHaveLength(1);
    expect(parsed.filter((entry) => entry.status === 401)).toHaveLength(2);

    // The scrub never fired: nothing was in the lines for it to remove.
    expect(events).not.toContain("log_redacted");

    // Nothing secret, on any line. Times are dropped first so a timestamp cannot collide with an amount string.
    const owed = CHARGE * 2n;
    const amounts = [DEPOSIT, CHARGE, CHARGE * 2n, AMOUNT, DEPOSIT * 2n, CHARGE * 4n, owed - (owed * 10n) / 10_000n].map(String);
    for (const entry of parsed) {
      const { time: _time, ...rest } = entry;
      void _time;
      const text = JSON.stringify(rest);
      expect(text).not.toMatch(BASE58_88);
      expect(text).not.toMatch(BEARER);
      expect(text).not.toContain(ADMIN_TOKEN);
      expect(text).not.toContain(VENDOR_TOKEN);
      expect(text).not.toContain(settleSignature);
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
