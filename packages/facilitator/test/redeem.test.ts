// Task 7.2: the redemption worker over a binding fake whose `settle` records what it was
// asked and answers a signature, or throws what the test says. Nothing private is simulated:
// the fake moves no balance; the real path is redeem.devnet.test.ts.
import { randomBytes } from "node:crypto";
import type { Address, Signature } from "@solana/kit";
import { BINDING_ERROR_CODES, BindingError, type SettleRef, type SettlementBinding } from "@wakeless/binding";
import { SCHEME_ERROR_CODES, encodeBase58, publicKeyOf, verifyReceipt, type SettlementReceipt } from "@wakeless/scheme";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { backoffSeconds, createFacilitatorApp, createMemoryStores, createRedeemer, feeOf, settleOpId, type Alert, type ReceiptsResponse, type RedeemDeps, type Redeemer, type Stores } from "../src/index.js";
import { address, fakeBinding, keypair, ready, scenario, type Scenario } from "./fixtures.js";

const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;
const ADMIN_TOKEN = "admin-token-for-the-tests-only";
const VENDOR_TOKEN = "vendor-token-for-the-tests-only";

interface SettleCall {
  to: Address;
  amount: bigint;
  ref: SettleRef;
}

interface Harness {
  binding: SettlementBinding;
  stores: Stores;
  s: Scenario;
  calls: SettleCall[];
  logs: string[];
  clock: { now: number };
  signer: ReturnType<typeof keypair>;
  redeemer: Redeemer;
  app: Hono;
  /** What the next `settle` calls do: a signature, or a throw. */
  behaviour: { next: (() => never)[] };
  balance: { value: bigint };
}

function signature(): Signature {
  return encodeBase58(randomBytes(64)) as Signature;
}

function harness(overrides: Partial<RedeemDeps> = {}): Harness {
  const calls: SettleCall[] = [];
  const behaviour: Harness["behaviour"] = { next: [] };
  const balance = { value: 0n };
  const binding: SettlementBinding = {
    ...fakeBinding(),
    async settle(to, amount, ref) {
      calls.push({ to, amount, ref });
      const next = behaviour.next.shift();
      if (next !== undefined) next();
      const sig = signature();
      return { sig, receipt: { channelId: ref.channelId, period: ref.period, cumulative: ref.cumulative, amount, signature: sig, ref: ref.id } };
    },
    privateBalance: () => Promise.resolve(balance.value),
  };
  const s = scenario(binding.escrowAddress());
  const stores = createMemoryStores();
  const logs: string[] = [];
  const clock = { now: 1_700_000_300 };
  const signer = keypair();
  const redeemer = createRedeemer({ binding, stores, signer, now: () => clock.now, log: (line) => logs.push(line), ...overrides });
  const app = createFacilitatorApp({
    binding: ready(binding),
    stores,
    now: () => clock.now,
    log: (line) => logs.push(line),
    redeemer,
    adminToken: ADMIN_TOKEN,
    receiptTokens: new Map([[s.vendor, VENDOR_TOKEN]]),
    receiptSigners: [redeemer.signer],
  });
  return { binding, stores, s, calls, logs, clock, signer, redeemer, app, behaviour, balance };
}

/** A channel with twenty paid calls accepted and nothing settled. */
async function owedChannel(h: Harness, accepted = 20_020n, s = h.s): Promise<void> {
  await h.stores.channels.put({ ...s.record, deposit: 100_000n, accepted, settled: 0n });
}

const rejectedByRail = () => {
  throw new BindingError(BINDING_ERROR_CODES.bindingRejected, "the private transfer was refused", { apiCode: "UNSUPPORTED_TRANSFER_ROUTE" });
};
const railDown = () => {
  throw new Error("ECONNRESET");
};

async function get(app: Hono, path: string, token?: string, init: RequestInit = {}) {
  const res = await app.request(path, { ...init, headers: { ...(token === undefined ? {} : { authorization: `Bearer ${token}` }), ...(init.headers ?? {}) } });
  return { status: res.status, body: (await res.json()) as Record<string, unknown> };
}

describe("redemption worker", () => {
  it("pending to confirmed sets settled equal to accepted and stores the receipt", async () => {
    const h = await Promise.resolve(harness());
    await owedChannel(h);

    const summary = await h.redeemer.runOnce();
    expect(summary).toEqual({ owed: 1, confirmed: 1, failed: 0, rejected: 0, skipped: 0 });

    // One call: the vendor, the owed amount net of the 10 bps fee, the period reference.
    expect(h.calls).toHaveLength(1);
    const call = h.calls[0]!;
    expect(call.to).toBe(h.s.vendor);
    expect(call.amount).toBe(20_020n - feeOf(20_020n, 10));
    expect(call.amount).toBe(20_000n);
    expect(call.ref.id).toBe(h.s.record.clientRef);
    expect(call.ref.period).toBe(1);
    expect(call.ref.cumulative).toBe(20_020n);
    expect(call.ref.channelId).toMatch(/^[0-9a-f]{64}$/);

    const channel = await h.stores.channels.get(h.s.channelId);
    expect(channel?.settled).toBe(20_020n);
    expect(channel?.accepted).toBe(20_020n);

    const ops = await h.stores.operations.list(h.s.channelId);
    expect(ops).toHaveLength(1);
    const op = ops[0]!;
    expect(op.opId).toBe(settleOpId(1));
    expect(op.type).toBe("settle");
    expect(op.status).toBe("confirmed");
    expect(op.attempts).toBe(0);
    expect(op.signature).toMatch(BASE58_88);
    expect(op.receipt).toMatchObject({ channelId: h.s.channelId, period: 1, cumulative: "20020", amount: "20000", signature: op.signature });
    expect(typeof op.receipt?.facilitatorSignature).toBe("string");

    // Nothing more is owed: a second run makes no transfer.
    expect(await h.redeemer.runOnce()).toEqual({ owed: 0, confirmed: 0, failed: 0, rejected: 0, skipped: 0 });
    expect(h.calls).toHaveLength(1);
    for (const line of h.logs) {
      expect(line).not.toMatch(BASE58_88);
      expect(line).not.toMatch(/20020|20000/);
    }
  });

  it("pending to failed increments attempts and keeps the amount owed", async () => {
    const h = harness({ backoff: { baseSeconds: 60, maxSeconds: 3600 } });
    await owedChannel(h);
    h.behaviour.next.push(railDown);

    expect(await h.redeemer.runOnce()).toMatchObject({ owed: 1, failed: 1, confirmed: 0 });
    const [op] = await h.stores.operations.list(h.s.channelId);
    expect(op).toMatchObject({ opId: settleOpId(1), status: "failed", attempts: 1 });
    expect(op?.signature).toBeUndefined();
    expect((await h.stores.channels.get(h.s.channelId))?.settled).toBe(0n);

    // Inside the backoff the operation rests; after it the retry goes failed → pending → confirmed for the same period.
    expect(await h.redeemer.runOnce()).toMatchObject({ owed: 1, skipped: 1 });
    expect(h.calls).toHaveLength(1);
    h.clock.now += backoffSeconds(1);
    expect(await h.redeemer.runOnce()).toMatchObject({ owed: 1, confirmed: 1 });
    expect(h.calls).toHaveLength(2);
    expect(h.calls[1]!.ref.period).toBe(1);
    expect(h.calls[1]!.amount).toBe(20_000n);
    const ops = await h.stores.operations.list(h.s.channelId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ status: "confirmed", attempts: 1 });
    expect((await h.stores.channels.get(h.s.channelId))?.settled).toBe(20_020n);
    expect(h.redeemer.alerts()).toEqual([]);
  });

  it("the attempts cap stops retries and alerts once", async () => {
    const h = harness({ maxAttempts: 2, backoff: { baseSeconds: 1, maxSeconds: 1 } });
    await owedChannel(h);
    h.behaviour.next.push(railDown, railDown, railDown);
    for (let i = 0; i < 4; i++) {
      await h.redeemer.runOnce();
      h.clock.now += 10;
    }
    expect(h.calls).toHaveLength(2);
    expect((await h.stores.operations.get(h.s.channelId, settleOpId(1)))?.attempts).toBe(2);
    expect(h.redeemer.alerts().map((a) => a.kind)).toEqual(["settle_attempts_exhausted"]);
    expect((await h.stores.channels.get(h.s.channelId))?.settled).toBe(0n);
  });

  it("shielded_binding_rejected is terminal, alerted, and never retried", async () => {
    const h = harness({ backoff: { baseSeconds: 1, maxSeconds: 1 } });
    await owedChannel(h);
    h.behaviour.next.push(rejectedByRail);

    expect(await h.redeemer.runOnce()).toMatchObject({ owed: 1, rejected: 1 });
    const [op] = await h.stores.operations.list(h.s.channelId);
    expect(op).toMatchObject({ opId: settleOpId(1), status: "rejected", attempts: 0 });
    expect((await h.stores.channels.get(h.s.channelId))?.settled).toBe(0n);

    // Alerted, with the code and the rail's own code, and nothing of the amount.
    const alerts = h.redeemer.alerts();
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toMatchObject({ kind: "settle_rejected", channelId: h.s.channelId, opId: settleOpId(1), period: 1, code: SCHEME_ERROR_CODES.shieldedBindingRejected, apiCode: "UNSUPPORTED_TRANSFER_ROUTE" });
    expect(JSON.stringify(alerts)).not.toMatch(/20020|20000/);
    const listed = await get(h.app, "/admin/alerts", ADMIN_TOKEN);
    expect(listed.status).toBe(200);
    expect((listed.body.alerts as Alert[]).map((a) => a.kind)).toEqual(["settle_rejected"]);

    // The binding was called once; later runs, in and out of any backoff, call it no more:
    // no retry, and the binding fake has no public path to fall back to.
    for (let i = 0; i < 3; i++) {
      h.clock.now += 3600;
      expect(await h.redeemer.runOnce()).toMatchObject({ owed: 1, skipped: 1, rejected: 0 });
    }
    expect(h.calls).toHaveLength(1);
    expect((await h.stores.operations.list(h.s.channelId)).map((o) => o.status)).toEqual(["rejected"]);
    expect(h.logs.some((line) => line.includes("settle rejected"))).toBe(true);
  });

  it("one transfer per channel per run", async () => {
    const h = harness();
    const second = scenario(h.binding.escrowAddress());
    const third = scenario(h.binding.escrowAddress());
    await owedChannel(h, 20_020n);
    await owedChannel(h, 5_005n, second);
    await owedChannel(h, 0n, third); // nothing owed
    await h.stores.channels.put({ ...scenario(h.binding.escrowAddress()).record, accepted: 3_003n, settled: 3_003n }); // already settled
    await h.stores.channels.put({ ...scenario(h.binding.escrowAddress()).record, accepted: 3_003n, settled: 0n, state: "closing" }); // not open

    expect(await h.redeemer.runOnce()).toEqual({ owed: 2, confirmed: 2, failed: 0, rejected: 0, skipped: 0 });
    expect(h.calls).toHaveLength(2);
    expect(new Set(h.calls.map((c) => c.to))).toEqual(new Set([h.s.vendor, second.vendor]));
    expect(h.calls.every((c) => c.ref.period === 1)).toBe(true);

    // More accepted on the first channel: the next run makes one more transfer, period 2, for the difference.
    await h.stores.channels.update(h.s.channelId, (c) => ({ ...c!, accepted: 30_030n }));
    expect(await h.redeemer.runOnce()).toEqual({ owed: 1, confirmed: 1, failed: 0, rejected: 0, skipped: 0 });
    expect(h.calls).toHaveLength(3);
    expect(h.calls[2]).toMatchObject({ to: h.s.vendor, amount: 10_010n - feeOf(10_010n, 10) });
    expect(h.calls[2]!.ref.period).toBe(2);
    expect(h.calls[2]!.ref.cumulative).toBe(30_030n);
    expect((await h.stores.operations.list(h.s.channelId)).map((o) => o.opId)).toEqual([settleOpId(1), settleOpId(2)]);

    // Two runs at once are serialised: the second sees nothing owed.
    await h.stores.channels.update(h.s.channelId, (c) => ({ ...c!, accepted: 40_040n }));
    const [a, b] = await Promise.all([h.redeemer.runOnce(), h.redeemer.runOnce()]);
    expect(a.confirmed + b.confirmed).toBe(1);
    expect(h.calls).toHaveLength(4);
  });

  it("the facilitator-signed receipt verifies", async () => {
    const h = harness();
    await owedChannel(h);
    await h.redeemer.runOnce();

    // Through the worker, and through the vendor-token protected route, against the advertised signer.
    const supported = (await (await h.app.request("/supported")).json()) as { signers: Record<string, string[]> };
    expect(supported.signers["solana:*"]).toEqual([publicKeyOf(h.signer)]);
    const signer = supported.signers["solana:*"]![0]!;

    const receipts = await h.redeemer.receipts(h.s.channelId);
    expect(receipts).toHaveLength(1);
    const receipt = receipts[0]!;
    expect(receipt).toMatchObject({ channelId: h.s.channelId, period: 1, cumulative: "20020", amount: "20000", signature: h.calls[0] && (await h.stores.operations.get(h.s.channelId, settleOpId(1)))!.signature });
    expect(verifyReceipt(signer, receipt)).toBe(true);

    const over = await get(h.app, `/receipts/${h.s.channelId}`, VENDOR_TOKEN);
    expect(over.status).toBe(200);
    const body = over.body as unknown as ReceiptsResponse;
    expect(body.signer).toBe(signer);
    expect(body.receipts).toEqual(receipts);
    expect(verifyReceipt(signer, body.receipts[0]!)).toBe(true);

    // Altered in any field, or signed by another key, it does not verify.
    const altered: SettlementReceipt[] = [
      { ...receipt, amount: "20001" },
      { ...receipt, cumulative: "20021" },
      { ...receipt, period: 2 },
      { ...receipt, channelId: scenario().channelId },
      { ...receipt, signature: signature() },
    ];
    for (const r of altered) expect(verifyReceipt(signer, r)).toBe(false);
    expect(verifyReceipt(publicKeyOf(keypair()), receipt)).toBe(false);
  });

  it("a pending operation at startup is reconciled, not resent", async () => {
    // Two channels, each with a transfer the previous process died inside: one left the
    // escrow (the balance is short by its amount), one did not (the amount is still there).
    const h = harness({ backoff: { baseSeconds: 1, maxSeconds: 1 } });
    const other = scenario(h.binding.escrowAddress());
    await owedChannel(h, 20_020n);
    await owedChannel(h, 50_050n, other);
    const payload = (period: number, cumulative: bigint, s: Scenario) => {
      const gross = cumulative;
      const amount = gross - feeOf(gross, 10);
      return { period, cumulative: cumulative.toString(), gross: gross.toString(), amount: amount.toString(), clientRef: s.record.clientRef };
    };
    await h.stores.operations.reserve({ opId: settleOpId(1), channelId: h.s.channelId, type: "settle", payload: payload(1, 20_020n, h.s) });
    await h.stores.operations.reserve({ opId: settleOpId(1), channelId: other.channelId, type: "settle", payload: payload(1, 50_050n, other) });
    // Deposits 200 000 in all; the first channel's 20 000 left the escrow, the second's 50 000 did not.
    h.balance.value = 200_000n - 20_000n;

    expect(await h.redeemer.reconcile()).toEqual({ pending: 2, sent: 1, unsent: 1 });
    expect(h.calls).toHaveLength(0);

    const sent = await h.stores.operations.get(h.s.channelId, settleOpId(1));
    expect(sent).toMatchObject({ status: "confirmed", attempts: 0, receipt: { reconciled: true, period: 1, cumulative: "20020", amount: "20000" } });
    expect(sent?.signature).toBeUndefined();
    expect((await h.stores.channels.get(h.s.channelId))?.settled).toBe(20_020n);
    expect(await h.redeemer.receipts(h.s.channelId)).toEqual([]); // No transfer signature, so no signed receipt.

    const unsent = await h.stores.operations.get(other.channelId, settleOpId(1));
    expect(unsent).toMatchObject({ status: "failed", attempts: 1 });
    expect((await h.stores.channels.get(other.channelId))?.settled).toBe(0n);

    expect(new Map(h.redeemer.alerts().map((a) => [a.channelId, a.kind]))).toEqual(
      new Map([
        [h.s.channelId, "settle_reconciled_sent"],
        [other.channelId, "settle_reconciled_unsent"],
      ]),
    );

    // The next run resends only the unsent one, as a retry of the same period.
    h.clock.now += 10;
    expect(await h.redeemer.runOnce()).toEqual({ owed: 1, confirmed: 1, failed: 0, rejected: 0, skipped: 0 });
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]).toMatchObject({ to: other.vendor, amount: 50_000n });
    expect(h.calls[0]!.ref.period).toBe(1);
    expect(await h.redeemer.receipts(other.channelId)).toHaveLength(1);
    for (const line of h.logs) expect(line).not.toMatch(BASE58_88);
  });

  it("reconcile with nothing pending reads no balance", async () => {
    const h = harness({ binding: { ...fakeBinding(), privateBalance: () => Promise.reject(new Error("must not be read")) } });
    await owedChannel(h);
    expect(await h.redeemer.reconcile()).toEqual({ pending: 0, sent: 0, unsent: 0 });
  });

  it("the timer runs the worker and stop ends it", async () => {
    let tick: (() => void) | undefined;
    let cleared: unknown;
    const h = harness({
      setInterval: (fn) => {
        tick = fn;
        return "handle";
      },
      clearInterval: (handle) => {
        cleared = handle;
      },
    });
    await owedChannel(h);
    h.redeemer.start(60_000);
    expect(tick).toBeDefined();
    tick!();
    await new Promise((r) => setTimeout(r, 0));
    expect(h.calls).toHaveLength(1);
    h.redeemer.stop();
    expect(cleared).toBe("handle");
  });
});

describe("admin and receipt routes", () => {
  it("POST /admin/redeem is loopback-only and token-protected and triggers one run", async () => {
    const h = harness();
    await owedChannel(h);

    const noToken = await get(h.app, "/admin/redeem", undefined, { method: "POST" });
    expect(noToken.status).toBe(401);
    expect(noToken.body).toMatchObject({ code: SCHEME_ERROR_CODES.shieldedUnauthorized, retryable: false });
    const wrongToken = await get(h.app, "/admin/redeem", "not-the-admin-token-at-all", { method: "POST" });
    expect(wrongToken.status).toBe(401);
    expect(h.calls).toHaveLength(0);

    const run = await get(h.app, "/admin/redeem", ADMIN_TOKEN, { method: "POST" });
    expect(run.status).toBe(200);
    expect(run.body).toEqual({ owed: 1, confirmed: 1, failed: 0, rejected: 0, skipped: 0 });
    expect(h.calls).toHaveLength(1);

    // The same app seen from another address refuses before the token is read.
    const remote = createFacilitatorApp({ binding: ready(h.binding), stores: h.stores, redeemer: h.redeemer, adminToken: ADMIN_TOKEN, clientAddress: () => "203.0.113.9" });
    const far = await get(remote, "/admin/redeem", ADMIN_TOKEN, { method: "POST" });
    expect(far.status).toBe(403);
    expect(far.body).toMatchObject({ code: SCHEME_ERROR_CODES.shieldedUnauthorized });
    const local = createFacilitatorApp({ binding: ready(h.binding), stores: h.stores, redeemer: h.redeemer, adminToken: ADMIN_TOKEN, clientAddress: () => "::ffff:127.0.0.1" });
    expect((await get(local, "/admin/alerts", ADMIN_TOKEN)).status).toBe(200);

    // No token configured: disabled, whatever is sent.
    const disabled = createFacilitatorApp({ binding: ready(h.binding), stores: h.stores, redeemer: h.redeemer });
    expect((await get(disabled, "/admin/redeem", ADMIN_TOKEN, { method: "POST" })).status).toBe(403);
    expect(h.calls).toHaveLength(1);

    // The token never reaches a log line.
    for (const line of h.logs) expect(line).not.toContain(ADMIN_TOKEN);
  });

  it("GET /receipts/:channelId answers only the channel's vendor", async () => {
    const h = harness();
    const other = scenario(h.binding.escrowAddress());
    await owedChannel(h);
    await owedChannel(h, 5_005n, other);
    await h.redeemer.runOnce();

    expect((await get(h.app, `/receipts/${h.s.channelId}`)).status).toBe(401);
    expect((await get(h.app, `/receipts/${h.s.channelId}`, "not-a-vendor-token-at-all")).status).toBe(401);
    // Another vendor's channel, an unknown channel and a malformed id all look the same.
    expect((await get(h.app, `/receipts/${other.channelId}`, VENDOR_TOKEN)).status).toBe(404);
    expect((await get(h.app, `/receipts/${scenario().channelId}`, VENDOR_TOKEN)).status).toBe(404);
    expect((await get(h.app, `/receipts/not-a-channel`, VENDOR_TOKEN)).status).toBe(404);

    const mine = await get(h.app, `/receipts/${h.s.channelId}`, VENDOR_TOKEN);
    expect(mine.status).toBe(200);
    expect((mine.body.receipts as SettlementReceipt[]).map((r) => r.period)).toEqual([1]);
    for (const line of h.logs) {
      expect(line).not.toContain(VENDOR_TOKEN);
      expect(line).not.toMatch(BASE58_88);
    }
  });

  it("GET /admin/channels lists accepted, settled and settle operations per channel, admin only", async () => {
    // A confirmed redemption.
    const h = harness();
    const other = scenario(h.binding.escrowAddress());
    await owedChannel(h);
    await owedChannel(h, 5_005n, other);
    await h.redeemer.runOnce();

    expect((await get(h.app, "/admin/channels")).status).toBe(401);
    expect((await get(h.app, "/admin/channels", VENDOR_TOKEN)).status).toBe(401);
    expect((await get(h.app, "/admin/channels?vendor=not-an-address", ADMIN_TOKEN)).status).toBe(400);

    const all = await get(h.app, "/admin/channels", ADMIN_TOKEN);
    expect(all.status).toBe(200);
    expect((all.body.channels as { channelId: string }[]).map((c) => c.channelId)).toEqual([h.s.channelId, other.channelId].sort());
    const mine = await get(h.app, `/admin/channels?vendor=${h.s.vendor}`, ADMIN_TOKEN);
    expect(mine.body).toEqual({ channels: [{ channelId: h.s.channelId, vendor: h.s.vendor, state: "open", accepted: "20020", settled: "20020", settle: { confirmed: 1, pending: 0, failed: 0, rejected: 0, lastPeriod: 1 } }] });
    expect((await get(h.app, `/admin/channels?vendor=${address()}`, ADMIN_TOKEN)).body).toEqual({ channels: [] });
    // Nothing about the buyer, a voucher or a signature.
    expect(JSON.stringify(all.body)).not.toContain(h.s.buyerAddress);
    expect(JSON.stringify(all.body)).not.toMatch(BASE58_88);
    for (const line of h.logs) expect(line).not.toContain(ADMIN_TOKEN);

    // A failed one, on its own harness: owed, one failed operation, settled unchanged.
    const f = harness();
    await owedChannel(f);
    f.behaviour.next.push(railDown);
    await f.redeemer.runOnce();
    const failed = await get(f.app, `/admin/channels?vendor=${f.s.vendor}`, ADMIN_TOKEN);
    expect(failed.body).toEqual({ channels: [{ channelId: f.s.channelId, vendor: f.s.vendor, state: "open", accepted: "20020", settled: "0", settle: { confirmed: 0, pending: 0, failed: 1, rejected: 0, lastPeriod: 1 } }] });
  });

  it("without a worker the routes answer 500 and without an attested binding 503", async () => {
    const h = harness();
    const none = createFacilitatorApp({ binding: ready(h.binding), stores: h.stores, adminToken: ADMIN_TOKEN, receiptTokens: new Map([[h.s.vendor, VENDOR_TOKEN]]) });
    expect((await get(none, "/admin/redeem", ADMIN_TOKEN, { method: "POST" })).status).toBe(500);
    expect((await get(none, `/receipts/${h.s.channelId}`, VENDOR_TOKEN)).status).toBe(500);
    const down = createFacilitatorApp({ binding: { status: "attestation_failed", error: "no" }, stores: h.stores, redeemer: h.redeemer, adminToken: ADMIN_TOKEN, receiptTokens: new Map([[h.s.vendor, VENDOR_TOKEN]]) });
    expect((await get(down, "/admin/redeem", ADMIN_TOKEN, { method: "POST" })).status).toBe(503);
    expect((await get(down, `/receipts/${h.s.channelId}`, VENDOR_TOKEN)).status).toBe(503);
  });
});

describe("fee and backoff", () => {
  it("feeOf rounds down and backoff doubles to a cap", () => {
    expect(feeOf(20_020n, 10)).toBe(20n);
    expect(feeOf(1_001n, 10)).toBe(1n);
    expect(feeOf(999n, 10)).toBe(0n);
    expect(feeOf(0n, 10)).toBe(0n);
    expect(() => feeOf(1n, 10_001)).toThrow(RangeError);
    expect(backoffSeconds(0)).toBe(0);
    expect(backoffSeconds(1)).toBe(60);
    expect(backoffSeconds(3)).toBe(240);
    expect(backoffSeconds(10)).toBe(3600);
    expect(address()).toMatch(/^[1-9A-HJ-NP-Za-km-z]{32,44}$/);
  });
});
