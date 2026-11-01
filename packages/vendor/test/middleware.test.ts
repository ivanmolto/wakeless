import { createServer, type AddressInfo, type Server } from "node:net";
import { DEVNET_CAIP2, MAINNET_CAIP2, SCHEME_ERROR_CODES, type SettlementResponse } from "@wakeless/scheme";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import { PAYMENT_RESPONSE_HEADER, PAYMENT_SIGNATURE_HEADER, TOKEN_PROGRAM, DEVNET_USDC, x402Shielded, type X402ShieldedOptions } from "../src/index.js";
import { DEPOSIT, TEE_VALIDATOR, address, decodeHeader, decodeRequired, encodeHeader, fundedBuyer, listen, shieldedEntry, startFacilitator } from "./fixtures.js";

const AMOUNT = 1_000n;
const ROUTE = "/price/:symbol";
const RESOURCE = "http://vendor.test/price/SOLX";

const cleanups: (() => Promise<void>)[] = [];

afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

/** A vendor app with a counter on the protected handler, to prove what did and did not run. */
function vendor(facilitatorUrl: string, options: Partial<X402ShieldedOptions> = {}, handler?: (c: { json: (body: unknown, status?: 500) => Response }) => Response) {
  const calls = { resource: 0 };
  const app = new Hono();
  app.use("*", x402Shielded({ facilitatorUrl, payTo: PAY_TO, amountPerRoute: { [ROUTE]: AMOUNT.toString() }, ...options }));
  app.get(ROUTE, (c) => {
    calls.resource += 1;
    return handler ? handler(c as never) : c.json({ price: 1 });
  });
  app.get("/free", (c) => c.json({ free: true }));
  return { app, calls };
}

const PAY_TO = address();

async function facilitator() {
  const started = await startFacilitator();
  cleanups.push(started.close);
  return started;
}

/** A stand-in facilitator: `/supported` from `supported`, and call counts for the rest. */
async function stubFacilitator(supported: unknown, replies: { verify?: unknown; settle?: unknown } = {}) {
  const calls: string[] = [];
  const stub = new Hono();
  stub.get("/supported", (c) => c.json(supported as object));
  stub.post("/verify", (c) => {
    calls.push("verify");
    return c.json((replies.verify ?? { isValid: true }) as object);
  });
  stub.post("/settle", (c) => {
    calls.push("settle");
    return c.json((replies.settle ?? { success: true, transaction: "", network: DEVNET_CAIP2 }) as object);
  });
  const { url, close } = await listen(stub.fetch);
  cleanups.push(close);
  return { url, calls };
}

function shieldedKind(network: string = DEVNET_CAIP2) {
  return {
    x402Version: 2,
    scheme: "batch-settlement-shielded",
    network,
    extra: { escrowAddress: address(), binding: "magicblock", teeValidator: TEE_VALIDATOR, privacyFeeBps: 10, maxIdleSecs: 604_800 },
  };
}

const SUPPORTED = { kinds: [shieldedKind()], extensions: [], signers: { "solana:*": [] } };

/** A port nobody answers on: bound, then released. */
async function refusedUrl(): Promise<string> {
  const { url, close } = await listen(() => new Response());
  await close();
  return url;
}

describe("x402Shielded", () => {
  it("no payment returns a 402 whose header decodes to a valid PaymentRequired", async () => {
    const f = await facilitator();
    const { app, calls } = vendor(f.url);

    const res = await app.request(RESOURCE);
    expect(res.status).toBe(402);
    const required = decodeRequired(res);
    expect(required.x402Version).toBe(2);
    expect(required.error).toBe("PAYMENT-SIGNATURE header is required");
    expect(required.resource).toEqual({ url: RESOURCE });
    expect(required.accepts).toHaveLength(1);

    const entry = shieldedEntry(required);
    expect(entry).toEqual({
      scheme: "batch-settlement-shielded",
      network: DEVNET_CAIP2,
      amount: AMOUNT.toString(),
      asset: DEVNET_USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: {
        paymentFlow: "authorization",
        voucherSigner: "client",
        withdrawDelay: 3600,
        tokenProgram: TOKEN_PROGRAM,
        minDeposit: (AMOUNT * 100n).toString(),
        maxIdleSecs: 604_800,
        escrowAddress: expect.any(String) as string,
        binding: "magicblock",
        teeValidator: TEE_VALIDATOR,
        privacyFeeBps: 10,
      },
    });
    // No field a shielded accept drops (`docs/SCHEME.md` §4.2); a `memo` would be a watcher failure.
    for (const dropped of ["feePayer", "receiverAuthorizer", "operator", "memo", "recentBlockhash", "recentSlot"]) {
      expect(entry.extra).not.toHaveProperty(dropped);
    }
    expect(calls.resource).toBe(0);
  });

  it("alsoAcceptPublic adds a plain batch-settlement entry", async () => {
    const feePayer = address();
    const receiverAuthorizer = address();
    const stub = await stubFacilitator({
      kinds: [shieldedKind(), { x402Version: 2, scheme: "batch-settlement", network: DEVNET_CAIP2, extra: { feePayer, receiverAuthorizer } }],
      extensions: [],
      signers: {},
    });

    const without = await vendor(stub.url).app.request(RESOURCE);
    expect(decodeRequired(without).accepts.map((a) => a.scheme)).toEqual(["batch-settlement-shielded"]);

    const res = await vendor(stub.url, { alsoAcceptPublic: true }).app.request(RESOURCE);
    const { accepts } = decodeRequired(res);
    expect(accepts.map((a) => a.scheme)).toEqual(["batch-settlement-shielded", "batch-settlement"]);
    expect(accepts[1]).toEqual({
      scheme: "batch-settlement",
      network: DEVNET_CAIP2,
      amount: AMOUNT.toString(),
      asset: DEVNET_USDC,
      payTo: PAY_TO,
      maxTimeoutSeconds: 60,
      extra: { feePayer, receiverAuthorizer, withdrawDelay: 3600, tokenProgram: TOKEN_PROGRAM },
    });
    // Nothing of the shielded channel leaks into the plain entry.
    expect(accepts[1]!.extra).not.toHaveProperty("escrowAddress");
  });

  it("alsoAcceptPublic offers no plain entry a facilitator does not advertise", async () => {
    const f = await facilitator();
    const res = await vendor(f.url, { alsoAcceptPublic: true }).app.request(RESOURCE);
    expect(decodeRequired(res).accepts.map((a) => a.scheme)).toEqual(["batch-settlement-shielded"]);
  });

  it("facilitator unreachable returns 402 shielded_facilitator_unavailable not 200", async () => {
    const { app, calls } = vendor(await refusedUrl());
    for (const init of [{}, { headers: { [PAYMENT_SIGNATURE_HEADER]: encodeHeader({ x402Version: 2, accepted: {}, payload: {} }) } }]) {
      const res = await app.request(RESOURCE, init);
      expect(res.status).toBe(402);
      const required = decodeRequired(res);
      expect(required.error).toBe(SCHEME_ERROR_CODES.facilitatorUnavailable);
      // No entry, so no client deposits into a channel it cannot use.
      expect(required.accepts).toEqual([]);
      expect(await res.json()).toMatchObject({ code: "shielded_facilitator_unavailable", retryable: true });
    }
    expect(calls.resource).toBe(0);
  });

  it("a facilitator that accepts the connection and never answers times out to shielded_facilitator_unavailable", async () => {
    const silent: Server = createServer(() => undefined);
    await new Promise<void>((resolve) => silent.listen(0, "127.0.0.1", resolve));
    cleanups.push(
      () =>
        new Promise((resolve) => {
          silent.close(() => resolve());
        }),
    );
    const { port } = silent.address() as AddressInfo;
    const open = new Set<() => void>();
    silent.on("connection", (socket) => open.add(() => socket.destroy()));
    cleanups.unshift(async () => open.forEach((destroy) => destroy()));

    const { app, calls } = vendor(`http://127.0.0.1:${port}`, { facilitatorTimeoutMs: 100 });
    const res = await app.request(RESOURCE);
    expect(res.status).toBe(402);
    expect(decodeRequired(res).error).toBe("shielded_facilitator_unavailable");
    expect(calls.resource).toBe(0);
  });

  it("a facilitator lost between /supported and /verify fails closed", async () => {
    const f = await startFacilitator();
    const { app, calls } = vendor(f.url);
    const accept = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    const buyer = await fundedBuyer(f, accept);
    await f.close();

    const res = await app.request(RESOURCE, { headers: buyer.payment(AMOUNT + 1n) });
    expect(res.status).toBe(402);
    expect(decodeRequired(res)).toMatchObject({ error: "shielded_facilitator_unavailable", accepts: [] });
    expect(calls.resource).toBe(0);
  });

  it("a 500 from the facilitator is shielded_facilitator_unavailable", async () => {
    const stub = new Hono();
    stub.get("/supported", (c) => c.json({ error: "internal error", code: "unexpected_verify_error", retryable: true }, 500));
    const { url, close } = await listen(stub.fetch);
    cleanups.push(close);
    const res = await vendor(url).app.request(RESOURCE);
    expect(res.status).toBe(402);
    expect(decodeRequired(res).error).toBe("shielded_facilitator_unavailable");
  });

  it("a binding that failed attestation is named and offers nothing", async () => {
    const f = await startFacilitator({ status: "attestation_failed", error: "no quote" });
    cleanups.push(f.close);
    const res = await vendor(f.url).app.request(RESOURCE);
    expect(res.status).toBe(402);
    expect(decodeRequired(res)).toMatchObject({ error: SCHEME_ERROR_CODES.shieldedAttestationFailed, accepts: [] });
  });

  it("a facilitator advertising only mainnet is refused", async () => {
    const stub = await stubFacilitator({ kinds: [shieldedKind(MAINNET_CAIP2)], extensions: [], signers: {} });
    const res = await vendor(stub.url).app.request(RESOURCE);
    expect(res.status).toBe(402);
    expect(decodeRequired(res)).toMatchObject({ error: "shielded_facilitator_unavailable", accepts: [] });
  });

  it("a valid voucher with an in-process facilitator returns 200 with PAYMENT-RESPONSE", async () => {
    const f = await facilitator();
    const { app, calls } = vendor(f.url);
    const accept = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    const buyer = await fundedBuyer(f, accept);
    const charge = AMOUNT + 1n; // the 10 bps fee share

    const res = await app.request(RESOURCE, { headers: buyer.payment(charge) });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ price: 1 });
    expect(calls.resource).toBe(1);

    const settlement = decodeHeader<SettlementResponse>(res, PAYMENT_RESPONSE_HEADER);
    expect(settlement).toMatchObject({
      success: true,
      transaction: "",
      network: DEVNET_CAIP2,
      payer: buyer.buyerAddress,
      extra: { commitmentId: `${buyer.channelId}:${charge}`, chargedAmount: charge.toString() },
    });
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(charge);

    // The next voucher in the same channel moves it on.
    const next = await app.request(RESOURCE, { headers: buyer.payment(charge * 2n) });
    expect(next.status).toBe(200);
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(charge * 2n);
  });

  it("a voucher the facilitator refuses gets a 402 with the code and no resource", async () => {
    const f = await facilitator();
    const { app, calls } = vendor(f.url);
    const accept = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    const buyer = await fundedBuyer(f, accept);

    const res = await app.request(RESOURCE, { headers: buyer.payment(DEPOSIT + 1n) });
    expect(res.status).toBe(402);
    const required = decodeRequired(res);
    expect(required.error).toBe(SCHEME_ERROR_CODES.cumulativeExceedsDeposit);
    expect(required.accepts).toHaveLength(1);
    // The body's message is the facilitator's own: a verdict is not a refusal.
    expect(await res.json()).toEqual({
      error: "voucher.maxClaimableAmount is not acceptable against the channel's watermark",
      code: SCHEME_ERROR_CODES.cumulativeExceedsDeposit,
      retryable: false,
    });
    expect(calls.resource).toBe(0);
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(0n);
  });

  it("an accepted entry with another price or payee never reaches the facilitator", async () => {
    const stub = await stubFacilitator(SUPPORTED);
    const { app, calls } = vendor(stub.url);
    const accept = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    const f = await facilitator();
    const buyer = await fundedBuyer(f, accept);

    for (const accepted of [{ ...accept, amount: "1" }, { ...accept, payTo: address() }]) {
      const res = await app.request(RESOURCE, { headers: buyer.payment(AMOUNT + 1n, accepted) });
      expect(res.status).toBe(402);
      const required = decodeRequired(res);
      expect(required.error).toBe(SCHEME_ERROR_CODES.invalidPaymentRequirements);
      expect(required.accepts).toEqual([accept]);
    }
    expect(stub.calls).toEqual([]);
    expect(calls.resource).toBe(0);
  });

  it("a settlement that fails withholds the resource and carries PAYMENT-RESPONSE", async () => {
    const failure = { success: false, errorReason: SCHEME_ERROR_CODES.cumulativeAmountMismatch, errorMessage: "too late", transaction: "", network: DEVNET_CAIP2 };
    const stub = await stubFacilitator(SUPPORTED, { settle: failure });
    const { app, calls } = vendor(stub.url);
    const accept = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    const f = await facilitator();
    const buyer = await fundedBuyer(f, accept);

    const res = await app.request(RESOURCE, { headers: buyer.payment(AMOUNT + 1n) });
    expect(res.status).toBe(402);
    expect(calls.resource).toBe(1);
    expect(stub.calls).toEqual(["verify", "settle"]);
    expect(await res.json()).toEqual({ error: "too late", code: failure.errorReason, retryable: false });
    expect(decodeHeader(res, PAYMENT_RESPONSE_HEADER)).toEqual(failure);
    expect(decodeRequired(res).error).toBe(failure.errorReason);
  });

  it("a facilitator lost before /settle withholds the resource", async () => {
    const f = await startFacilitator();
    const accept = shieldedEntry(decodeRequired(await vendor(f.url).app.request(RESOURCE)));
    const buyer = await fundedBuyer(f, accept);

    // The handler closes the facilitator: /verify has passed, /settle cannot reach it.
    const closing = new Hono();
    closing.use("*", x402Shielded({ facilitatorUrl: f.url, payTo: PAY_TO, amountPerRoute: { [ROUTE]: AMOUNT.toString() } }));
    closing.get(ROUTE, async (c) => {
      await f.close();
      return c.json({ secret: "not delivered" });
    });

    const res = await closing.request(RESOURCE, { headers: buyer.payment(AMOUNT + 1n) });
    expect(res.status).toBe(402);
    expect(await res.json()).toMatchObject({ code: "shielded_facilitator_unavailable", retryable: true });
    expect(res.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
  });

  it("a handler that fails settles nothing", async () => {
    const stub = await stubFacilitator(SUPPORTED);
    const { app } = vendor(stub.url, {}, (c) => c.json({ error: "boom" }, 500));
    const accept = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    const f = await facilitator();
    const buyer = await fundedBuyer(f, accept);

    const res = await app.request(RESOURCE, { headers: buyer.payment(AMOUNT + 1n) });
    expect(res.status).toBe(500);
    expect(stub.calls).toEqual(["verify"]);
    expect(res.headers.get(PAYMENT_RESPONSE_HEADER)).toBeNull();
  });

  it("a malformed PAYMENT-SIGNATURE is a 400 and asks no facilitator", async () => {
    const { app, calls } = vendor(await refusedUrl());
    for (const header of ["", "not base64!", encodeHeader([1]), encodeHeader({ x402Version: 2 })]) {
      const res = await app.request(RESOURCE, { headers: { [PAYMENT_SIGNATURE_HEADER]: header } });
      expect(res.status).toBe(400);
      expect(await res.json()).toMatchObject({ code: SCHEME_ERROR_CODES.invalidPayload, retryable: false });
    }
    const wrongVersion = await app.request(RESOURCE, { headers: { [PAYMENT_SIGNATURE_HEADER]: encodeHeader({ x402Version: 1, accepted: {}, payload: {} }) } });
    expect(wrongVersion.status).toBe(400);
    expect(await wrongVersion.json()).toMatchObject({ code: SCHEME_ERROR_CODES.invalidX402Version });
    expect(calls.resource).toBe(0);
  });

  it("charges every spelling of a priced path and passes an unpriced one through", async () => {
    const { app, calls } = vendor(await refusedUrl());
    expect((await app.request("http://vendor.test/free")).status).toBe(200);
    for (const path of ["/price/SOLX", "/%70rice/SOLX", "/price/%53OLX"]) {
      expect((await app.request(`http://vendor.test${path}`)).status).toBe(402);
    }
    expect(calls.resource).toBe(0);
  });

  it("refuses options it could not advertise", () => {
    const base = { facilitatorUrl: "http://127.0.0.1:1", payTo: PAY_TO, amountPerRoute: { [ROUTE]: "1000" } };
    expect(() => x402Shielded(base)).not.toThrow();
    expect(() => x402Shielded({ ...base, payTo: "nope" })).toThrow(/payTo/);
    expect(() => x402Shielded({ ...base, amountPerRoute: {} })).toThrow(/no route/);
    expect(() => x402Shielded({ ...base, amountPerRoute: { [ROUTE]: "1.5" } })).toThrow(/amountPerRoute/);
    expect(() => x402Shielded({ ...base, amountPerRoute: { [ROUTE]: "0" } })).toThrow(/positive/);
    expect(() => x402Shielded({ ...base, withdrawDelay: 60 })).toThrow(/withdrawDelay/);
    expect(() => x402Shielded({ ...base, minDeposit: "999" })).toThrow(/minDeposit/);
  });
});
