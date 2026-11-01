// The first four rows of the failure table (briefing §3, `docs/FAILURES.md`), each
// exercised where it is decided: on the facilitator's own app, and through the
// seller middleware over real HTTP against an in-process facilitator. The binding
// fake answers only what `/supported` reads: a voucher settles off-chain, so nothing
// is transferred and nothing is simulated.
import { randomBytes } from "node:crypto";
import { createServer, type AddressInfo, type Server } from "node:net";
import { SCHEME_ERROR_CODES, SCHEME_ID, encodeBase58, verifyVoucher, type PaymentRequirements, type VerifyResponse } from "@wakeless/scheme";
import { PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER, x402Shielded } from "@wakeless/vendor";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { createFacilitatorApp, createMemoryStores, type Stores } from "../src/index.js";
import { DEPOSIT as VENDOR_DEPOSIT, address, decodeRequired, encodeHeader, fundedBuyer, listen, shieldedEntry, startFacilitator, type InProcessFacilitator } from "../../vendor/test/fixtures.js";
import { AMOUNT, CHARGE, DEPOSIT, envelope, fakeBinding, ready, scenario, voucherOf, voucherPayload } from "./fixtures.js";

const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;
const PRICE = 1_000n;
const ROUTE = "/price/:symbol";
const RESOURCE = "http://vendor.test/price/SOLX";
const PAY_TO = address();

type Verdict = Record<string, unknown> & { code?: string; retryable?: boolean; extra?: Record<string, unknown> };

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

/** The facilitator alone, with the HTTP tests' seeded channel. */
function facilitatorApp() {
  const binding = fakeBinding();
  const s = scenario(binding.escrowAddress());
  const stores = createMemoryStores();
  const logs: string[] = [];
  const app = createFacilitatorApp({ binding: ready(binding), stores, now: () => 1_700_000_100, log: (line) => logs.push(line) });
  const post = async (path: "/verify" | "/settle", body: unknown): Promise<Verdict> => {
    const res = await app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
    expect(res.status).toBe(200);
    return (await res.json()) as Verdict;
  };
  return { app, s, stores, logs, post };
}

async function snapshot(stores: Stores, channelId: string) {
  return { channels: await stores.channels.list(), operations: await stores.operations.list(channelId) };
}

/** A vendor over a facilitator, with a counter on the protected handler. */
function vendor(facilitatorUrl: string, facilitatorTimeoutMs?: number) {
  const calls = { resource: 0 };
  const app = new Hono();
  app.use("*", x402Shielded({ facilitatorUrl, payTo: PAY_TO, amountPerRoute: { [ROUTE]: PRICE.toString() }, ...(facilitatorTimeoutMs === undefined ? {} : { facilitatorTimeoutMs }) }));
  app.get(ROUTE, (c) => {
    calls.resource += 1;
    return c.json({ price: 1 });
  });
  return { app, calls };
}

async function facilitatorOverHttp(): Promise<InProcessFacilitator> {
  const f = await startFacilitator();
  cleanups.push(f.close);
  return f;
}

/** A vendor, its accept, and a buyer with a confirmed channel of `VENDOR_DEPOSIT`. */
async function paidSetup(f: InProcessFacilitator) {
  const v = vendor(f.url);
  const accept = shieldedEntry(decodeRequired(await v.app.request(RESOURCE)));
  const buyer = await fundedBuyer(f, accept);
  return { ...v, accept, buyer };
}

/** An accept without the named `extra` keys. */
function withoutKeys(accept: PaymentRequirements, keys: readonly string[]) {
  return { ...accept, extra: Object.fromEntries(Object.entries(accept.extra).filter(([key]) => !keys.includes(key))) };
}

function correctiveExtra(verdict: Verdict) {
  return verdict.extra as (VerifyResponse["extra"] & { chargedCumulativeAmount: string }) | undefined;
}

describe("failure cases, part 1", () => {
  it("voucher exceeds deposit: corrective 402 carries minDeposit", async () => {
    const f = await facilitatorOverHttp();
    const { app, calls, accept, buyer } = await paidSetup(f);
    const routeMin = BigInt(accept.extra.minDeposit!);
    expect(routeMin).toBe(PRICE * 100n);

    // One accepted voucher, so the corrective state has a watermark and a voucher to prove it.
    const first = PRICE + 1n;
    expect((await app.request(RESOURCE, { headers: buyer.payment(first) })).status).toBe(200);
    expect(calls.resource).toBe(1);

    // Just above the deposit: the target stays the route's minDeposit.
    const slightly = await app.request(RESOURCE, { headers: buyer.payment(VENDOR_DEPOSIT + 1n) });
    expect(slightly.status).toBe(402);
    expect(await slightly.json()).toMatchObject({ code: SCHEME_ERROR_CODES.cumulativeExceedsDeposit, retryable: false });
    const required = decodeRequired(slightly);
    expect(required.error).toBe(SCHEME_ERROR_CODES.cumulativeExceedsDeposit);
    expect(required.accepts).toHaveLength(1);
    const corrective = shieldedEntry(required);
    expect(corrective.extra.minDeposit).toBe(routeMin.toString());
    expect(corrective.extra.channelState).toEqual({
      channelId: buyer.channelId,
      balance: VENDOR_DEPOSIT.toString(),
      totalClaimed: "0",
      withdrawRequestedAt: null,
      chargedCumulativeAmount: first.toString(),
    });
    // The voucher proof is the buyer's own signature over its last accepted voucher.
    const { voucherState } = corrective.extra;
    expect(voucherState).toMatchObject({ signedMaxClaimable: first.toString(), expiresAt: 0 });
    expect(verifyVoucher(buyer.buyerAddress, { channelId: buyer.channelId, maxClaimableAmount: voucherState!.signedMaxClaimable, expiresAt: 0, signature: voucherState!.signature })).toBe(true);
    // Every term the buyer already accepted is unchanged; only the target and the corrective keys differ.
    expect(withoutKeys(corrective, ["minDeposit", "channelState", "voucherState"])).toEqual(withoutKeys(accept, ["minDeposit"]));

    // Far above the deposit: the target is the shortfall, so one top-up makes the voucher fit.
    const far = await app.request(RESOURCE, { headers: buyer.payment(VENDOR_DEPOSIT + 500_000n) });
    expect(far.status).toBe(402);
    expect(shieldedEntry(decodeRequired(far)).extra.minDeposit).toBe((500_000n).toString());

    // Nothing moved and no resource left.
    expect(calls.resource).toBe(1);
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(first);

    // A buyer that echoes the corrective entry as `accepted` has accepted this route's terms.
    const retry = await app.request(RESOURCE, { headers: buyer.payment(first * 2n, corrective) });
    expect(retry.status).toBe(200);
    expect(calls.resource).toBe(2);
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(first * 2n);

    // The facilitator's own verdict is where the snapshot comes from, and nothing of it is logged.
    const direct = facilitatorApp();
    await direct.stores.channels.put(direct.s.record);
    const verdict = await direct.post("/verify", envelope(direct.s, voucherPayload(direct.s, DEPOSIT + 1n)));
    expect(verdict).toMatchObject({ isValid: false, invalidReason: SCHEME_ERROR_CODES.cumulativeExceedsDeposit, code: SCHEME_ERROR_CODES.cumulativeExceedsDeposit, retryable: false });
    expect(correctiveExtra(verdict)).toEqual({ channelId: direct.s.channelId, balance: DEPOSIT.toString(), totalClaimed: "0", withdrawRequestedAt: null, chargedCumulativeAmount: "0" });
    expect(correctiveExtra(verdict)).not.toHaveProperty("voucherState");
    for (const line of direct.logs) expect(line).not.toMatch(BASE58_88);
  });

  it("voucher not above last accepted is rejected", async () => {
    const direct = facilitatorApp();
    const { s, post, stores } = direct;
    await stores.channels.put(s.record);
    const good = envelope(s, voucherPayload(s, CHARGE));
    expect((await post("/verify", good)).isValid).toBe(true);
    expect((await post("/settle", good)).success).toBe(true);

    // Equal to the watermark, below it, and above it but short of the price: all stale.
    for (const cumulative of [CHARGE, CHARGE - 1n, 1n, CHARGE + AMOUNT - 1n]) {
      const verdict = await post("/verify", envelope(s, voucherPayload(s, cumulative)));
      expect(verdict, cumulative.toString()).toMatchObject({ isValid: false, invalidReason: SCHEME_ERROR_CODES.cumulativeAmountMismatch, code: SCHEME_ERROR_CODES.cumulativeAmountMismatch, retryable: false });
      const extra = correctiveExtra(verdict)!;
      expect(extra.chargedCumulativeAmount, cumulative.toString()).toBe(CHARGE.toString());
      expect(extra.balance).toBe(DEPOSIT.toString());
      expect(extra.voucherState).toMatchObject({ signedMaxClaimable: CHARGE.toString(), expiresAt: 0 });
      expect(verifyVoucher(s.buyerAddress, { channelId: s.channelId, maxClaimableAmount: CHARGE.toString(), expiresAt: 0, signature: extra.voucherState!.signature })).toBe(true);
    }
    // `/settle` of a stale voucher is refused the same way and carries no snapshot.
    const stale = await post("/settle", envelope(s, voucherPayload(s, CHARGE - 1n)));
    expect(stale).toMatchObject({ success: false, errorReason: SCHEME_ERROR_CODES.cumulativeAmountMismatch, transaction: "" });
    expect(stale.extra).toBeUndefined();
    // The highest watermark is kept.
    expect((await stores.channels.get(s.channelId))?.accepted).toBe(CHARGE);
    expect((await stores.channels.get(s.channelId))?.latestVoucher?.maxClaimableAmount).toBe(CHARGE.toString());
    for (const line of direct.logs) expect(line).not.toMatch(BASE58_88);

    // Through the seller: a 402 naming the code, the route's own target, the snapshot, no resource.
    const f = await facilitatorOverHttp();
    const { app, calls, accept, buyer } = await paidSetup(f);
    const first = PRICE + 1n;
    expect((await app.request(RESOURCE, { headers: buyer.payment(first) })).status).toBe(200);
    const res = await app.request(RESOURCE, { headers: buyer.payment(first) });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: SCHEME_ERROR_CODES.cumulativeAmountMismatch, retryable: false });
    const required = decodeRequired(res);
    expect(required.error).toBe(SCHEME_ERROR_CODES.cumulativeAmountMismatch);
    const corrective = shieldedEntry(required);
    expect(corrective.extra.minDeposit).toBe(accept.extra.minDeposit);
    expect(corrective.extra.channelState?.chargedCumulativeAmount).toBe(first.toString());
    expect(corrective.extra.voucherState?.signedMaxClaimable).toBe(first.toString());
    expect(calls.resource).toBe(1);
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(first);
  });

  it("bad signature or wrong channel is rejected and nothing stored", async () => {
    const direct = facilitatorApp();
    const { s, post, stores } = direct;
    await stores.channels.put(s.record);
    const before = await snapshot(stores, s.channelId);
    const other = scenario(s.escrow);

    const badSignature = voucherPayload(s, CHARGE, voucherOf(s, CHARGE, { secretKey: new Uint8Array(32).fill(7) }));
    const wrongChannel = voucherPayload(s, CHARGE, { ...voucherOf(s, CHARGE), channelId: other.channelId });
    const cases = [
      { payload: badSignature, code: SCHEME_ERROR_CODES.voucherSignature },
      { payload: wrongChannel, code: SCHEME_ERROR_CODES.channelIdMismatch },
    ];
    for (const { payload, code } of cases) {
      const verify = await post("/verify", envelope(s, payload));
      expect(verify, code).toMatchObject({ isValid: false, invalidReason: code, code, retryable: false, payer: s.buyerAddress });
      // Nothing of the record travels on these: the caller has not proven it is the buyer.
      expect(verify.extra, code).toBeUndefined();
      const settle = await post("/settle", envelope(s, payload));
      expect(settle, code).toMatchObject({ success: false, errorReason: code, code, transaction: "" });
      expect(settle.extra, code).toBeUndefined();
    }
    // A valid voucher for a channel that was never funded is refused too, and creates nothing.
    const unknown = await post("/verify", envelope(other, voucherPayload(other, CHARGE)));
    expect(unknown).toMatchObject({ isValid: false, invalidReason: SCHEME_ERROR_CODES.channelState });

    expect(await snapshot(stores, s.channelId)).toEqual(before);
    expect(await stores.channels.get(other.channelId)).toBeUndefined();
    expect(await stores.operations.list(other.channelId)).toEqual([]);
    for (const line of direct.logs) expect(line).not.toMatch(BASE58_88);

    // Through the seller: 402 with the code, no resource, nothing stored, the target unchanged.
    const f = await facilitatorOverHttp();
    const { app, calls, accept, buyer } = await paidSetup(f);
    const stored = await snapshot(f.stores, buyer.channelId);
    const header = buyer.payment(PRICE + 1n)[PAYMENT_SIGNATURE_HEADER]!;
    const envelopeOf = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload: { voucher: { channelId: string; signature: string } } };
    const tampered = [
      { name: "signature", code: SCHEME_ERROR_CODES.voucherSignature, mutate: (v: { signature: string }) => ({ ...v, signature: encodeBase58(randomBytes(64)) }) },
      { name: "channel", code: SCHEME_ERROR_CODES.channelIdMismatch, mutate: (v: { channelId: string }) => ({ ...v, channelId: address() }) },
    ];
    for (const { name, code, mutate } of tampered) {
      const payload = { ...envelopeOf.payload, voucher: mutate(envelopeOf.payload.voucher as never) };
      const res = await app.request(RESOURCE, { headers: { [PAYMENT_SIGNATURE_HEADER]: encodeHeader({ ...envelopeOf, payload }) } });
      expect(res.status, name).toBe(402);
      expect(await res.json(), name).toMatchObject({ code, retryable: false });
      const required = decodeRequired(res);
      expect(required.error, name).toBe(code);
      expect(shieldedEntry(required), name).toEqual(accept);
    }
    expect(calls.resource).toBe(0);
    expect(await snapshot(f.stores, buyer.channelId)).toEqual(stored);
  });

  it("facilitator unreachable: vendor fails closed", async () => {
    // A port nobody answers on.
    const released = await listen(() => new Response());
    await released.close();
    const refused = vendor(released.url);
    const unpaid = await refused.app.request(RESOURCE);
    expect(unpaid.status).toBe(402);
    expect(decodeRequired(unpaid)).toMatchObject({ error: SCHEME_ERROR_CODES.facilitatorUnavailable, accepts: [] });
    expect(await unpaid.json()).toMatchObject({ code: SCHEME_ERROR_CODES.facilitatorUnavailable, retryable: true });

    // A facilitator that accepts the connection and never answers.
    const silent: Server = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    const sockets = new Set<() => void>();
    silent.on("connection", (socket) => sockets.add(() => socket.destroy()));
    cleanups.push(async () => {
      sockets.forEach((destroy) => destroy());
      await new Promise<void>((resolve) => silent.close(() => resolve()));
    });
    const { port } = silent.address() as AddressInfo;
    const timedOut = vendor(`http://127.0.0.1:${port}`, 100);
    const slow = await timedOut.app.request(RESOURCE);
    expect(slow.status).toBe(402);
    expect(decodeRequired(slow)).toMatchObject({ error: SCHEME_ERROR_CODES.facilitatorUnavailable, accepts: [] });

    // A facilitator that goes away after the buyer funded a channel: the paid request is refused
    // without the resource, and the 402 lists nothing to deposit into.
    const f = await startFacilitator();
    const { app, calls, buyer } = await paidSetup(f);
    await f.close();
    const paid = await app.request(RESOURCE, { headers: buyer.payment(PRICE + 1n) });
    expect(paid.status).toBe(402);
    expect(decodeRequired(paid)).toMatchObject({ error: SCHEME_ERROR_CODES.facilitatorUnavailable, accepts: [] });
    expect(await paid.json()).toMatchObject({ code: SCHEME_ERROR_CODES.facilitatorUnavailable, retryable: true });
    expect(paid.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
    expect(calls.resource).toBe(0);

    // Lost between `/verify` and `/settle`: the handler ran, but its response is withheld.
    const g = await startFacilitator();
    const second = await paidSetup(g);
    const closing = new Hono();
    closing.use("*", x402Shielded({ facilitatorUrl: g.url, payTo: PAY_TO, amountPerRoute: { [ROUTE]: PRICE.toString() } }));
    let handlerRan = 0;
    closing.get(ROUTE, async (c) => {
      handlerRan += 1;
      await g.close();
      return c.json({ secret: "not delivered" });
    });
    const withheld = await closing.request(RESOURCE, { headers: second.buyer.payment(PRICE + 1n) });
    expect(handlerRan).toBe(1);
    expect(withheld.status).toBe(402);
    expect(await withheld.text()).not.toContain("not delivered");
    expect(withheld.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
    expect(decodeRequired(withheld)).toMatchObject({ error: SCHEME_ERROR_CODES.facilitatorUnavailable, accepts: [] });
    expect(second.accept.scheme).toBe(SCHEME_ID);
  });
});
