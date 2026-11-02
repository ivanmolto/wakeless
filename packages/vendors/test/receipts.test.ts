// Task 7.3: the vendor's receipt reader against the real facilitator app and redemption
// worker in process, over a binding fake whose `settle` answers a signature and a payee
// fake that reports which of those signatures landed. Nothing private is simulated: the
// fakes move no balance; the real path is receipts.devnet.test.ts.
import { randomBytes } from "node:crypto";
import type { Address, Signature } from "@solana/kit";
import type { PayeeBinding, SettlementBinding } from "@wakeless/binding";
import { createFacilitatorApp, createMemoryStores, createRedeemer, type Redeemer, type Stores } from "@wakeless/facilitator";
import { encodeBase58, publicKeyOf, signReceipt, type SettlementReceipt } from "@wakeless/scheme";
import fc from "fast-check";
import type { Hono } from "hono";
import { describe, expect, it } from "vitest";
import { address, fakeBinding, keypair, ready, scenario, type Scenario } from "../../facilitator/test/fixtures.js";
import {
  EVIDENCE_NOTE,
  ReceiptReaderError,
  crossCheckChannel,
  formatReport,
  isClean,
  parseAdminChannels,
  parseAdvertisedSigners,
  parseReceiptsResponse,
  readVendorReceipts,
  receiptTokenFor,
  scrub,
  verifyAgainst,
  type AdminChannelView,
  type VendorReceiptReport,
} from "../src/index.js";

const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;
const BASE58_88_ALL = /[1-9A-HJ-NP-Za-km-z]{87,88}/g;
const ADMIN_TOKEN = "admin-token-for-the-tests-only";
const VENDOR_TOKEN = "vendor-token-for-the-tests-only";

function sig(): Signature {
  return encodeBase58(randomBytes(64)) as Signature;
}

interface Harness {
  s: Scenario;
  stores: Stores;
  redeemer: Redeemer;
  app: Hono;
  signer: ReturnType<typeof keypair>;
  /** Every transfer signature the binding answered, in order. */
  sent: Signature[];
  /** What the payee's rail says for a signature; default landed for every one sent. */
  status: Map<string, "landed" | "failed" | "not_found">;
  payee: PayeeBinding;
  fetch: typeof fetch;
  logs: string[];
}

function harness(): Harness {
  const sent: Signature[] = [];
  const binding: SettlementBinding = {
    ...fakeBinding(),
    async settle(_to, amount, ref) {
      const s = sig();
      sent.push(s);
      return { sig: s, receipt: { channelId: ref.channelId, period: ref.period, cumulative: ref.cumulative, amount, signature: s, ref: ref.id } };
    },
  };
  const s = scenario(binding.escrowAddress());
  const stores = createMemoryStores();
  const signer = keypair();
  const logs: string[] = [];
  const redeemer = createRedeemer({ binding, stores, signer, log: (line) => logs.push(line) });
  const app = createFacilitatorApp({
    binding: ready(binding),
    stores,
    log: (line) => logs.push(line),
    redeemer,
    adminToken: ADMIN_TOKEN,
    receiptTokens: new Map([[s.vendor, VENDOR_TOKEN]]),
    receiptSigners: [redeemer.signer],
  });
  const status = new Map<string, "landed" | "failed" | "not_found">();
  const payee: PayeeBinding = {
    id: "magicblock",
    network: () => binding.network(),
    address: () => s.vendor as Address,
    privateBalance: async () => ({ balance: 760_000n, referenceIds: [] }),
    transferStatus: async (signature) => status.get(signature) ?? (sent.includes(signature) ? "landed" : "not_found"),
  };
  const doFetch = ((input: string | URL | Request, init?: RequestInit) => app.request(String(input), init)) as typeof fetch;
  return { s, stores, redeemer, app, signer, sent, status, payee, fetch: doFetch, logs };
}

/** Twenty calls accepted on the scenario's channel, then one redeem; then ten more and another. */
async function twoPeriods(h: Harness): Promise<void> {
  await h.stores.channels.put({ ...h.s.record, deposit: 100_000n, accepted: 20_020n, settled: 0n });
  await h.redeemer.runOnce();
  await h.stores.channels.update(h.s.channelId, (c) => ({ ...c!, accepted: 30_030n }));
  await h.redeemer.runOnce();
}

function read(h: Harness): Promise<VendorReceiptReport> {
  return readVendorReceipts({ payee: h.payee, facilitatorUrl: "http://facilitator.test", adminToken: ADMIN_TOKEN, receiptToken: VENDOR_TOKEN, fetch: h.fetch });
}

function channelView(channelId: string, vendor: string, settled: bigint, confirmed: number): AdminChannelView {
  return { channelId, vendor, state: "open", accepted: settled, settled, settle: { confirmed, pending: 0, failed: 0, rejected: 0, lastPeriod: confirmed || null } };
}

describe("vendor receipt reader", () => {
  it("receipt parser and facilitator signature verification", () => {
    const signer = keypair();
    const s = scenario();
    const receipt: SettlementReceipt = signReceipt(signer, { channelId: s.channelId, period: 1, cumulative: "20020", amount: "20000", signature: sig() });
    const advertised = parseAdvertisedSigners({ signers: { "solana:*": [publicKeyOf(signer)] } });

    // Valid verifies, as a row with no mismatch.
    expect(verifyAgainst(advertised, receipt)).toBe(true);
    const clean = crossCheckChannel(channelView(s.channelId, s.vendor, 20_020n, 1), parseReceiptsResponse({ channelId: s.channelId, signer: advertised[0], receipts: [receipt] }), advertised, s.vendor);
    expect(clean.mismatches).toEqual([]);
    expect(clean.rows).toEqual([{ channelId: s.channelId, period: 1, cumulative: 20_020n, amount: 20_000n, transferSignature: receipt.signature, verified: true, transfer: "unchecked" }]);

    // An altered amount fails, and is flagged.
    const altered = { ...receipt, amount: "20001" };
    expect(verifyAgainst(advertised, altered)).toBe(false);
    const bad = crossCheckChannel(channelView(s.channelId, s.vendor, 20_020n, 1), { channelId: s.channelId, signer: advertised[0]!, receipts: [altered] }, advertised, s.vendor);
    expect(bad.rows[0]!.verified).toBe(false);
    expect(bad.mismatches.map((m) => m.code)).toEqual(["unverified"]);

    // So do an altered transfer signature, another key, and a signer /supported does not advertise.
    expect(verifyAgainst(advertised, { ...receipt, signature: sig() })).toBe(false);
    expect(verifyAgainst([address()], receipt)).toBe(false);
    const stranger = crossCheckChannel(channelView(s.channelId, s.vendor, 20_020n, 1), { channelId: s.channelId, signer: address(), receipts: [receipt] }, advertised, s.vendor);
    expect(stranger.mismatches.map((m) => m.code)).toEqual(["signer_unadvertised"]);

    // A malformed receipt is flagged, not thrown; malformed responses throw the reader's own error.
    const malformed = crossCheckChannel(channelView(s.channelId, s.vendor, 0n, 0), { channelId: s.channelId, signer: advertised[0]!, receipts: [{ ...receipt, amount: "-1" }] }, advertised, s.vendor);
    expect(malformed.mismatches.map((m) => m.code)).toEqual(["receipt_malformed"]);
    expect(() => parseReceiptsResponse({ channelId: "x", signer: advertised[0], receipts: [] })).toThrow(ReceiptReaderError);
    expect(() => parseAdminChannels({ channels: [{ channelId: s.channelId }] })).toThrow(ReceiptReaderError);
    expect(() => parseAdvertisedSigners({ signers: {} })).toThrow(ReceiptReaderError);
  });

  it("the parsers of facilitator answers return or throw ReceiptReaderError, never anything else", () => {
    for (const parse of [parseAdminChannels, parseReceiptsResponse, parseAdvertisedSigners]) {
      fc.assert(
        fc.property(fc.jsonValue(), (json) => {
          try {
            parse(json);
          } catch (error) {
            expect(error).toBeInstanceOf(ReceiptReaderError);
          }
        }),
        { numRuns: 300 },
      );
    }
  });

  it("the table matches the facilitator's state after a redeem and every receipt verifies", async () => {
    const h = harness();
    await twoPeriods(h);
    const report = await read(h);

    expect(report.vendor).toBe(h.s.vendor);
    expect(report.balance).toBe(760_000n);
    expect(report.referenceIds).toEqual([]);
    expect(report.signers).toEqual([h.redeemer.signer]);
    expect(report.mismatches).toEqual([]);
    expect(isClean(report)).toBe(true);
    const ops = (await h.stores.operations.list(h.s.channelId)).filter((o) => o.type === "settle");
    expect(report.rows.map((r) => [r.period, r.cumulative, r.amount, r.transferSignature, r.verified, r.transfer])).toEqual([
      [1, 20_020n, 20_000n, ops[0]!.signature, true, "landed"],
      [2, 30_030n, 10_000n, ops[1]!.signature, true, "landed"],
    ]);
    expect(report.rows.map((r) => r.transferSignature)).toEqual(h.sent);
    const channel = await h.stores.channels.get(h.s.channelId);
    expect(report.channels).toEqual([{ channelId: h.s.channelId, vendor: h.s.vendor, state: "open", accepted: channel!.accepted, settled: channel!.settled, settle: { confirmed: 2, pending: 0, failed: 0, rejected: 0, lastPeriod: 2 } }]);
  });

  it("a mismatch against /admin/channels is flagged", async () => {
    const h = harness();
    await twoPeriods(h);

    // The facilitator's settled moves past what its receipts account for.
    await h.stores.channels.update(h.s.channelId, (c) => ({ ...c!, settled: c!.settled + 1n }));
    let report = await read(h);
    expect(report.mismatches.map((m) => [m.code, m.channelId])).toEqual([["cumulative_settled", h.s.channelId]]);
    expect(isClean(report)).toBe(false);
    expect(formatReport(report, "vendor1", [])).toContain(`MISMATCH cumulative_settled ${h.s.channelId}`);
    await h.stores.channels.update(h.s.channelId, (c) => ({ ...c!, settled: c!.settled - 1n }));

    // A confirmed settle operation with no signed receipt (a reconciled one) is a count mismatch.
    await h.stores.operations.reserve({ opId: "settle:3", channelId: h.s.channelId, type: "settle", payload: {} });
    await h.stores.operations.transition(h.s.channelId, "settle:3", { status: "confirmed", receipt: { reconciled: true } });
    report = await read(h);
    expect(report.mismatches.map((m) => m.code)).toEqual(["receipt_count"]);

    // A transfer the vendor's own rail login cannot find is flagged too.
    const other = harness();
    await twoPeriods(other);
    other.status.set(other.sent[1]!, "not_found");
    report = await read(other);
    expect(report.mismatches.map((m) => m.code)).toEqual(["transfer_not_landed"]);
    expect(report.rows.map((r) => r.transfer)).toEqual(["landed", "not_found"]);

    // A channel the facilitator lists but will not serve receipts for.
    const view = channelView(h.s.channelId, h.s.vendor, 0n, 0);
    expect(crossCheckChannel(view, undefined, [h.redeemer.signer], h.s.vendor).mismatches.map((m) => m.code)).toEqual(["receipts_unavailable"]);
  });

  it("output contains no tokens or keys", async () => {
    const h = harness();
    await twoPeriods(h);
    const report = await read(h);
    const out = formatReport(report, "vendor1", [ADMIN_TOKEN, VENDOR_TOKEN]);

    expect(out).not.toContain(ADMIN_TOKEN);
    expect(out).not.toContain(VENDOR_TOKEN);
    expect(out).not.toMatch(/bearer/i);
    expect(out).not.toMatch(BASE58_88);
    for (const transfer of h.sent) {
      expect(out).not.toContain(transfer);
      expect(out).toContain(`${transfer.slice(0, 8)}…${transfer.slice(-8)}`);
    }
    // Neither the receipt signer's secret key nor any facilitator signature.
    expect(out).not.toContain(encodeBase58(h.signer.secretKey));
    expect(out).not.toContain(Buffer.from(h.signer.secretKey).toString("hex"));
    expect(out).not.toContain(Buffer.from(h.signer.secretKey).toString("base64"));
    const receipts = await h.redeemer.receipts(h.s.channelId);
    for (const r of receipts) expect(out).not.toContain(r.facilitatorSignature);

    // A token that turns up anywhere in what is printed is scrubbed, and so is any long base58 run.
    const leaky = formatReport({ ...report, referenceIds: [VENDOR_TOKEN, encodeBase58(randomBytes(64))] }, `vendor1 ${ADMIN_TOKEN}`, [ADMIN_TOKEN, VENDOR_TOKEN]);
    expect(leaky).not.toContain(ADMIN_TOKEN);
    expect(leaky).not.toContain(VENDOR_TOKEN);
    expect(leaky).not.toMatch(BASE58_88);
    expect(scrub(`Bearer ${VENDOR_TOKEN}`, [VENDOR_TOKEN])).toBe("Bearer [redacted]");
    expect(out).toContain(EVIDENCE_NOTE);

    // --full-signatures prints the transfer signatures whole and nothing else long: a stray
    // 64-byte value in the output is still shortened, and tokens are still scrubbed.
    const full = formatReport({ ...report, referenceIds: [encodeBase58(randomBytes(64)), ADMIN_TOKEN] }, "vendor1", [ADMIN_TOKEN, VENDOR_TOKEN], { fullSignatures: true });
    for (const transfer of h.sent) expect(full).toContain(transfer);
    expect(full.match(BASE58_88_ALL) ?? []).toEqual(expect.arrayContaining(h.sent));
    expect((full.match(BASE58_88_ALL) ?? []).length).toBe(h.sent.length);
    expect(full).not.toContain(ADMIN_TOKEN);

    // The facilitator's own log lines from the run carry neither.
    for (const line of h.logs) {
      expect(line).not.toMatch(BASE58_88);
      expect(line).not.toContain(ADMIN_TOKEN);
      expect(line).not.toContain(VENDOR_TOKEN);
    }

    // The token lookup names no token when it fails.
    expect(receiptTokenFor(h.s.vendor, `${address()}=${"x".repeat(20)},${h.s.vendor}=${VENDOR_TOKEN}`)).toBe(VENDOR_TOKEN);
    const error = (() => {
      try {
        receiptTokenFor(h.s.vendor, `${address()}=${VENDOR_TOKEN}`);
      } catch (e) {
        return e as Error;
      }
    })();
    expect(error).toBeInstanceOf(ReceiptReaderError);
    expect(error!.message).not.toContain(VENDOR_TOKEN);
  });
});
