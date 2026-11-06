// Task 8.1: channel close. The buyer's `refund` payload moves the channel to closing; the
// vendor's latest voucher is accepted for withdrawDelay seconds; the worker then pays the
// vendor what is owed, refunds deposit − settled to the buyer, and marks the channel closed.
// Idle close fires after maxIdleSecs. Over a binding fake that records the order of its
// calls; nothing private is simulated (the devnet path is close.devnet.test.ts).
import { randomBytes } from "node:crypto";
import type { Address, Signature } from "@solana/kit";
import { BINDING_ERROR_CODES, BindingError, type ClientRef, type SettleRef, type SettlementBinding } from "@wakeless/binding";
import { SCHEME_ERROR_CODES, encodeBase58, signCloseRequest, type RefundPayload, type SettlementResponse, type VerifyResponse } from "@wakeless/scheme";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { REFUND_OP_ID, createFacilitatorApp, createMemoryStores, createRedeemer, feeOf, settleOpId, type CloseRunSummary, type RedeemDeps, type Redeemer, type Stores } from "../src/index.js";
import { CHARGE, envelope, fakeBinding, keypair, ready, scenario, voucherOf, voucherPayload, type Scenario } from "./fixtures.js";

const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;
const ADMIN_TOKEN = "admin-token-for-the-tests-only";
const WITHDRAW_DELAY = 900;
const MAX_IDLE = 3600;

type Call = { kind: "settle"; to: Address; amount: bigint; ref: SettleRef } | { kind: "refund"; to: Address; amount: bigint; ref: ClientRef };

interface Harness {
  binding: SettlementBinding;
  stores: Stores;
  s: Scenario;
  calls: Call[];
  logs: string[];
  clock: { now: number };
  redeemer: Redeemer;
  app: Hono;
  /** What the next binding calls do before answering: nothing, or a throw. */
  behaviour: { settle: (() => never)[]; refund: (() => never)[] };
  balance: { value: bigint };
}

const signature = (): Signature => encodeBase58(randomBytes(64)) as Signature;

function harness(overrides: Partial<RedeemDeps> = {}): Harness {
  const calls: Call[] = [];
  const behaviour: Harness["behaviour"] = { settle: [], refund: [] };
  const balance = { value: 0n };
  const binding: SettlementBinding = {
    ...fakeBinding(),
    async settle(to, amount, ref) {
      calls.push({ kind: "settle", to, amount, ref });
      behaviour.settle.shift()?.();
      const sig = signature();
      return { sig, receipt: { channelId: ref.channelId, period: ref.period, cumulative: ref.cumulative, amount, signature: sig, ref: ref.id } };
    },
    async refund(to, amount, ref) {
      calls.push({ kind: "refund", to, amount, ref });
      behaviour.refund.shift()?.();
      return { sig: signature() };
    },
    privateBalance: () => Promise.resolve(balance.value),
  };
  const s = scenario(binding.escrowAddress());
  const stores = createMemoryStores();
  const logs: string[] = [];
  const clock = { now: 1_700_000_300 };
  const redeemer = createRedeemer({ binding, stores, signer: keypair(), now: () => clock.now, log: (line) => logs.push(line), maxIdleSecs: MAX_IDLE, ...overrides });
  const app = createFacilitatorApp({ binding: ready(binding), stores, now: () => clock.now, log: (line) => logs.push(line), redeemer, adminToken: ADMIN_TOKEN, maxIdleSecs: MAX_IDLE });
  return { binding, stores, s, calls, logs, clock, redeemer, app, behaviour, balance };
}

function refundPayload(s: Scenario, cumulative: bigint, overrides: Partial<RefundPayload> = {}): RefundPayload {
  const voucher = voucherOf(s, cumulative);
  return { type: "refund", channelConfig: s.channelConfig, voucher, closeSignature: signCloseRequest(s.buyer, voucher), ...overrides };
}

async function post(app: Hono, path: string, body: unknown, token?: string) {
  const res = await app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) } });
  return { status: res.status, body: (await res.json()) as SettlementResponse & VerifyResponse & Record<string, unknown> };
}

/** A channel the buyer deposited 2 USDC into and spent 0.5 USDC (plus the fee share) on. */
async function spentChannel(h: Harness, s = h.s, accepted = 500_500n): Promise<void> {
  await h.stores.channels.put({ ...s.record, deposit: 2_000_000n, accepted, settled: 0n, latestVoucher: voucherOf(s, accepted), lastActivityAt: h.clock.now });
}

/** The buyer's close over HTTP, through /settle. */
async function closeOverHttp(h: Harness, s = h.s, cumulative = 500_500n) {
  return post(h.app, "/settle", envelope(s, refundPayload(s, cumulative)));
}

describe("channel close", () => {
  it("the vendor's latest voucher is accepted during the grace period", async () => {
    const h = harness();
    await spentChannel(h);
    const closed = await closeOverHttp(h);
    expect(closed.status).toBe(200);
    expect(closed.body.success).toBe(true);
    expect(closed.body.extra?.closeState).toEqual({ state: "closing", requestedAt: h.clock.now, refundAfter: h.clock.now + WITHDRAW_DELAY, deposit: "2000000", settled: "0", refund: null });
    expect((await h.stores.channels.get(h.s.channelId))?.state).toBe("closing");

    // Inside the grace the vendor's next voucher is verified and settled as on an open channel.
    h.clock.now += WITHDRAW_DELAY - 1;
    const next = voucherPayload(h.s, 500_500n + CHARGE);
    const verify = await post(h.app, "/verify", envelope(h.s, next));
    expect(verify.body).toMatchObject({ isValid: true, payer: h.s.buyerAddress });
    const settle = await post(h.app, "/settle", envelope(h.s, next));
    expect(settle.body).toMatchObject({ success: true, extra: { chargedAmount: CHARGE.toString() } });
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(500_500n + CHARGE);

    // Nothing is paid out before the grace ends; the channel stays closing.
    expect(await h.redeemer.closeOnce()).toMatchObject({ idle: 0, due: 0, settled: 0, refunded: 0, closed: 0 });
    expect(h.calls).toHaveLength(0);

    // Once it has, a voucher is refused with channel_closing and nothing moves on the record.
    h.clock.now += 1;
    const late = voucherPayload(h.s, 500_500n + 2n * CHARGE);
    expect((await post(h.app, "/verify", envelope(h.s, late))).body).toMatchObject({ isValid: false, invalidReason: SCHEME_ERROR_CODES.channelClosing, code: SCHEME_ERROR_CODES.channelClosing });
    expect((await post(h.app, "/settle", envelope(h.s, late))).body).toMatchObject({ success: false, errorReason: SCHEME_ERROR_CODES.channelClosing });
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(500_500n + CHARGE);
    // So is a deposit.
    const topUp = { ...voucherPayload(h.s, 500_500n + 2n * CHARGE), type: "deposit" as const, depositSignature: encodeBase58(randomBytes(64)), deposit: { amount: "1000", transaction: randomBytes(100).toString("base64") } };
    expect((await post(h.app, "/verify", envelope(h.s, topUp))).body.invalidReason).toBe(SCHEME_ERROR_CODES.channelClosing);
  });

  it("refund equals deposit minus settled and the vendor is paid first", async () => {
    const h = harness();
    await spentChannel(h);
    await closeOverHttp(h);
    h.clock.now += WITHDRAW_DELAY;

    const summary = await h.redeemer.closeOnce();
    expect(summary).toEqual({ idle: 0, due: 1, settled: 1, refunded: 1, closed: 1, failed: 0, rejected: 0, skipped: 0 } satisfies CloseRunSummary);

    // Call order: settle to the vendor, then refund to the buyer. Amounts: the owed net of the
    // 10 bps fee to the vendor; deposit − settled (gross) to the buyer; the fee stays in escrow.
    expect(h.calls.map((c) => c.kind)).toEqual(["settle", "refund"]);
    const [settle, refund] = h.calls as [Call & { kind: "settle" }, Call & { kind: "refund" }];
    expect(settle.to).toBe(h.s.vendor);
    expect(settle.amount).toBe(500_500n - feeOf(500_500n, 10));
    expect(settle.ref.period).toBe(1);
    expect(refund.to).toBe(h.s.buyerAddress);
    expect(refund.amount).toBe(2_000_000n - 500_500n);
    expect(refund.ref.id).toBe(h.s.record.clientRef);

    const channel = await h.stores.channels.get(h.s.channelId);
    expect(channel).toMatchObject({ state: "closed", settled: 500_500n, accepted: 500_500n });
    const ops = await h.stores.operations.list(h.s.channelId);
    expect(ops.map((o) => [o.opId, o.type, o.status])).toEqual([
      [settleOpId(1), "settle", "confirmed"],
      [REFUND_OP_ID, "refund", "confirmed"],
    ]);
    expect(ops[1]!.signature).toMatch(BASE58_88);
    expect(ops[1]!.payload).toEqual({ amount: "1499500", clientRef: h.s.record.clientRef });

    // The buyer's same request now answers the close as it stands: closed, with the refund.
    const again = await closeOverHttp(h);
    expect(again.body.success).toBe(true);
    expect(again.body.extra?.closeState).toEqual({ state: "closed", requestedAt: h.clock.now - WITHDRAW_DELAY, refundAfter: h.clock.now, deposit: "2000000", settled: "500500", refund: { amount: "1499500", signature: ops[1]!.signature } });
    expect(again.body.extra?.replayed).toBeUndefined();

    // Another pass does nothing; the vendor's receipt for the final period exists; no log line names an amount or a signature.
    expect(await h.redeemer.closeOnce()).toMatchObject({ due: 0, settled: 0, refunded: 0, closed: 0 });
    expect(await h.redeemer.runOnce()).toEqual({ owed: 0, confirmed: 0, failed: 0, rejected: 0, skipped: 0 });
    expect(h.calls).toHaveLength(2);
    expect((await h.redeemer.receipts(h.s.channelId)).map((r) => [r.period, r.cumulative, r.amount])).toEqual([[1, "500500", "500000"]]);
    for (const line of h.logs) {
      expect(line).not.toMatch(BASE58_88);
      expect(line).not.toMatch(/1499500|500500|500000|2000000/);
    }
  });

  it("idle close fires after maxIdleSecs", async () => {
    const h = harness();
    await spentChannel(h);
    const busy = scenario(h.binding.escrowAddress());
    await spentChannel(h, busy);

    // One channel goes quiet; the other keeps paying.
    h.clock.now += MAX_IDLE - 1;
    await h.stores.channels.update(busy.channelId, (c) => ({ ...c!, lastActivityAt: h.clock.now }));
    expect(await h.redeemer.closeOnce()).toMatchObject({ idle: 0, due: 0 });
    h.clock.now += 1;
    const summary = await h.redeemer.closeOnce();
    // The idle channel is settled at its accepted watermark and refunded in the same pass: no grace, the vendor had maxIdleSecs.
    expect(summary).toEqual({ idle: 1, due: 1, settled: 1, refunded: 1, closed: 1, failed: 0, rejected: 0, skipped: 0 });
    expect(h.calls.map((c) => [c.kind, c.to])).toEqual([
      ["settle", h.s.vendor],
      ["refund", h.s.buyerAddress],
    ]);
    expect(await h.stores.channels.get(h.s.channelId)).toMatchObject({ state: "closed", settled: 500_500n, closingAt: h.clock.now, refundAfter: h.clock.now });
    expect((await h.stores.channels.get(busy.channelId))?.state).toBe("open");
    expect(h.logs.some((line) => line === `idle close ${h.s.channelId}`)).toBe(true);
    // A voucher on the idle-closed channel is refused.
    expect((await post(h.app, "/verify", envelope(h.s, voucherPayload(h.s, 500_500n + CHARGE)))).body.invalidReason).toBe(SCHEME_ERROR_CODES.channelClosing);
  });

  it("a close request must carry the buyer's close signature over its latest voucher", async () => {
    const h = harness();
    await spentChannel(h);
    const payload = refundPayload(h.s, 500_500n);
    const other = keypair();
    const cases: [RefundPayload, string][] = [
      [{ ...payload, closeSignature: signCloseRequest(other, payload.voucher) }, SCHEME_ERROR_CODES.closeAuthorization],
      [{ ...payload, closeSignature: payload.voucher.signature }, SCHEME_ERROR_CODES.closeAuthorization],
      [{ ...payload, closeSignature: "not-a-signature" }, SCHEME_ERROR_CODES.closeAuthorization],
      [{ ...payload, voucher: voucherOf(h.s, 500_500n, other) }, SCHEME_ERROR_CODES.voucherSignature],
      [refundPayload(scenario(h.binding.escrowAddress()), 1n), SCHEME_ERROR_CODES.channelState],
    ];
    for (const [bad, code] of cases) {
      const verify = await post(h.app, "/verify", envelope(h.s, bad, bad.channelConfig.vendor === h.s.vendor ? h.s.requirements : { ...h.s.requirements, payTo: bad.channelConfig.vendor }));
      expect(verify.body, code).toMatchObject({ isValid: false, invalidReason: code });
      const settle = await post(h.app, "/settle", envelope(h.s, bad, bad.channelConfig.vendor === h.s.vendor ? h.s.requirements : { ...h.s.requirements, payTo: bad.channelConfig.vendor }));
      expect(settle.body, code).toMatchObject({ success: false, errorReason: code });
    }
    expect((await h.stores.channels.get(h.s.channelId))?.state).toBe("open");
    // The real one, through /verify first (allowed, writes nothing) and then /settle.
    const verify = await post(h.app, "/verify", envelope(h.s, payload));
    expect(verify.body).toMatchObject({ isValid: true, payer: h.s.buyerAddress, extra: { channelId: h.s.channelId, withdrawRequestedAt: null } });
    expect((await h.stores.channels.get(h.s.channelId))?.state).toBe("open");
    const settle = await post(h.app, "/settle", envelope(h.s, payload));
    expect(settle.body).toMatchObject({ success: true, payer: h.s.buyerAddress, extra: { chargedAmount: "0", channelState: { withdrawRequestedAt: h.clock.now }, closeState: { state: "closing" } } });
    // A buyer's voucher above the watermark is adopted on close (it only favours the vendor); one below is ignored.
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(500_500n);
    const second = scenario(h.binding.escrowAddress());
    await spentChannel(h, second, 500_500n);
    await closeOverHttp(h, second, 500_500n + CHARGE);
    expect((await h.stores.channels.get(second.channelId))?.accepted).toBe(500_500n + CHARGE);
    const third = scenario(h.binding.escrowAddress());
    await spentChannel(h, third, 500_500n);
    await closeOverHttp(h, third, 1n);
    expect((await h.stores.channels.get(third.channelId))).toMatchObject({ accepted: 500_500n, state: "closing" });
  });

  it("a failed refund is retried after a backoff and a rejected one is terminal and alerted", async () => {
    const h = harness({ backoff: { baseSeconds: 60, maxSeconds: 60 } });
    await spentChannel(h);
    await closeOverHttp(h);
    h.clock.now += WITHDRAW_DELAY;
    h.behaviour.refund.push(() => {
      throw new Error("ECONNRESET");
    });
    expect(await h.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 1, refunded: 0, failed: 1, closed: 0 });
    expect((await h.stores.operations.get(h.s.channelId, REFUND_OP_ID))).toMatchObject({ status: "failed", attempts: 1 });
    expect((await h.stores.channels.get(h.s.channelId))?.state).toBe("closing");
    // In backoff: skipped, no call. After it: the vendor is not paid again; the refund is retried and the channel closes.
    expect(await h.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 0, skipped: 1 });
    expect(h.calls).toHaveLength(2);
    h.clock.now += 60;
    expect(await h.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 0, refunded: 1, closed: 1 });
    expect(h.calls.map((c) => c.kind)).toEqual(["settle", "refund", "refund"]);
    expect((await h.stores.channels.get(h.s.channelId))?.state).toBe("closed");

    const r = harness();
    await spentChannel(r);
    await closeOverHttp(r);
    r.clock.now += WITHDRAW_DELAY;
    r.behaviour.refund.push(() => {
      throw new BindingError(BINDING_ERROR_CODES.bindingRejected, "refused", { apiCode: "UNSUPPORTED_TRANSFER_ROUTE" });
    });
    expect(await r.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 1, rejected: 1, closed: 0 });
    expect(r.redeemer.alerts().map((a) => [a.kind, a.opId, a.period, a.apiCode])).toEqual([["refund_rejected", REFUND_OP_ID, 0, "UNSUPPORTED_TRANSFER_ROUTE"]]);
    for (let i = 0; i < 3; i++) {
      r.clock.now += 3600;
      expect(await r.redeemer.closeOnce()).toMatchObject({ due: 1, skipped: 1, rejected: 0 });
    }
    expect(r.calls.map((c) => c.kind)).toEqual(["settle", "refund"]);
    expect((await r.stores.channels.get(r.s.channelId))?.state).toBe("closing");
    expect((await closeOverHttp(r)).body.extra?.closeState).toMatchObject({ state: "closing", refund: null });
  });

  it("the vendor is paid before any refund: a failed final settle leaves the buyer's refund unsent", async () => {
    const h = harness({ backoff: { baseSeconds: 1, maxSeconds: 1 } });
    await spentChannel(h);
    await closeOverHttp(h);
    h.clock.now += WITHDRAW_DELAY;
    h.behaviour.settle.push(() => {
      throw new Error("ECONNRESET");
    });
    expect(await h.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 0, refunded: 0, failed: 1 });
    expect(h.calls.map((c) => c.kind)).toEqual(["settle"]);
    expect(await h.stores.operations.get(h.s.channelId, REFUND_OP_ID)).toBeUndefined();
    h.clock.now += 2;
    expect(await h.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 1, refunded: 1, closed: 1 });
    expect(h.calls.map((c) => c.kind)).toEqual(["settle", "settle", "refund"]);
    // A channel with nothing owed to the buyer closes with no refund transfer and no refund operation.
    const spent = scenario(h.binding.escrowAddress());
    await h.stores.channels.put({ ...spent.record, deposit: 1_000n, accepted: 1_000n, settled: 1_000n, state: "closing", closingAt: h.clock.now, refundAfter: h.clock.now });
    expect(await h.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 0, refunded: 0, closed: 1 });
    expect(h.calls).toHaveLength(3);
    expect(await h.stores.operations.list(spent.channelId)).toEqual([]);
    expect((await h.stores.channels.get(spent.channelId))?.state).toBe("closed");
  });

  it("a pending refund at startup is reconciled, not resent", async () => {
    const h = harness();
    const other = scenario(h.binding.escrowAddress());
    for (const s of [h.s, other]) {
      await h.stores.channels.put({ ...s.record, deposit: 2_000_000n, accepted: 500_500n, settled: 500_500n, state: "closing", closingAt: 1, refundAfter: 1 });
      await h.stores.operations.reserve({ opId: settleOpId(1), channelId: s.channelId, type: "settle", payload: { period: 1, cumulative: "500500", gross: "500500", amount: "500000", clientRef: s.record.clientRef } });
      await h.stores.operations.transition(s.channelId, settleOpId(1), { status: "confirmed", signature: signature() });
      await h.stores.operations.reserve({ opId: REFUND_OP_ID, channelId: s.channelId, type: "refund", payload: { amount: "1499500", clientRef: s.record.clientRef } });
    }
    // 4 USDC deposited, 1 USDC paid out to vendors; one refund of 1.4995 left the escrow, the other did not.
    h.balance.value = 4_000_000n - 1_000_000n - 1_499_500n;
    expect(await h.redeemer.reconcile()).toEqual({ pending: 2, sent: 1, unsent: 1 });
    expect(h.calls).toHaveLength(0);
    // The deficit fits one refund; pending operations are taken in channel-id order, so whichever sorts first is the one found sent.
    const [first, second] = [h.s, other].sort((a, b) => a.channelId.localeCompare(b.channelId)) as [Scenario, Scenario];
    const sent = await h.stores.operations.get(first.channelId, REFUND_OP_ID);
    expect(sent).toMatchObject({ status: "confirmed", receipt: { reconciled: true, amount: "1499500" } });
    expect(sent?.signature).toBeUndefined();
    expect((await h.stores.channels.get(first.channelId))?.state).toBe("closed");
    expect((await h.stores.operations.get(second.channelId, REFUND_OP_ID))).toMatchObject({ status: "failed", attempts: 1 });
    expect((await h.stores.channels.get(second.channelId))?.state).toBe("closing");
    expect(h.redeemer.alerts().map((a) => [a.channelId, a.kind])).toEqual([[first.channelId, "refund_reconciled_sent"], [second.channelId, "refund_reconciled_unsent"]]);
    // The reconciled close reports its refund without a signature.
    expect((await closeOverHttp(h, first)).body.extra?.closeState).toMatchObject({ state: "closed", refund: { amount: "1499500", signature: null } });
    // The unsent one is retried as usual.
    h.clock.now += 3600;
    expect(await h.redeemer.closeOnce()).toMatchObject({ due: 1, refunded: 1, closed: 1 });
    expect(h.calls).toEqual([expect.objectContaining({ kind: "refund", to: second.buyerAddress, amount: 1_499_500n })]);
  });

  it("POST /admin/close runs one close pass under the admin token", async () => {
    const h = harness();
    await spentChannel(h);
    await closeOverHttp(h);
    h.clock.now += WITHDRAW_DELAY;
    expect((await post(h.app, "/admin/close", {})).status).toBe(401);
    const run = await post(h.app, "/admin/close", {}, ADMIN_TOKEN);
    expect(run.status).toBe(200);
    expect(run.body).toEqual({ idle: 0, due: 1, settled: 1, refunded: 1, closed: 1, failed: 0, rejected: 0, skipped: 0 });
    for (const line of h.logs) expect(line).not.toContain(ADMIN_TOKEN);
  });
});
