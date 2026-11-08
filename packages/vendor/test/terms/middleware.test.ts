// The relationship-terms layer through the middleware (task 12.1T). Off, nothing changes; on,
// the 402 quotes each buyer from the vendor's history and signs it, and the facilitator
// never sees the receipt.
import { randomBytes } from "node:crypto";
import { DEVNET_CAIP2, SCHEME_ERROR_CODES, publicKeyOf, type VoucherKeypair } from "@wakeless/scheme";
import { Hono } from "hono";
import { afterEach, describe, expect, it } from "vitest";
import {
  MemoryTermsHistory,
  PAYMENT_REQUIRED_HEADER,
  PAYMENT_SIGNATURE_HEADER,
  relationshipTermsEnabled,
  termsIfEnabled,
  verifyTermsReceipt,
  x402Shielded,
  type TermsOptions,
  type TermsReceipt,
  type X402ShieldedOptions,
} from "../../src/index.js";
import { TEE_VALIDATOR, address, decodeRequired, fundedBuyer, listen, shieldedEntry, startFacilitator } from "../fixtures.js";

const AMOUNT = 1_000n;
const ROUTE = "/price/:symbol";
const RESOURCE = "http://vendor.test/price/SOL";

const cleanups: (() => Promise<void>)[] = [];
afterEach(async () => {
  await Promise.all(cleanups.splice(0).map((close) => close()));
});

function signerKey(): { signer: VoucherKeypair; payTo: string } {
  const signer = { secretKey: new Uint8Array(randomBytes(32)) };
  return { signer, payTo: publicKeyOf(signer) };
}

function vendor(options: X402ShieldedOptions) {
  const app = new Hono();
  app.use("*", x402Shielded(options));
  app.get(ROUTE, (c) => c.json({ price: 1 }));
  return app;
}

/** A facilitator that records what `/verify` is sent and answers as told. */
async function recordingFacilitator(verify: unknown = { isValid: true }) {
  const bodies: Record<string, unknown>[] = [];
  const stub = new Hono();
  stub.get("/supported", (c) => c.json({ kinds: [{ x402Version: 2, scheme: "batch-settlement-shielded", network: DEVNET_CAIP2, extra: { escrowAddress: address(), binding: "magicblock", teeValidator: TEE_VALIDATOR, privacyFeeBps: 10 } }], extensions: [], signers: {} }));
  stub.post("/verify", async (c) => {
    bodies.push((await c.req.json()) as Record<string, unknown>);
    return c.json(verify as object);
  });
  stub.post("/settle", (c) => c.json({ success: true, transaction: "", network: DEVNET_CAIP2 }));
  const { url, close } = await listen(stub.fetch);
  cleanups.push(close);
  return { url, bodies };
}

const receiptOf = (res: Response): TermsReceipt => shieldedEntry(decodeRequired(res)).extra.termsReceipt as unknown as TermsReceipt;

describe("x402Shielded with relationship terms", () => {
  it("with the flag off the 402 is byte-identical to before", async () => {
    const f = await startFacilitator();
    cleanups.push(f.close);
    const { signer, payTo } = signerKey();
    const base: X402ShieldedOptions = { facilitatorUrl: f.url, payTo, amountPerRoute: { [ROUTE]: AMOUNT.toString() } };
    const build = (): TermsOptions => ({ signer, history: new MemoryTermsHistory() });
    // The gate: unset, "false", "1" and "TRUE" are all off; only the string "true" is on.
    for (const env of [{}, { RELATIONSHIP_TERMS: "false" }, { RELATIONSHIP_TERMS: "1" }, { RELATIONSHIP_TERMS: "TRUE" }]) {
      expect(relationshipTermsEnabled(env)).toBe(false);
      expect(termsIfEnabled(env, build)).toBeUndefined();
    }
    expect(relationshipTermsEnabled({ RELATIONSHIP_TERMS: "true" })).toBe(true);

    const before = vendor(base);
    const gated = vendor({ ...base, terms: termsIfEnabled({ RELATIONSHIP_TERMS: "false" }, build) });
    const a = await before.request(RESOURCE);
    const b = await gated.request(RESOURCE);
    expect(b.status).toBe(402);
    expect(b.headers.get(PAYMENT_REQUIRED_HEADER)).toBe(a.headers.get(PAYMENT_REQUIRED_HEADER));
    expect(await b.text()).toBe(await a.text());
    expect(shieldedEntry(decodeRequired(a)).extra).not.toHaveProperty("termsReceipt");
    expect(shieldedEntry(decodeRequired(a)).extra.minDeposit).toBe((AMOUNT * 100n).toString());
  });

  it("with the flag on the 402 carries a terms receipt that verifies against the vendor key", async () => {
    const f = await startFacilitator();
    cleanups.push(f.close);
    const { signer, payTo } = signerKey();
    const history = new MemoryTermsHistory();
    const app = vendor({ facilitatorUrl: f.url, payTo, amountPerRoute: { [ROUTE]: AMOUNT.toString() }, terms: termsIfEnabled({ RELATIONSHIP_TERMS: "true" }, () => ({ signer, history })) });

    // An unknown buyer (no payment yet): standard terms, 20 calls' funding requirement, a signed receipt.
    const res = await app.request(RESOURCE);
    expect(res.status).toBe(402);
    const entry = shieldedEntry(decodeRequired(res));
    expect(entry.amount).toBe(AMOUNT.toString());
    expect(entry.extra.minDeposit).toBe((AMOUNT * 20n).toString());
    const receipt = receiptOf(res);
    expect(receipt).toMatchObject({ standardPrice: "1000", adjustments: [], price: "1000", minDeposit: "20000", fundingCalls: 20, policy: "terms@1" });
    expect(receipt.inputsDigest).toMatch(/^0x[0-9a-f]{64}$/);
    expect(verifyTermsReceipt(payTo, receipt)).toBe(true);
    expect(verifyTermsReceipt(address(), receipt)).toBe(false);
    expect(verifyTermsReceipt(payTo, { ...receipt, price: "999" })).toBe(false);
    // The vendor's key must be the payTo key.
    expect(() => x402Shielded({ facilitatorUrl: f.url, payTo: address(), amountPerRoute: { [ROUTE]: "1" }, terms: { signer, history } })).toThrow(/terms.signer/);
  });

  it("a known buyer is quoted its own terms on its first voucher and pays against them", async () => {
    const f = await startFacilitator();
    cleanups.push(f.close);
    const { signer, payTo } = signerKey();
    const history = new MemoryTermsHistory();
    const app = vendor({ facilitatorUrl: f.url, payTo, amountPerRoute: { [ROUTE]: AMOUNT.toString() }, terms: { signer, history } });
    const standard = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    const buyer = await fundedBuyer(f, standard);
    // Seven clean periods with this vendor, recorded from receipts of an earlier channel.
    for (let p = 1; p <= 7; p++) history.redeemed({ channelId: address(), buyer: buyer.buyerAddress, period: p, owed: 0n });

    // Paying against the standard entry: refused with the buyer's entry, and the facilitator is not asked.
    const quoted = await app.request(RESOURCE, { headers: buyer.payment(AMOUNT + 1n, standard) });
    expect(quoted.status).toBe(402);
    const required = decodeRequired(quoted);
    expect(required.error).toBe(SCHEME_ERROR_CODES.shieldedTermsQuoted);
    expect(await quoted.json()).toMatchObject({ code: "shielded_terms_quoted", retryable: true });
    const mine = shieldedEntry(required);
    expect(mine.amount).toBe("825");
    expect(mine.extra.minDeposit).toBe("4950");
    const receipt = receiptOf(quoted);
    expect(receipt.adjustments).toEqual([{ label: "relationship capital", bps: -1750, amount: "-175", evidence: "7 clean periods" }]);
    expect(verifyTermsReceipt(payTo, receipt)).toBe(true);
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(0n);

    // Paying against the quoted entry settles at the buyer's price (825 plus the 10 bps fee share, rounded up).
    const paid = await app.request(RESOURCE, { headers: buyer.payment(826n, mine) });
    expect(paid.status).toBe(200);
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(826n);
    expect(history.get(buyer.buyerAddress)?.channels).toContain(buyer.channelId);

    // Another buyer with no history pays against the standard entry on the first try.
    const fresh = await fundedBuyer(f, standard, "8");
    const first = await app.request(RESOURCE, { headers: fresh.payment(AMOUNT + 1n, standard) });
    expect(first.status).toBe(200);
    // And an entry with another payTo is still invalid_payment_requirements, not a quote.
    const wrong = await app.request(RESOURCE, { headers: fresh.payment(AMOUNT * 2n + 2n, { ...standard, payTo: address() }) });
    expect(decodeRequired(wrong).error).toBe(SCHEME_ERROR_CODES.invalidPaymentRequirements);
  });

  it("the facilitator never sees the terms receipt", async () => {
    const stub = await recordingFacilitator();
    const { signer, payTo } = signerKey();
    const app = vendor({ facilitatorUrl: stub.url, payTo, amountPerRoute: { [ROUTE]: AMOUNT.toString() }, terms: { signer, history: new MemoryTermsHistory() } });
    const standard = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    expect(standard.extra).toHaveProperty("termsReceipt");
    const f = await startFacilitator();
    cleanups.push(f.close);
    const buyer = await fundedBuyer(f, standard);
    const res = await app.request(RESOURCE, { headers: buyer.payment(AMOUNT + 1n, standard) });
    expect(res.status).toBe(200);
    expect(stub.bodies).toHaveLength(1);
    const text = JSON.stringify(stub.bodies[0]);
    expect(text).not.toContain("termsReceipt");
    expect(text).not.toContain("inputsDigest");
    const forwarded = stub.bodies[0]!.paymentRequirements as { amount: string; extra: Record<string, unknown> };
    expect(forwarded.amount).toBe(AMOUNT.toString());
    expect(forwarded.extra.minDeposit).toBe((AMOUNT * 20n).toString());
  });

  it("three cumulative_exceeds_deposit verdicts in a period raise the buyer's terms", async () => {
    const { signer, payTo } = signerKey();
    const history = new MemoryTermsHistory();
    const stub = await recordingFacilitator({ isValid: false, invalidReason: SCHEME_ERROR_CODES.cumulativeExceedsDeposit, invalidMessage: "over the deposit" });
    const app = vendor({ facilitatorUrl: stub.url, payTo, amountPerRoute: { [ROUTE]: AMOUNT.toString() }, terms: { signer, history } });
    const standard = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    const f = await startFacilitator();
    cleanups.push(f.close);
    const buyer = await fundedBuyer(f, standard);
    for (let i = 0; i < 3; i++) {
      const res = await app.request(RESOURCE, { headers: buyer.payment(AMOUNT * BigInt(i + 1) + 1n, standard) });
      expect(decodeRequired(res).error).toBe(SCHEME_ERROR_CODES.cumulativeExceedsDeposit);
    }
    expect(history.get(buyer.buyerAddress)?.incidents.map((i) => i.kind)).toEqual(["repeated_exceeds_deposit"]);
    // The next payment against the standard entry is quoted the premium: 1100, 50 calls.
    const quoted = await app.request(RESOURCE, { headers: buyer.payment(AMOUNT + 1n, standard) });
    expect(decodeRequired(quoted).error).toBe(SCHEME_ERROR_CODES.shieldedTermsQuoted);
    const entry = shieldedEntry(decodeRequired(quoted));
    expect(entry.amount).toBe("1100");
    expect(entry.extra.minDeposit).toBe("55000");
    expect(receiptOf(quoted).adjustments[0]).toMatchObject({ label: "risk premium", bps: 1000, amount: "100" });
  });

  it("a malformed terms receipt in the buyer's echo is ignored by the match, never trusted", async () => {
    const f = await startFacilitator();
    cleanups.push(f.close);
    const { signer, payTo } = signerKey();
    const app = vendor({ facilitatorUrl: f.url, payTo, amountPerRoute: { [ROUTE]: AMOUNT.toString() }, terms: { signer, history: new MemoryTermsHistory() } });
    const standard = shieldedEntry(decodeRequired(await app.request(RESOURCE)));
    const buyer = await fundedBuyer(f, standard);
    // The buyer edits the receipt it echoes: the match ignores it and the vendor's own entry is forwarded.
    const forged = { ...standard, extra: { ...standard.extra, termsReceipt: { price: "1", vendorSignature: "x" } } };
    const res = await app.request(RESOURCE, { headers: { [PAYMENT_SIGNATURE_HEADER]: buyer.payment(AMOUNT + 1n, forged)[PAYMENT_SIGNATURE_HEADER]! } });
    expect(res.status).toBe(200);
    expect((await f.stores.channels.get(buyer.channelId))?.accepted).toBe(AMOUNT + 1n);
  });
});
