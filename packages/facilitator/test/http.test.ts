import { DEVNET_CAIP2 } from "@wakeless/binding";
import { SCHEME_ERROR_CODES, isSchemeErrorCode, type SettlementResponse, type SupportedResponse, type VerifyResponse } from "@wakeless/scheme";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { createFacilitatorApp, createMemoryStores, type DepositHandler, type FacilitatorOptions, type Stores } from "../src/index.js";
import { AMOUNT, CHARGE, DEPOSIT, TEE_VALIDATOR, depositPayload, envelope, fakeBinding, ready, scenario, voucherOf, voucherPayload, wireTransaction, type Scenario } from "./fixtures.js";

const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;

type Verdict = Record<string, unknown> & { error?: string; code?: string; retryable?: boolean };

interface Harness {
  app: Hono;
  stores: Stores;
  s: Scenario;
  clock: { now: number };
  logs: string[];
}

async function harness(options: Partial<FacilitatorOptions> = {}, seed = true): Promise<Harness> {
  const binding = fakeBinding();
  const s = scenario(binding.escrowAddress());
  const stores = createMemoryStores();
  if (seed) await stores.channels.put(s.record);
  const clock = { now: 1_700_000_100 };
  const logs: string[] = [];
  const app = createFacilitatorApp({ binding: ready(binding), stores, now: () => clock.now, log: (line) => logs.push(line), ...options });
  return { app, stores, s, clock, logs };
}

async function post(app: Hono, path: string, body: unknown): Promise<{ status: number; body: Verdict }> {
  const init = typeof body === "string" ? body : JSON.stringify(body);
  const res = await app.request(path, { method: "POST", body: init, headers: { "content-type": "application/json" } });
  return { status: res.status, body: (await res.json()) as Verdict };
}

async function snapshot(stores: Stores, channelId: string) {
  return { channels: await stores.channels.list(), operations: await stores.operations.list(channelId) };
}

describe("facilitator HTTP", () => {
  it("GET /supported matches the spec shape", async () => {
    const h = await harness();
    const res = await h.app.request("/supported");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SupportedResponse;
    expect(body.kinds).toHaveLength(1);
    expect(body.kinds[0]!.x402Version).toBe(2);
    expect(body.kinds[0]!.scheme).toBe("batch-settlement-shielded");
    expect(body.kinds[0]!.network).toBe(DEVNET_CAIP2);
    expect(body.kinds[0]!.extra).toEqual({
      escrowAddress: h.s.escrow,
      binding: "magicblock",
      teeValidator: TEE_VALIDATOR,
      privacyFeeBps: 10,
      maxIdleSecs: 604_800,
    });
    expect(body.extensions).toEqual([]);
    expect(body.signers).toEqual({ "solana:*": [] });
  });

  it("POST /verify leaves the store unchanged", async () => {
    const h = await harness();
    const before = await snapshot(h.stores, h.s.channelId);

    const valid = await post(h.app, "/verify", envelope(h.s, voucherPayload(h.s, CHARGE)));
    expect(valid.status).toBe(200);
    expect(valid.body).toEqual({
      isValid: true,
      payer: h.s.buyerAddress,
      extra: { channelId: h.s.channelId, balance: DEPOSIT.toString(), totalClaimed: "0", withdrawRequestedAt: null },
    } satisfies VerifyResponse);

    const tooHigh = await post(h.app, "/verify", envelope(h.s, voucherPayload(h.s, DEPOSIT + 1n)));
    expect(tooHigh.body.isValid).toBe(false);
    expect(tooHigh.body.invalidReason).toBe(SCHEME_ERROR_CODES.cumulativeExceedsDeposit);

    const deposit = await post(h.app, "/verify", envelope(h.s, depositPayload(h.s, 500_000n, CHARGE)));
    expect(deposit.body.isValid).toBe(true);

    expect(await snapshot(h.stores, h.s.channelId)).toEqual(before);
  });

  it("POST /settle twice returns the same result with replayed true", async () => {
    const h = await harness();
    const body = envelope(h.s, voucherPayload(h.s, CHARGE));
    expect((await post(h.app, "/verify", body)).body.isValid).toBe(true);

    const first = await post(h.app, "/settle", body);
    expect(first.status).toBe(200);
    expect(first.body).toEqual({
      success: true,
      transaction: "",
      network: DEVNET_CAIP2,
      payer: h.s.buyerAddress,
      extra: {
        commitmentId: `${h.s.channelId}:${CHARGE}`,
        chargedAmount: CHARGE.toString(),
        channelState: { channelId: h.s.channelId, balance: DEPOSIT.toString(), totalClaimed: "0", withdrawRequestedAt: null, chargedCumulativeAmount: CHARGE.toString() },
      },
    } satisfies SettlementResponse);

    const second = await post(h.app, "/settle", body);
    expect(second.status).toBe(200);
    const { extra: firstExtra, ...firstRest } = first.body as unknown as SettlementResponse;
    const { extra: secondExtra, ...secondRest } = second.body as unknown as SettlementResponse;
    expect(secondRest).toEqual(firstRest);
    expect(secondExtra).toEqual({ ...firstExtra, replayed: true });
    expect(first.body.extra).not.toHaveProperty("replayed");

    const stored = await h.stores.channels.get(h.s.channelId);
    expect(stored?.accepted).toBe(CHARGE);
    expect(stored?.latestVoucher?.maxClaimableAmount).toBe(CHARGE.toString());
    expect(stored?.lastActivityAt).toBe(h.clock.now);
  });

  it("two identical settles in flight settle once", async () => {
    const h = await harness();
    const body = envelope(h.s, voucherPayload(h.s, CHARGE));
    await post(h.app, "/verify", body);
    const [a, b] = await Promise.all([post(h.app, "/settle", body), post(h.app, "/settle", body)]);
    const replayed = [a, b].filter((r) => (r.body.extra as { replayed?: boolean }).replayed === true);
    expect(replayed).toHaveLength(1);
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(CHARGE);
  });

  it("POST /settle without a prior /verify is rejected", async () => {
    const h = await harness();
    const body = envelope(h.s, voucherPayload(h.s, CHARGE));
    const res = await post(h.app, "/settle", body);
    expect(res.status).toBe(200);
    expect(res.body.success).toBe(false);
    expect(res.body.errorReason).toBe("shielded_verify_required");
    expect(res.body.transaction).toBe("");
    expect(res.body.network).toBe(DEVNET_CAIP2);
    expect(res.body.payer).toBe(h.s.buyerAddress);
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(0n);

    // A verify that is older than maxTimeoutSeconds no longer authorizes the settle.
    await post(h.app, "/verify", body);
    h.clock.now += h.s.requirements.maxTimeoutSeconds + 1;
    const late = await post(h.app, "/settle", body);
    expect(late.body.errorReason).toBe("shielded_verify_required");

    // Within the window it does.
    await post(h.app, "/verify", body);
    h.clock.now += h.s.requirements.maxTimeoutSeconds - 1;
    expect((await post(h.app, "/settle", body)).body.success).toBe(true);
  });

  it("a stale voucher is rejected with cumulative_amount_mismatch", async () => {
    const h = await harness();
    const first = envelope(h.s, voucherPayload(h.s, CHARGE));
    await post(h.app, "/verify", first);
    expect((await post(h.app, "/settle", first)).body.success).toBe(true);

    // The same cumulative sent again for another resource (Ed25519 is deterministic, so the
    // voucher bytes are identical; the envelope is not) is stale, not a replay: nothing moves.
    const stale = { ...first, paymentPayload: { ...first.paymentPayload, resource: { url: "https://vendor.test/price/SOL" } } };
    expect(stale.paymentPayload).not.toEqual(first.paymentPayload);
    const verify = await post(h.app, "/verify", stale);
    expect(verify.body.isValid).toBe(false);
    expect(verify.body.invalidReason).toBe(SCHEME_ERROR_CODES.cumulativeAmountMismatch);
    const settle = await post(h.app, "/settle", stale);
    expect(settle.body.success).toBe(false);
    expect(settle.body.errorReason).toBe(SCHEME_ERROR_CODES.cumulativeAmountMismatch);
    expect(settle.body.extra).toBeUndefined();

    // Below the watermark, and above it but short of amount: both mismatches.
    for (const cumulative of [CHARGE - 1n, CHARGE + AMOUNT - 1n]) {
      const res = await post(h.app, "/verify", envelope(h.s, voucherPayload(h.s, cumulative)));
      expect(res.body.invalidReason).toBe(SCHEME_ERROR_CODES.cumulativeAmountMismatch);
    }
    // The next good one goes through.
    const next = envelope(h.s, voucherPayload(h.s, CHARGE * 2n));
    expect((await post(h.app, "/verify", next)).body.isValid).toBe(true);
    expect((await post(h.app, "/settle", next)).body.extra).toMatchObject({ commitmentId: `${h.s.channelId}:${CHARGE * 2n}`, chargedAmount: CHARGE.toString() });
  });

  it("/supported with a failed-attestation binding returns empty kinds", async () => {
    const stores = createMemoryStores();
    const app = createFacilitatorApp({ binding: { status: "attestation_failed", error: "verifier returned false" }, stores });
    const res = await app.request("/supported");
    expect(res.status).toBe(200);
    const body = (await res.json()) as SupportedResponse & { extra: { error: string } };
    expect(body.kinds).toEqual([]);
    expect(body.extra.error).toBe("shielded_attestation_failed");
    expect(body.extensions).toEqual([]);
    expect(body.signers).toEqual({});

    const s = scenario();
    const verify = await post(app, "/verify", envelope(s, voucherPayload(s, CHARGE)));
    expect(verify.status).toBe(503);
    expect(verify.body.code).toBe("shielded_attestation_failed");
    expect(verify.body.retryable).toBe(false);
  });

  it("errors follow {error, code, retryable}", async () => {
    const h = await harness();
    const good = envelope(h.s, voucherPayload(h.s, CHARGE));
    const wrongSigner = voucherPayload(h.s, CHARGE, voucherOf(h.s, CHARGE, { secretKey: new Uint8Array(32).fill(7) }));
    const unknown = scenario(h.s.escrow);
    const closing = scenario(h.s.escrow);
    await h.stores.channels.put({ ...closing.record, state: "closing" });

    const cases: { name: string; path: string; body: unknown; status: number; code: string }[] = [
      { name: "not JSON", path: "/verify", body: "{", status: 400, code: SCHEME_ERROR_CODES.invalidPayload },
      { name: "x402Version", path: "/verify", body: { ...good, x402Version: 1 }, status: 400, code: SCHEME_ERROR_CODES.invalidX402Version },
      { name: "scheme", path: "/verify", body: envelope(h.s, good.paymentPayload.payload, { ...h.s.requirements, scheme: "batch-settlement" as never }), status: 400, code: SCHEME_ERROR_CODES.unsupportedScheme },
      { name: "network", path: "/verify", body: envelope(h.s, good.paymentPayload.payload, { ...h.s.requirements, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), status: 400, code: SCHEME_ERROR_CODES.invalidNetwork },
      { name: "accepted differs", path: "/verify", body: { ...good, paymentRequirements: { ...h.s.requirements, amount: "1" } }, status: 400, code: SCHEME_ERROR_CODES.invalidPaymentRequirements },
      { name: "other escrow", path: "/verify", body: envelope(h.s, good.paymentPayload.payload, { ...h.s.requirements, extra: { ...h.s.requirements.extra, escrowAddress: unknown.buyerAddress } }), status: 400, code: SCHEME_ERROR_CODES.invalidPaymentRequirements },
      { name: "withdrawDelay", path: "/verify", body: envelope(h.s, good.paymentPayload.payload, { ...h.s.requirements, extra: { ...h.s.requirements.extra, withdrawDelay: 10 } }), status: 400, code: SCHEME_ERROR_CODES.withdrawDelayOutOfRange },
      { name: "server mode", path: "/verify", body: envelope(h.s, good.paymentPayload.payload, { ...h.s.requirements, extra: { ...h.s.requirements.extra, voucherSigner: "server" as never } }), status: 400, code: SCHEME_ERROR_CODES.payloadType },
      { name: "payload type", path: "/verify", body: envelope(h.s, { ...good.paymentPayload.payload, type: "authorization" } as never), status: 200, code: SCHEME_ERROR_CODES.payloadType },
      { name: "vendor is not payTo", path: "/verify", body: envelope(h.s, { ...good.paymentPayload.payload, channelConfig: { ...h.s.channelConfig, vendor: unknown.vendor } }), status: 200, code: SCHEME_ERROR_CODES.invalidPayload },
      { name: "channelConfig delay", path: "/verify", body: envelope(h.s, { ...good.paymentPayload.payload, channelConfig: { ...h.s.channelConfig, withdrawDelay: 901 } }), status: 200, code: SCHEME_ERROR_CODES.withdrawDelayMismatch },
      { name: "expiry", path: "/verify", body: envelope(h.s, voucherPayload(h.s, CHARGE, { ...voucherOf(h.s, CHARGE), expiresAt: 1 as never })), status: 200, code: SCHEME_ERROR_CODES.voucherExpiry },
      { name: "channel id", path: "/verify", body: envelope(h.s, voucherPayload(h.s, CHARGE, { ...voucherOf(h.s, CHARGE), channelId: unknown.channelId })), status: 200, code: SCHEME_ERROR_CODES.channelIdMismatch },
      { name: "signature", path: "/verify", body: envelope(h.s, wrongSigner), status: 200, code: SCHEME_ERROR_CODES.voucherSignature },
      { name: "unknown channel", path: "/verify", body: envelope(unknown, voucherPayload(unknown, CHARGE)), status: 200, code: SCHEME_ERROR_CODES.channelState },
      { name: "closing channel", path: "/verify", body: envelope(closing, voucherPayload(closing, CHARGE)), status: 200, code: SCHEME_ERROR_CODES.channelClosing },
      { name: "exceeds deposit", path: "/verify", body: envelope(h.s, voucherPayload(h.s, DEPOSIT + 1n)), status: 200, code: SCHEME_ERROR_CODES.cumulativeExceedsDeposit },
      { name: "stale", path: "/verify", body: envelope(h.s, voucherPayload(h.s, 1n)), status: 200, code: SCHEME_ERROR_CODES.cumulativeAmountMismatch },
      { name: "settle unverified", path: "/settle", body: good, status: 200, code: "shielded_verify_required" },
      { name: "settle bad signature", path: "/settle", body: envelope(h.s, wrongSigner), status: 200, code: SCHEME_ERROR_CODES.voucherSignature },
      { name: "deposit amount", path: "/verify", body: envelope(h.s, { ...depositPayload(h.s, 1n, CHARGE), deposit: { amount: "0", transaction: wireTransaction() } }), status: 200, code: SCHEME_ERROR_CODES.invalidPayload },
      { name: "deposit signature", path: "/verify", body: envelope(h.s, { ...depositPayload(h.s, 1n, CHARGE), depositSignature: "abc" }), status: 200, code: SCHEME_ERROR_CODES.invalidPayload },
      { name: "deposit transaction", path: "/verify", body: envelope(h.s, { ...depositPayload(h.s, 1n, CHARGE), deposit: { amount: "1", transaction: "not base64!" } }), status: 200, code: SCHEME_ERROR_CODES.invalidPayload },
      { name: "deposit transaction too long", path: "/verify", body: envelope(h.s, { ...depositPayload(h.s, 1n, CHARGE), deposit: { amount: "1", transaction: "A".repeat(1648) } }), status: 200, code: SCHEME_ERROR_CODES.invalidPayload },
      { name: "deposit short", path: "/verify", body: envelope(unknown, depositPayload(unknown, 1n, CHARGE)), status: 200, code: SCHEME_ERROR_CODES.cumulativeExceedsDeposit },
      { name: "deposit other buyer", path: "/verify", body: envelope({ ...unknown, channelConfig: unknown.channelConfig }, depositPayload({ ...unknown, channelId: h.s.channelId }, 1n, CHARGE)), status: 200, code: SCHEME_ERROR_CODES.channelIdMismatch },
      { name: "no deposit handler", path: "/settle", body: envelope(h.s, depositPayload(h.s, 500_000n, CHARGE)), status: 500, code: SCHEME_ERROR_CODES.unexpectedSettleError },
      { name: "no route", path: "/nowhere", body: {}, status: 404, code: SCHEME_ERROR_CODES.invalidPayload },
    ];

    for (const c of cases) {
      const res = await post(h.app, c.path, c.body);
      expect(res.status, c.name).toBe(c.status);
      expect(res.body.code, c.name).toBe(c.code);
      expect(isSchemeErrorCode(res.body.code), c.name).toBe(true);
      expect(typeof res.body.error, c.name).toBe("string");
      expect(res.body.error, c.name).not.toMatch(BASE58_88);
      expect(typeof res.body.retryable, c.name).toBe("boolean");
      expect(res.body.retryable, c.name).toBe(c.code === SCHEME_ERROR_CODES.unexpectedSettleError);
      if (res.status === 200 && c.path === "/verify") {
        expect(res.body.isValid, c.name).toBe(false);
        expect(res.body.invalidReason, c.name).toBe(c.code);
      }
      if (res.status === 200 && c.path === "/settle") {
        expect(res.body.success, c.name).toBe(false);
        expect(res.body.errorReason, c.name).toBe(c.code);
        expect(res.body.transaction, c.name).toBe("");
      }
    }
    // Nothing above moved the channel, and the logs name hashes and codes, never a signature.
    expect((await h.stores.channels.get(h.s.channelId))?.accepted).toBe(0n);
    for (const line of h.logs) expect(line).not.toMatch(BASE58_88);
  });

  it("hands a deposit to the deposit handler with the derived channel id and client ref", async () => {
    const calls: unknown[] = [];
    const deposits: DepositHandler = {
      settle: async (input) => {
        calls.push(input);
        return { success: true, transaction: input.payload.depositSignature, network: DEVNET_CAIP2, payer: input.payload.channelConfig.buyer, amount: input.payload.deposit.amount, extra: { commitmentId: `${input.channelId}:${input.payload.voucher.maxClaimableAmount}`, chargedAmount: input.payload.voucher.maxClaimableAmount } };
      },
    };
    const h = await harness({ deposits }, false);
    const body = envelope(h.s, depositPayload(h.s, 500_000n, CHARGE));
    const verify = await post(h.app, "/verify", body);
    expect(verify.body).toMatchObject({ isValid: true, payer: h.s.buyerAddress, extra: { channelId: h.s.channelId, balance: "0" } });

    const settle = await post(h.app, "/settle", body);
    expect(settle.status).toBe(200);
    expect(settle.body.success).toBe(true);
    expect(settle.body.transaction).toBe(body.paymentPayload.payload.type === "deposit" ? body.paymentPayload.payload.depositSignature : "");
    expect(calls).toHaveLength(1);
    expect(calls[0]).toMatchObject({ channelId: h.s.channelId, clientRef: h.s.record.clientRef });

    const again = await post(h.app, "/settle", body);
    expect(again.body.extra).toMatchObject({ replayed: true });
    expect(calls).toHaveLength(1);
  });

  it("a handler that refuses with a scheme code answers a verdict, never a 500", async () => {
    const deposits: DepositHandler = {
      settle: () => Promise.reject(Object.assign(new Error("UNSUPPORTED_TRANSFER_ROUTE"), { code: "shielded_binding_rejected" })),
    };
    const h = await harness({ deposits }, false);
    const res = await post(h.app, "/settle", envelope(h.s, depositPayload(h.s, 500_000n, CHARGE)));
    expect(res.status).toBe(200);
    expect(res.body).toMatchObject({ success: false, errorReason: "shielded_binding_rejected", code: "shielded_binding_rejected", retryable: false });
    expect(res.body.error).not.toContain("UNSUPPORTED_TRANSFER_ROUTE");
  });
});
