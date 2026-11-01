// confirmDeposit over a binding fake that answers `readDeposit` the way the real one does:
// a match only for the signature, reference, buyer and amount of a transfer it "saw", and
// never twice. Nothing private is simulated; the real path is deposit.devnet.test.ts.
import { randomBytes } from "node:crypto";
import type { Signature } from "@solana/kit";
import { BINDING_ERROR_CODES, BindingError, DEVNET_CAIP2, type DepositRef, type SettlementBinding } from "@wakeless/binding";
import { SCHEME_ERROR_CODES, clientRefOf, encodeBase58, type SettlementResponse } from "@wakeless/scheme";
import { describe, expect, it } from "vitest";
import { Rejection, confirmDeposit, createDepositHandler, createFacilitatorApp, depositOpId, type DepositDeps, type Stores } from "../src/index.js";
import { AMOUNT, CHARGE, address, depositPayload, envelope, fakeBinding, ready, scenario, type Scenario } from "./fixtures.js";
import { createMemoryStores } from "../src/stores/memory.js";

const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;

/** What the buyer's rail did: a private transfer the facilitator's binding can later confirm. */
interface SeenDeposit {
  signature: string;
  ref: string;
  buyer: string;
  amount: bigint;
  transaction: string;
}

interface Harness {
  binding: SettlementBinding;
  stores: Stores;
  deps: DepositDeps;
  s: Scenario;
  seen: SeenDeposit[];
  calls: { sig: Signature; ref: DepositRef }[];
  logs: string[];
  /** Records a transfer as the buyer's rail would have made it and returns the payload for it. */
  made(amount: bigint, cumulative: bigint, s?: Scenario, ref?: string): ReturnType<typeof depositPayload>;
}

function harness(readDeposit?: SettlementBinding["readDeposit"]): Harness {
  const seen: SeenDeposit[] = [];
  const calls: { sig: Signature; ref: DepositRef }[] = [];
  const credited = new Set<string>();
  const binding: SettlementBinding = {
    ...fakeBinding(),
    readDeposit:
      readDeposit ??
      (async (sig, ref) => {
        calls.push({ sig, ref });
        if (credited.has(sig)) return null;
        const match = seen.find((d) => d.signature === sig && d.ref === ref.id && d.buyer === ref.buyer && d.amount === ref.amount && d.transaction === ref.transaction);
        if (!match) return null;
        credited.add(sig);
        return { amount: ref.amount, buyer: ref.buyer };
      }),
  };
  const s = scenario(binding.escrowAddress());
  const stores = createMemoryStores();
  const logs: string[] = [];
  const deps: DepositDeps = { binding, stores, now: () => 1_700_000_200, log: (line) => logs.push(line) };
  return {
    binding,
    stores,
    deps,
    s,
    seen,
    calls,
    logs,
    made(amount, cumulative, sc = s, ref = clientRefOf(sc.channelId)) {
      const payload = depositPayload(sc, amount, cumulative);
      seen.push({ signature: payload.depositSignature, ref, buyer: sc.buyerAddress, amount, transaction: payload.deposit.transaction });
      return payload;
    },
  };
}

async function rejection(work: Promise<unknown>): Promise<Rejection> {
  const error: unknown = await work.then(
    () => new Error("expected a rejection"),
    (e: unknown) => e,
  );
  if (error instanceof Rejection) return error;
  throw error;
}

describe("confirmDeposit", () => {
  it("confirmDeposit creates the channel with the deposited amount", async () => {
    const h = harness();
    const payload = h.made(500_000n, CHARGE);
    const response = await confirmDeposit({ payload, requirements: h.s.requirements }, h.deps);

    expect(response).toEqual({
      success: true,
      transaction: payload.depositSignature,
      network: DEVNET_CAIP2,
      payer: h.s.buyerAddress,
      amount: "500000",
      extra: {
        commitmentId: `${h.s.channelId}:${CHARGE}`,
        chargedAmount: CHARGE.toString(),
        channelState: { channelId: h.s.channelId, balance: "500000", totalClaimed: "0", withdrawRequestedAt: null, chargedCumulativeAmount: CHARGE.toString() },
      },
    } satisfies SettlementResponse);

    const record = await h.stores.channels.get(h.s.channelId);
    expect(record).toEqual({
      channelId: h.s.channelId,
      clientRef: clientRefOf(h.s.channelId),
      buyer: h.s.buyerAddress,
      vendor: h.s.vendor,
      mint: h.s.channelConfig.mint,
      deposit: 500_000n,
      settled: 0n,
      accepted: CHARGE,
      latestVoucher: payload.voucher,
      state: "open",
      lastActivityAt: 1_700_000_200,
    });
    // The binding was asked exactly once, with the derived reference and the signed transaction.
    expect(h.calls).toHaveLength(1);
    expect(h.calls[0]!.sig).toBe(payload.depositSignature);
    expect(h.calls[0]!.ref).toEqual({ id: clientRefOf(h.s.channelId), buyer: h.s.buyerAddress, amount: 500_000n, transaction: payload.deposit.transaction });
    // The signature is held as a confirmed deposit operation; its id is not the signature.
    const ops = await h.stores.operations.list(h.s.channelId);
    expect(ops).toHaveLength(1);
    expect(ops[0]).toMatchObject({ opId: depositOpId(payload.depositSignature), type: "deposit", status: "confirmed", signature: payload.depositSignature, attempts: 0 });
    expect(ops[0]!.opId).not.toContain(payload.depositSignature);
    for (const line of h.logs) expect(line).not.toMatch(BASE58_88);
  });

  it("a deposit with a wrong clientRef is rejected", async () => {
    const h = harness();
    // The buyer's transfer carried some other reference than clientRefOf(channelId).
    const payload = h.made(500_000n, CHARGE, h.s, "1001");
    const r = await rejection(confirmDeposit({ payload, requirements: h.s.requirements }, h.deps));
    expect(r.code).toBe(SCHEME_ERROR_CODES.invalidTransactionState);
    expect(r.payer).toBe(h.s.buyerAddress);
    expect(r.transaction).toBeUndefined();
    expect(await h.stores.channels.get(h.s.channelId)).toBeUndefined();
    const [op] = await h.stores.operations.list(h.s.channelId);
    expect(op).toMatchObject({ status: "failed", attempts: 1 });
    expect(op).not.toHaveProperty("signature");

    // Once the right transfer exists the same channel can still be opened.
    const good = h.made(500_000n, CHARGE);
    expect((await confirmDeposit({ payload: good, requirements: h.s.requirements }, h.deps)).success).toBe(true);
    expect((await h.stores.channels.get(h.s.channelId))?.deposit).toBe(500_000n);
  });

  it("a reused deposit signature is rejected", async () => {
    const h = harness();
    const payload = h.made(500_000n, CHARGE);
    expect((await confirmDeposit({ payload, requirements: h.s.requirements }, h.deps)).success).toBe(true);

    // The same signature presented again as a top-up of the same channel: refused by the
    // store, before the binding is asked.
    const again = { ...depositPayload(h.s, 500_000n, CHARGE * 2n), depositSignature: payload.depositSignature, deposit: payload.deposit };
    const r = await rejection(confirmDeposit({ payload: again, requirements: h.s.requirements }, h.deps));
    expect(r.code).toBe(SCHEME_ERROR_CODES.duplicateSettlement);
    expect(h.calls).toHaveLength(1);
    expect((await h.stores.channels.get(h.s.channelId))?.deposit).toBe(500_000n);

    // The same signature presented for another channel of the same buyer (another salt):
    // the binding credits a signature once, so it is not confirmed and nothing is recorded.
    const other = { ...h.s, channelConfig: { ...h.s.channelConfig, salt: "8" } };
    const { deriveChannelId } = await import("@wakeless/scheme");
    const otherId = deriveChannelId({ buyer: h.s.buyerAddress, escrowAddress: h.s.escrow, mint: h.s.channelConfig.mint, salt: "8" });
    const otherScenario: Scenario = { ...other, channelId: otherId, record: { ...h.s.record, channelId: otherId, clientRef: clientRefOf(otherId) } };
    const elsewhere = { ...depositPayload(otherScenario, 500_000n, CHARGE), depositSignature: payload.depositSignature, deposit: payload.deposit };
    const r2 = await rejection(confirmDeposit({ payload: elsewhere, requirements: h.s.requirements }, h.deps));
    expect(r2.code).toBe(SCHEME_ERROR_CODES.invalidTransactionState);
    expect(await h.stores.channels.get(otherId)).toBeUndefined();
    expect((await h.stores.channels.get(h.s.channelId))?.deposit).toBe(500_000n);
  });

  it("a deposit for an existing channel from a different buyer is rejected", async () => {
    const h = harness();
    // A record under this channel id that names another buyer (a corrupted or foreign record).
    await h.stores.channels.put({ ...h.s.record, buyer: address(), deposit: 100n, accepted: 0n });
    const payload = h.made(500_000n, CHARGE);
    const r = await rejection(confirmDeposit({ payload, requirements: h.s.requirements }, h.deps));
    expect(r.code).toBe(SCHEME_ERROR_CODES.channelState);
    expect(r.payer).toBe(h.s.buyerAddress);
    // Refused before the binding was asked or anything reserved: no credit to lose.
    expect(h.calls).toHaveLength(0);
    expect(await h.stores.operations.list(h.s.channelId)).toEqual([]);
    expect((await h.stores.channels.get(h.s.channelId))?.deposit).toBe(100n);

    // Another vendor or mint on the record is the same refusal.
    await h.stores.channels.put({ ...h.s.record, vendor: address(), deposit: 100n });
    expect((await rejection(confirmDeposit({ payload: h.made(500_000n, CHARGE), requirements: h.s.requirements }, h.deps))).code).toBe(SCHEME_ERROR_CODES.channelState);
    // A closing channel takes no deposit.
    await h.stores.channels.put({ ...h.s.record, state: "closing" });
    expect((await rejection(confirmDeposit({ payload: h.made(500_000n, CHARGE), requirements: h.s.requirements }, h.deps))).code).toBe(SCHEME_ERROR_CODES.channelClosing);
  });

  it("a top-up adds to the existing channel deposit", async () => {
    const h = harness();
    const first = h.made(500_000n, CHARGE);
    await confirmDeposit({ payload: first, requirements: h.s.requirements }, h.deps);
    // Twenty vouchers later the watermark stands at 20 × CHARGE.
    await h.stores.channels.update(h.s.channelId, (c) => ({ ...c!, accepted: CHARGE * 20n }));

    const topUp = h.made(250_000n, CHARGE * 21n);
    const response = await confirmDeposit({ payload: topUp, requirements: h.s.requirements }, h.deps);
    expect(response.success).toBe(true);
    expect(response.amount).toBe("250000");
    expect(response.extra).toMatchObject({ commitmentId: `${h.s.channelId}:${CHARGE * 21n}`, chargedAmount: CHARGE.toString(), channelState: { balance: "750000", chargedCumulativeAmount: (CHARGE * 21n).toString() } });

    const record = await h.stores.channels.get(h.s.channelId);
    expect(record?.deposit).toBe(750_000n);
    expect(record?.accepted).toBe(CHARGE * 21n);
    expect(record?.latestVoucher).toEqual(topUp.voucher);
    expect((await h.stores.operations.list(h.s.channelId)).map((o) => o.status)).toEqual(["confirmed", "confirmed"]);

    // A top-up whose voucher does not clear the watermark is refused before the binding is asked.
    const stale = h.made(250_000n, CHARGE * 21n);
    const r = await rejection(confirmDeposit({ payload: stale, requirements: h.s.requirements }, h.deps));
    expect(r.code).toBe(SCHEME_ERROR_CODES.cumulativeAmountMismatch);
    expect(h.calls).toHaveLength(2);
    expect((await h.stores.channels.get(h.s.channelId))?.deposit).toBe(750_000n);
  });

  it("a confirmation in flight answers settlement_pending with the signature, and a failed one is tried again", async () => {
    const h = harness();
    const payload = h.made(500_000n, CHARGE);
    const opId = depositOpId(payload.depositSignature);
    await h.stores.operations.reserve({ opId, channelId: h.s.channelId, type: "deposit", payload: {} });
    const pending = await rejection(confirmDeposit({ payload, requirements: h.s.requirements }, h.deps));
    expect(pending.code).toBe(SCHEME_ERROR_CODES.settlementPending);
    expect(pending.transaction).toBe(payload.depositSignature);
    expect(h.calls).toHaveLength(0);

    await h.stores.operations.transition(h.s.channelId, opId, { status: "failed" });
    expect((await confirmDeposit({ payload, requirements: h.s.requirements }, h.deps)).success).toBe(true);
    expect(await h.stores.operations.get(h.s.channelId, opId)).toMatchObject({ status: "confirmed", attempts: 1 });
  });

  it("a binding refusal leaves the operation failed and reaches the caller with its code", async () => {
    const h = harness(async () => {
      throw new BindingError(BINDING_ERROR_CODES.bindingRejected, "refused", { apiCode: "TEE_INGRESS" });
    });
    const payload = h.made(500_000n, CHARGE);
    const error = await confirmDeposit({ payload, requirements: h.s.requirements }, h.deps).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(BindingError);
    expect(await h.stores.channels.get(h.s.channelId)).toBeUndefined();
    expect((await h.stores.operations.list(h.s.channelId))[0]).toMatchObject({ status: "failed", attempts: 1 });
  });

  it("through /verify and /settle: the deposit creates the channel and a replay settles once", async () => {
    const h = harness();
    const app = createFacilitatorApp({ binding: ready(h.binding), stores: h.stores, deposits: createDepositHandler(h.deps), now: () => 1_700_000_200, log: (line) => h.logs.push(line) });
    const post = async (path: string, body: unknown) => {
      const res = await app.request(path, { method: "POST", body: JSON.stringify(body), headers: { "content-type": "application/json" } });
      return { status: res.status, body: (await res.json()) as Record<string, unknown> };
    };
    const payload = h.made(500_000n, CHARGE);
    const body = envelope(h.s, payload);
    expect((await post("/verify", body)).body).toMatchObject({ isValid: true, payer: h.s.buyerAddress, extra: { channelId: h.s.channelId, balance: "0" } });
    expect(await h.stores.channels.get(h.s.channelId)).toBeUndefined();

    const settle = await post("/settle", body);
    expect(settle.status).toBe(200);
    expect(settle.body).toMatchObject({ success: true, transaction: payload.depositSignature, amount: "500000", extra: { commitmentId: `${h.s.channelId}:${CHARGE}` } });
    expect((await h.stores.channels.get(h.s.channelId))?.deposit).toBe(500_000n);

    const replay = await post("/settle", body);
    expect(replay.body.extra).toMatchObject({ replayed: true });
    expect(h.calls).toHaveLength(1);

    // A wrong transfer is a verdict with {error, code, retryable}, not a 500, and no amount in the message.
    const wrong = h.made(500_000n, CHARGE * 2n, h.s, "1001");
    const verdict = await post("/settle", envelope(h.s, wrong));
    expect(verdict.status).toBe(200);
    expect(verdict.body).toMatchObject({ success: false, errorReason: SCHEME_ERROR_CODES.invalidTransactionState, code: SCHEME_ERROR_CODES.invalidTransactionState, retryable: false, transaction: "", payer: h.s.buyerAddress });
    expect(String(verdict.body.error)).not.toContain("500000");
    // The next voucher pays against the confirmed deposit.
    const voucher = envelope(h.s, { type: "voucher", channelConfig: h.s.channelConfig, voucher: (await import("./fixtures.js")).voucherOf(h.s, CHARGE + AMOUNT + 10n) });
    expect((await post("/verify", voucher)).body.isValid).toBe(true);
    for (const line of h.logs) expect(line).not.toMatch(BASE58_88);
  });
});

// Keep the fixture helper imports used when vitest tree-shakes.
void encodeBase58;
void randomBytes;
