// Rows 5 to 10 of the failure table (briefing §3, `docs/FAILURES.md`), each exercised where
// it is decided: the redemption worker and the close pass over a binding fake that records
// its calls and answers a signature or throws what the test says, the facilitator app in
// process, and the seller middleware over real HTTP. Nothing private is simulated: the fake
// moves no balance and has no public path to fall back to.
import { randomBytes } from "node:crypto";
import type { Address, Signature } from "@solana/kit";
import { BINDING_ERROR_CODES, BindingError, type ClientRef, type SettleRef, type SettlementBinding } from "@wakeless/binding";
import { SCHEME_ERROR_CODES, encodeBase58, signCloseRequest, verifyReceipt, type RefundPayload, type SettlementResponse, type VerifyResponse } from "@wakeless/scheme";
import { PAYMENT_RESPONSE_HEADER, x402Shielded } from "@wakeless/vendor";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { REFUND_OP_ID, backoffSeconds, createFacilitatorApp, createMemoryStores, createRedeemer, feeOf, settleOpId, type Alert, type AlertsResponse, type DepositHandler, type ReceiptsResponse, type RedeemDeps, type Redeemer, type Stores } from "../src/index.js";
import { decodeRequired, fundedBuyer, shieldedEntry, startFacilitator, type InProcessFacilitator } from "../../vendor/test/fixtures.js";
import { CHARGE, depositPayload, envelope, fakeBinding, keypair, ready, scenario, voucherOf, voucherPayload, type Scenario } from "./fixtures.js";

const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;
const ADMIN_TOKEN = "admin-token-for-the-tests-only";
const VENDOR_TOKEN = "vendor-token-for-the-tests-only";
const WITHDRAW_DELAY = 900;
const MAX_IDLE = 3600;
const PRICE = 1_000n;
const ROUTE = "/price/:symbol";
const RESOURCE = "http://vendor.test/price/SOLX";

type Call = { kind: "settle"; to: Address; amount: bigint; ref: SettleRef } | { kind: "refund"; to: Address; amount: bigint; ref: ClientRef };

interface Harness {
  binding: SettlementBinding;
  stores: Stores;
  s: Scenario;
  calls: Call[];
  logs: string[];
  clock: { now: number };
  signer: ReturnType<typeof keypair>;
  redeemer: Redeemer;
  app: Hono;
  /** What the next binding calls do before answering: nothing, or a throw. */
  behaviour: { settle: (() => never)[]; refund: (() => never)[] };
  /** The escrow's private balance as the fake reports it. */
  balance: { value: bigint };
  /** What the rail answers for a signature under the escrow's login; `not_found` for any other. */
  rail: Map<string, "landed" | "failed" | "not_found">;
  /** Every signature the worker asked the rail about. */
  asked: string[];
}

const signature = (): Signature => encodeBase58(randomBytes(64)) as Signature;

/** What the MagicBlock binding throws for a transfer it submitted and did not see confirmed: the shape, not the class. */
function unconfirmed(sig: string): () => never {
  return () => {
    throw Object.assign(new Error("ephemeral transaction not confirmed on the TEE RPC after 30000 ms"), { name: "UnconfirmedTransferError", signature: sig, waitedMs: 30_000 });
  };
}
const railDown = (): never => {
  throw new Error("ECONNRESET");
};
const rejectedByRail = (): never => {
  throw new BindingError(BINDING_ERROR_CODES.bindingRejected, "the private transfer was refused", { apiCode: "UNSUPPORTED_TRANSFER_ROUTE" });
};

function harness(overrides: Partial<RedeemDeps> = {}, deposits?: DepositHandler): Harness {
  const calls: Call[] = [];
  const behaviour: Harness["behaviour"] = { settle: [], refund: [] };
  const balance = { value: 0n };
  const rail = new Map<string, "landed" | "failed" | "not_found">();
  const asked: string[] = [];
  const binding: SettlementBinding = {
    ...fakeBinding(),
    async transferStatus(sig) {
      asked.push(sig);
      return rail.get(sig) ?? "not_found";
    },
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
  const signer = keypair();
  const redeemer = createRedeemer({ binding, stores, signer, now: () => clock.now, log: (line) => logs.push(line), maxIdleSecs: MAX_IDLE, backoff: { baseSeconds: 60, maxSeconds: 3600 }, ...overrides });
  const app = createFacilitatorApp({
    binding: ready(binding),
    stores,
    now: () => clock.now,
    log: (line) => logs.push(line),
    redeemer,
    adminToken: ADMIN_TOKEN,
    receiptTokens: new Map([[s.vendor, VENDOR_TOKEN]]),
    receiptSigners: [redeemer.signer],
    maxIdleSecs: MAX_IDLE,
    ...(deposits === undefined ? {} : { deposits }),
  });
  return { binding, stores, s, calls, logs, clock, signer, redeemer, app, behaviour, balance, rail, asked };
}

/** A channel with twenty paid calls accepted and nothing settled; the escrow holds its deposit. */
async function owedChannel(h: Harness, accepted = 20_020n, s = h.s): Promise<void> {
  await h.stores.channels.put({ ...s.record, deposit: 100_000n, accepted, settled: 0n, latestVoucher: voucherOf(s, accepted), lastActivityAt: h.clock.now });
  h.balance.value += 100_000n;
}

function refundPayload(s: Scenario, cumulative: bigint): RefundPayload {
  const voucher = voucherOf(s, cumulative);
  return { type: "refund", channelConfig: s.channelConfig, voucher, closeSignature: signCloseRequest(s.buyer, voucher) };
}

type Body = SettlementResponse & VerifyResponse & Record<string, unknown>;

async function post(app: Hono, path: string, body: unknown, token?: string): Promise<{ status: number; body: Body }> {
  const res = await app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json", ...(token === undefined ? {} : { authorization: `Bearer ${token}` }) } });
  return { status: res.status, body: (await res.json()) as Body };
}

async function get<T>(app: Hono, path: string, token?: string): Promise<{ status: number; body: T }> {
  const res = await app.request(path, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  return { status: res.status, body: (await res.json()) as T };
}

const receiptsOf = (h: Harness) => get<ReceiptsResponse>(h.app, `/receipts/${h.s.channelId}`, VENDOR_TOKEN);
const alertsOf = (h: Harness) => get<AlertsResponse>(h.app, "/admin/alerts", ADMIN_TOKEN);

function cleanLogs(h: Harness): void {
  for (const line of h.logs) {
    expect(line).not.toMatch(BASE58_88);
    expect(line).not.toMatch(/20020|20000|500500|2000000/);
  }
}

/** A vendor over a facilitator, with a counter on the protected handler. */
function vendor(facilitatorUrl: string) {
  const calls = { resource: 0 };
  const app = new Hono();
  app.use("*", x402Shielded({ facilitatorUrl, payTo: encodeBase58(randomBytes(32)), amountPerRoute: { [ROUTE]: PRICE.toString() } }));
  app.get(ROUTE, (c) => {
    calls.resource += 1;
    return c.json({ price: 1 });
  });
  return { app, calls };
}

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

async function facilitatorOverHttp(...args: Parameters<typeof startFacilitator>): Promise<InProcessFacilitator> {
  const f = await startFacilitator(...args);
  cleanups.push(f.close);
  return f;
}

describe("failure cases, part 2", () => {
  it("redemption failure keeps the amount owed and returns settlement_pending with signature", async () => {
    // A transfer submitted and not seen confirmed: the binding throws with the signature.
    const h = harness();
    await owedChannel(h);
    const sent = signature();
    h.behaviour.settle.push(unconfirmed(sent));

    expect(await h.redeemer.runOnce()).toMatchObject({ owed: 1, failed: 1, confirmed: 0 });
    const op = await h.stores.operations.get(h.s.channelId, settleOpId(1));
    expect(op).toMatchObject({ status: "failed", attempts: 1, signature: sent });
    expect((await h.stores.channels.get(h.s.channelId))).toMatchObject({ accepted: 20_020n, settled: 0n });
    expect(h.redeemer.alerts().map((a) => [a.kind, a.code])).toEqual([["settle_unconfirmed", SCHEME_ERROR_CODES.settlementPending]]);

    // The vendor sees the amount owed and the signature under its own token: settlement_pending, retryable.
    const seen = await receiptsOf(h);
    expect(seen.status).toBe(200);
    expect(seen.body.receipts).toEqual([]);
    expect(seen.body.rejected).toEqual([]);
    expect(seen.body.pending).toEqual([{ period: 1, cumulative: "20020", amount: "20000", status: "failed", attempts: 1, code: SCHEME_ERROR_CODES.settlementPending, retryable: true, transaction: sent }]);
    expect((await get<{ channels: { settled: string; settle: { failed: number } }[] }>(h.app, `/admin/channels?vendor=${h.s.vendor}`, ADMIN_TOKEN)).body.channels[0]).toMatchObject({ settled: "0", settle: { failed: 1 } });

    // Inside the backoff nothing is sent, and the signature is never resent on its own.
    expect(await h.redeemer.runOnce()).toMatchObject({ owed: 1, skipped: 1 });
    expect(h.calls).toHaveLength(1);

    // The rail, asked under the escrow's own login, says the transfer landed: the same
    // operation is confirmed under the known signature, with a signed receipt, and nothing
    // is sent twice. The balance is not consulted (it still shows the amount, as a late
    // read would).
    h.rail.set(sent, "landed");
    h.clock.now += backoffSeconds(1);
    expect(await h.redeemer.runOnce()).toMatchObject({ owed: 1, skipped: 1, confirmed: 0, failed: 0 });
    expect(h.asked).toEqual([sent]);
    expect(h.calls).toHaveLength(1);
    expect(await h.stores.operations.get(h.s.channelId, settleOpId(1))).toMatchObject({ status: "confirmed", attempts: 1, signature: sent });
    expect((await h.stores.channels.get(h.s.channelId))?.settled).toBe(20_020n);
    const receipts = await h.redeemer.receipts(h.s.channelId);
    expect(receipts).toHaveLength(1);
    expect(receipts[0]).toMatchObject({ period: 1, cumulative: "20020", amount: "20000", signature: sent });
    expect(verifyReceipt(h.redeemer.signer, receipts[0]!)).toBe(true);
    expect((await receiptsOf(h)).body.pending).toEqual([]);
    expect(h.redeemer.alerts().map((a) => a.kind)).toEqual(["settle_unconfirmed", "settle_reconciled_sent"]);
    expect(await h.redeemer.runOnce()).toEqual({ owed: 0, confirmed: 0, failed: 0, rejected: 0, skipped: 0 });
    cleanLogs(h);

    // The rail says the transfer failed inside the rollup: the same payload is retried
    // unchanged, same period and amount, and the stale signature is dropped.
    const u = harness();
    await owedChannel(u);
    const lost = signature();
    u.behaviour.settle.push(unconfirmed(lost));
    await u.redeemer.runOnce();
    expect((await receiptsOf(u)).body.pending[0]).toMatchObject({ transaction: lost });
    u.rail.set(lost, "failed");
    u.clock.now += backoffSeconds(1);
    expect(await u.redeemer.runOnce()).toMatchObject({ owed: 1, confirmed: 1 });
    expect(u.asked).toEqual([lost]);
    expect(u.calls).toHaveLength(2);
    expect(u.calls[1]).toMatchObject({ kind: "settle", to: u.s.vendor, amount: 20_000n });
    expect((u.calls[1] as Call & { kind: "settle" }).ref).toMatchObject({ period: 1, cumulative: 20_020n });
    const retried = await u.stores.operations.get(u.s.channelId, settleOpId(1));
    expect(retried).toMatchObject({ status: "confirmed", attempts: 1 });
    expect(retried?.signature).not.toBe(lost);
    expect((await u.redeemer.receipts(u.s.channelId))[0]?.signature).toBe(retried?.signature);
    expect(u.redeemer.alerts().map((a) => a.kind)).toEqual(["settle_unconfirmed", "settle_reconciled_unsent"]);
    cleanLogs(u);

    // The rail does not know the signature: that proves nothing either way, so the escrow's
    // balance decides, as at startup. Short by the amount: confirmed; whole: resent.
    const n = harness();
    await owedChannel(n);
    const gone = signature();
    n.behaviour.settle.push(unconfirmed(gone));
    await n.redeemer.runOnce();
    n.balance.value -= 20_000n;
    n.clock.now += backoffSeconds(1);
    expect(await n.redeemer.runOnce()).toMatchObject({ owed: 1, skipped: 1 });
    expect(n.asked).toEqual([gone]);
    expect(n.calls).toHaveLength(1);
    expect(await n.stores.operations.get(n.s.channelId, settleOpId(1))).toMatchObject({ status: "confirmed", signature: gone });
    const w = harness();
    await owedChannel(w);
    const whole = signature();
    w.behaviour.settle.push(unconfirmed(whole));
    await w.redeemer.runOnce();
    w.clock.now += backoffSeconds(1);
    expect(await w.redeemer.runOnce()).toMatchObject({ owed: 1, confirmed: 1 });
    expect(w.asked).toEqual([whole]);
    expect(w.calls).toHaveLength(2);
    expect((await w.stores.operations.get(w.s.channelId, settleOpId(1)))?.signature).not.toBe(whole);
    // A rail that cannot be asked counts as not knowing: the balance decides, and the log names the outcome, never the signature.
    const x = harness();
    x.binding.transferStatus = () => Promise.reject(new Error("ECONNRESET"));
    await owedChannel(x);
    const unknown = signature();
    x.behaviour.settle.push(unconfirmed(unknown));
    await x.redeemer.runOnce();
    x.balance.value -= 20_000n;
    x.clock.now += backoffSeconds(1);
    expect(await x.redeemer.runOnce()).toMatchObject({ owed: 1, skipped: 1 });
    expect(await x.stores.operations.get(x.s.channelId, settleOpId(1))).toMatchObject({ status: "confirmed", signature: unknown });
    expect(x.logs.filter((line) => line.startsWith("transfer status"))).toEqual([`transfer status ${x.s.channelId} ${settleOpId(1)} unchecked`]);
    expect(h.logs.filter((line) => line.startsWith("transfer status"))).toEqual([`transfer status ${h.s.channelId} ${settleOpId(1)} landed`]);

    // A refund submitted and not seen confirmed is handled the same way: asked of the rail first.
    const r = harness();
    await r.stores.channels.put({ ...r.s.record, deposit: 2_000_000n, accepted: 500_500n, settled: 0n, latestVoucher: voucherOf(r.s, 500_500n), lastActivityAt: r.clock.now });
    r.balance.value = 2_000_000n;
    await post(r.app, "/settle", envelope(r.s, refundPayload(r.s, 500_500n)));
    r.clock.now += WITHDRAW_DELAY;
    const refundSig = signature();
    r.behaviour.refund.push(unconfirmed(refundSig));
    expect(await r.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 1, refunded: 0, failed: 1, closed: 0 });
    expect(await r.stores.operations.get(r.s.channelId, REFUND_OP_ID)).toMatchObject({ status: "failed", attempts: 1, signature: refundSig });
    expect(r.redeemer.alerts().map((a) => [a.kind, a.code])).toEqual([["refund_unconfirmed", SCHEME_ERROR_CODES.settlementPending]]);
    r.rail.set(refundSig, "landed");
    r.clock.now += backoffSeconds(1);
    expect(await r.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 0, refunded: 0, closed: 1, failed: 0 });
    expect(r.asked).toEqual([refundSig]);
    expect(r.calls.map((c) => c.kind)).toEqual(["settle", "refund"]);
    expect(await r.stores.operations.get(r.s.channelId, REFUND_OP_ID)).toMatchObject({ status: "confirmed", signature: refundSig });
    expect((await r.stores.channels.get(r.s.channelId))?.state).toBe("closed");
    expect((await post(r.app, "/settle", envelope(r.s, refundPayload(r.s, 500_500n)))).body.extra?.closeState).toMatchObject({ state: "closed", refund: { amount: "1499500", signature: refundSig } });
    expect(r.redeemer.alerts().map((a) => a.kind)).toEqual(["refund_unconfirmed", "refund_reconciled_sent"]);
    cleanLogs(n);
    cleanLogs(w);
    cleanLogs(x);
    cleanLogs(r);

    // A transfer that failed before anything left the escrow: owed, pending with no signature, retried.
    const f = harness();
    await owedChannel(f);
    f.behaviour.settle.push(railDown);
    expect(await f.redeemer.runOnce()).toMatchObject({ failed: 1 });
    expect((await receiptsOf(f)).body.pending).toEqual([{ period: 1, cumulative: "20020", amount: "20000", status: "failed", attempts: 1, code: SCHEME_ERROR_CODES.settlementPending, retryable: true, transaction: "" }]);
    expect(f.redeemer.alerts()).toEqual([]);
    f.clock.now += backoffSeconds(1);
    expect(await f.redeemer.runOnce()).toMatchObject({ confirmed: 1 });
    expect(f.calls).toHaveLength(2);
    expect((await receiptsOf(f)).body.pending).toEqual([]);
    cleanLogs(f);
  });

  it("close before redemption: vendor voucher accepted during grace", async () => {
    const h = harness();
    await h.stores.channels.put({ ...h.s.record, deposit: 2_000_000n, accepted: 500_500n, settled: 0n, latestVoucher: voucherOf(h.s, 500_500n), lastActivityAt: h.clock.now });
    h.balance.value = 2_000_000n;

    // The buyer starts a close while 500 500 is owed and unredeemed.
    const closed = await post(h.app, "/settle", envelope(h.s, refundPayload(h.s, 500_500n)));
    expect(closed.body).toMatchObject({ success: true, extra: { closeState: { state: "closing", requestedAt: h.clock.now, refundAfter: h.clock.now + WITHDRAW_DELAY, settled: "0", refund: null } } });
    expect(h.calls).toHaveLength(0);

    // Inside the grace the vendor's latest voucher is verified and settled, and the watermark moves.
    h.clock.now += WITHDRAW_DELAY - 1;
    const latest = voucherPayload(h.s, 500_500n + CHARGE);
    expect((await post(h.app, "/verify", envelope(h.s, latest))).body).toMatchObject({ isValid: true, payer: h.s.buyerAddress, extra: { withdrawRequestedAt: h.clock.now - WITHDRAW_DELAY + 1 } });
    expect((await post(h.app, "/settle", envelope(h.s, latest))).body).toMatchObject({ success: true, extra: { chargedAmount: CHARGE.toString() } });
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(500_500n + CHARGE);
    // Nothing is paid out before the grace ends.
    expect(await h.redeemer.closeOnce()).toMatchObject({ idle: 0, due: 0, settled: 0, refunded: 0 });
    expect(h.calls).toHaveLength(0);

    // After the grace a voucher is refused with channel_closing and the watermark stays.
    h.clock.now += 1;
    const late = voucherPayload(h.s, 500_500n + 2n * CHARGE);
    expect((await post(h.app, "/verify", envelope(h.s, late))).body).toMatchObject({ isValid: false, invalidReason: SCHEME_ERROR_CODES.channelClosing, code: SCHEME_ERROR_CODES.channelClosing, retryable: false });
    expect((await post(h.app, "/settle", envelope(h.s, late))).body).toMatchObject({ success: false, errorReason: SCHEME_ERROR_CODES.channelClosing, transaction: "" });
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(500_500n + CHARGE);

    // The close pays the vendor the whole watermark, grace voucher included, before the buyer's refund.
    const owed = 500_500n + CHARGE;
    expect(await h.redeemer.closeOnce()).toEqual({ idle: 0, due: 1, settled: 1, refunded: 1, closed: 1, failed: 0, rejected: 0, skipped: 0 });
    expect(h.calls.map((c) => [c.kind, c.to, c.amount])).toEqual([
      ["settle", h.s.vendor, owed - feeOf(owed, 10)],
      ["refund", h.s.buyerAddress, 2_000_000n - owed],
    ]);
    expect(await h.stores.channels.get(h.s.channelId)).toMatchObject({ state: "closed", accepted: owed, settled: owed });
    expect((await h.redeemer.receipts(h.s.channelId)).map((r) => [r.period, r.cumulative])).toEqual([[1, owed.toString()]]);
    expect((await post(h.app, "/settle", envelope(h.s, refundPayload(h.s, 500_500n)))).body.extra?.closeState).toMatchObject({ state: "closed", settled: owed.toString(), refund: { amount: (2_000_000n - owed).toString() } });
    cleanLogs(h);
  });

  it("buyer disappears: idle close settles at the accepted watermark", async () => {
    const h = harness();
    await owedChannel(h);
    const busy = scenario(h.binding.escrowAddress());
    await owedChannel(h, 5_005n, busy);

    // No close request ever arrives. One channel goes quiet; the other keeps paying.
    h.clock.now += MAX_IDLE - 1;
    await h.stores.channels.update(busy.channelId, (c) => ({ ...c!, lastActivityAt: h.clock.now }));
    expect(await h.redeemer.closeOnce()).toMatchObject({ idle: 0, due: 0 });
    expect(h.calls).toHaveLength(0);

    // At maxIdleSecs the quiet channel is closed with no grace: settled at its accepted
    // watermark, the rest refunded, in one pass. The vendor had maxIdleSecs to claim.
    h.clock.now += 1;
    expect(await h.redeemer.closeOnce()).toEqual({ idle: 1, due: 1, settled: 1, refunded: 1, closed: 1, failed: 0, rejected: 0, skipped: 0 });
    expect(h.calls.map((c) => [c.kind, c.to, c.amount])).toEqual([
      ["settle", h.s.vendor, 20_020n - feeOf(20_020n, 10)],
      ["refund", h.s.buyerAddress, 100_000n - 20_020n],
    ]);
    expect(await h.stores.channels.get(h.s.channelId)).toMatchObject({ state: "closed", accepted: 20_020n, settled: 20_020n, closingAt: h.clock.now, refundAfter: h.clock.now });
    expect((await h.stores.operations.list(h.s.channelId)).map((o) => [o.opId, o.status])).toEqual([
      [settleOpId(1), "confirmed"],
      [REFUND_OP_ID, "confirmed"],
    ]);
    expect((await h.stores.channels.get(busy.channelId))?.state).toBe("open");
    expect(h.logs).toContain(`idle close ${h.s.channelId}`);

    // The buyer coming back finds its vouchers refused; the vendor's receipt for the final period is there.
    expect((await post(h.app, "/verify", envelope(h.s, voucherPayload(h.s, 20_020n + CHARGE)))).body.invalidReason).toBe(SCHEME_ERROR_CODES.channelClosing);
    expect((await h.redeemer.receipts(h.s.channelId)).map((r) => r.cumulative)).toEqual(["20020"]);
    expect((await get<{ channels: { state: string }[] }>(h.app, `/admin/channels?vendor=${h.s.vendor}`, ADMIN_TOKEN)).body.channels[0]?.state).toBe("closed");
    cleanLogs(h);
  });

  it("duplicate retry returns the stored result", async () => {
    // A voucher settled twice through the facilitator: the stored result, one watermark move.
    const depositCalls: unknown[] = [];
    const deposits: DepositHandler = {
      settle: async (input) => {
        depositCalls.push(input);
        return { success: true, transaction: input.payload.depositSignature, network: input.requirements.network, payer: input.payload.channelConfig.buyer, amount: input.payload.deposit.amount, extra: { commitmentId: `${input.channelId}:${input.payload.voucher.maxClaimableAmount}`, chargedAmount: input.payload.voucher.maxClaimableAmount } };
      },
    };
    const h = harness({}, deposits);
    await owedChannel(h, 0n);
    const body = envelope(h.s, voucherPayload(h.s, CHARGE));
    expect((await post(h.app, "/verify", body)).body.isValid).toBe(true);
    const first = await post(h.app, "/settle", body);
    expect(first.body).toMatchObject({ success: true, extra: { chargedAmount: CHARGE.toString() } });
    expect(first.body.extra).not.toHaveProperty("replayed");
    const again = await post(h.app, "/settle", body);
    expect(again.status).toBe(200);
    const { extra: firstExtra, ...firstRest } = first.body as SettlementResponse;
    const { extra: againExtra, ...againRest } = again.body as SettlementResponse;
    expect(againRest).toEqual(firstRest);
    expect(againExtra).toEqual({ ...firstExtra, replayed: true });
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(CHARGE);
    // Two identical settles in flight settle once.
    const next = envelope(h.s, voucherPayload(h.s, 2n * CHARGE));
    await post(h.app, "/verify", next);
    const [a, b] = await Promise.all([post(h.app, "/settle", next), post(h.app, "/settle", next)]);
    expect([a, b].filter((r) => (r.body.extra as { replayed?: boolean }).replayed === true)).toHaveLength(1);
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(2n * CHARGE);

    // A deposit settled twice reaches the binding once; the same deposit signature in a
    // different envelope is duplicate_settlement (the deposit handler's own verdict, deposit.test.ts).
    const deposit = envelope(h.s, depositPayload(h.s, 500_000n, 3n * CHARGE));
    expect((await post(h.app, "/verify", deposit)).body.isValid).toBe(true);
    expect((await post(h.app, "/settle", deposit)).body.success).toBe(true);
    expect((await post(h.app, "/settle", deposit)).body.extra).toMatchObject({ replayed: true });
    expect(depositCalls).toHaveLength(1);
    cleanLogs(h);

    // Through the seller: a buyer that sends the same payment header twice is served once.
    // The second is refused on the watermark with a corrective 402, so nothing is charged twice.
    const f = await facilitatorOverHttp();
    const v = vendor(f.url);
    const accept = shieldedEntry(decodeRequired(await v.app.request(RESOURCE)));
    const buyer = await fundedBuyer(f, accept);
    const headers = buyer.payment(PRICE + 1n);
    const served = await v.app.request(RESOURCE, { headers });
    expect(served.status).toBe(200);
    expect(served.headers.get(PAYMENT_RESPONSE_HEADER)).not.toBeNull();
    const retry = await v.app.request(RESOURCE, { headers });
    expect(retry.status).toBe(402);
    expect(await retry.json()).toMatchObject({ code: SCHEME_ERROR_CODES.cumulativeAmountMismatch, retryable: false });
    expect(shieldedEntry(decodeRequired(retry)).extra.channelState?.chargedCumulativeAmount).toBe((PRICE + 1n).toString());
    expect(v.calls.resource).toBe(1);
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(PRICE + 1n);
  });

  it("PER rejection is terminal, alerted, never public", async () => {
    const h = harness();
    await owedChannel(h);
    h.behaviour.settle.push(rejectedByRail);

    expect(await h.redeemer.runOnce()).toMatchObject({ owed: 1, rejected: 1, confirmed: 0, failed: 0 });
    expect(await h.stores.operations.get(h.s.channelId, settleOpId(1))).toMatchObject({ status: "rejected", attempts: 0 });
    expect((await h.stores.channels.get(h.s.channelId))).toMatchObject({ accepted: 20_020n, settled: 0n, state: "open" });

    // Alerted with the code and the rail's own code, on the worker and on GET /admin/alerts; never an amount.
    const alerts = (await alertsOf(h)).body.alerts;
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "settle_rejected", channelId: h.s.channelId, opId: settleOpId(1), period: 1, attempts: 0, code: SCHEME_ERROR_CODES.shieldedBindingRejected, apiCode: "UNSUPPORTED_TRANSFER_ROUTE" } satisfies Partial<Alert>);
    expect(JSON.stringify(alerts)).not.toMatch(/20020|20000/);
    expect(h.logs.some((line) => line.startsWith(`settle rejected ${h.s.channelId}`))).toBe(true);

    // The vendor sees it as owed and refused: terminal, not retryable, no transfer to look for.
    const seen = (await receiptsOf(h)).body;
    expect(seen.receipts).toEqual([]);
    expect(seen.pending).toEqual([]);
    expect(seen.rejected).toEqual([{ period: 1, cumulative: "20020", amount: "20000", status: "rejected", attempts: 0, code: SCHEME_ERROR_CODES.shieldedBindingRejected, retryable: false, transaction: "" }]);

    // Never retried, in or out of any backoff, and never through any other path: the binding
    // was called once, `refund` never, and the fake has no public transfer to fall back to.
    for (let i = 0; i < 3; i++) {
      h.clock.now += 3600;
      expect(await h.redeemer.runOnce()).toMatchObject({ owed: 1, skipped: 1, rejected: 0 });
    }
    expect(h.calls.map((c) => c.kind)).toEqual(["settle"]);
    expect((await h.stores.operations.list(h.s.channelId)).map((o) => o.status)).toEqual(["rejected"]);
    // The operation cannot leave `rejected` through the store either.
    await expect(h.stores.operations.transition(h.s.channelId, settleOpId(1), { status: "pending" })).rejects.toMatchObject({ code: "illegal_transition" });

    // A rejection at close holds the same: the vendor is paid, the refund is refused, terminal, the channel stays closing.
    const r = harness();
    await r.stores.channels.put({ ...r.s.record, deposit: 2_000_000n, accepted: 500_500n, settled: 0n, latestVoucher: voucherOf(r.s, 500_500n), lastActivityAt: r.clock.now });
    await post(r.app, "/settle", envelope(r.s, refundPayload(r.s, 500_500n)));
    r.clock.now += WITHDRAW_DELAY;
    r.behaviour.refund.push(rejectedByRail);
    expect(await r.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 1, rejected: 1, refunded: 0, closed: 0 });
    r.clock.now += 3600;
    expect(await r.redeemer.closeOnce()).toMatchObject({ due: 1, skipped: 1, rejected: 0 });
    expect(r.calls.map((c) => c.kind)).toEqual(["settle", "refund"]);
    expect(r.redeemer.alerts().map((a) => [a.kind, a.code, a.apiCode])).toEqual([["refund_rejected", SCHEME_ERROR_CODES.shieldedBindingRejected, "UNSUPPORTED_TRANSFER_ROUTE"]]);
    expect((await r.stores.channels.get(r.s.channelId))?.state).toBe("closing");

    // A deposit the rail refuses is a verdict with the code, not retryable, and no amount in the message.
    const d = harness({}, { settle: () => Promise.reject(new BindingError(BINDING_ERROR_CODES.bindingRejected, "refused", { apiCode: "UNSUPPORTED_TRANSFER_ROUTE" })) });
    const verdict = await post(d.app, "/settle", envelope(d.s, depositPayload(d.s, 500_000n, CHARGE)));
    expect(verdict.status).toBe(200);
    expect(verdict.body).toMatchObject({ success: false, errorReason: SCHEME_ERROR_CODES.shieldedBindingRejected, code: SCHEME_ERROR_CODES.shieldedBindingRejected, retryable: false, transaction: "" });
    expect(String(verdict.body.error)).not.toMatch(/500000|UNSUPPORTED/);
    cleanLogs(h);
    cleanLogs(r);
  });

  it("attestation failure gives an empty /supported", async () => {
    const logs: string[] = [];
    const stores = createMemoryStores();
    const down = createFacilitatorApp({ binding: { status: "attestation_failed", error: "verifyTeeRpcIntegrity: quote verification failed" }, stores, log: (line) => logs.push(line), adminToken: ADMIN_TOKEN, receiptTokens: new Map([["x", VENDOR_TOKEN]]) });

    // /supported answers 200 with nothing payable and the code; /health says the process is up and why it refuses.
    const supported = await get<{ kinds: unknown[]; extensions: unknown[]; signers: Record<string, unknown>; extra: { error: string } }>(down, "/supported");
    expect(supported.status).toBe(200);
    expect(supported.body).toEqual({ kinds: [], extensions: [], signers: {}, extra: { error: SCHEME_ERROR_CODES.shieldedAttestationFailed } });
    const health = await get<{ status: string; binding: string; network: string | null }>(down, "/health");
    expect(health.body).toMatchObject({ status: "ok", binding: "attestation_failed", network: null });

    // Nothing is settled, verified, redeemed or served without an attested binding: 503 with the code, not retryable.
    const s = scenario();
    for (const path of ["/verify", "/settle"] as const) {
      const res = await post(down, path, envelope(s, voucherPayload(s, CHARGE)));
      expect(res.status, path).toBe(503);
      expect(res.body, path).toMatchObject({ code: SCHEME_ERROR_CODES.shieldedAttestationFailed, retryable: false });
      expect(res.body, path).not.toHaveProperty("isValid");
      expect(res.body, path).not.toHaveProperty("success");
    }
    expect((await get(down, `/receipts/${s.channelId}`, VENDOR_TOKEN)).status).toBe(503);
    expect((await post(down, "/admin/redeem", {}, ADMIN_TOKEN)).status).toBe(503);
    expect(await stores.channels.list()).toEqual([]);
    for (const line of logs) expect(line).not.toMatch(BASE58_88);

    // Through the seller: every request is a 402 naming the code with nothing to deposit into, and no resource.
    const f = await facilitatorOverHttp({ status: "attestation_failed", error: "quote verification failed" });
    const v = vendor(f.url);
    const unpaid = await v.app.request(RESOURCE);
    expect(unpaid.status).toBe(402);
    expect(decodeRequired(unpaid)).toMatchObject({ error: SCHEME_ERROR_CODES.shieldedAttestationFailed, accepts: [] });
    expect(await unpaid.json()).toMatchObject({ code: SCHEME_ERROR_CODES.shieldedAttestationFailed, retryable: false });
    expect(v.calls.resource).toBe(0);

    // Once the binding attests, the same vendor serves the same route.
    const up = await facilitatorOverHttp();
    const w = vendor(up.url);
    const required = decodeRequired(await w.app.request(RESOURCE));
    expect(required.accepts).toHaveLength(1);
    expect(shieldedEntry(required).extra.teeValidator).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});
