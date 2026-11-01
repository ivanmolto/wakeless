// The fetch wrapper against the real vendor middleware and facilitator (over a local
// port) with a fake rail: one deposit opens a channel, vouchers pay the rest, the
// corrective 402 is honoured once, requests to one channel serialise, attestation
// happens once, the channel file is 0600, and the buyer key goes nowhere.
import { randomBytes } from "node:crypto";
import { readFileSync, statSync } from "node:fs";
import { dirname } from "node:path";
import { createKeyPairFromBytes, getAddressFromPublicKey, type Address } from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { decodeBase58Exact, encodeBase58, publicKeyOf, signVoucher } from "@wakeless/scheme";
import { afterAll, beforeAll, describe, expect, it, vi } from "vitest";
import { BASE_RPC, FakeTransport, PAYMENTS_API, TEE_RPC, USDC, VALIDATOR } from "../../binding-magicblock/test/fake-transport.js";
import { WakelessClientError, chargeOf, wrapFetchWithWakeless, type WakelessOptions } from "../src/index.js";
import { TEE_VALIDATOR, address, dispatchFetch, fakeRail, paidEnvelopes, startFacilitator, tempStore, vendor, type Facilitator, type VendorSpec } from "./harness.js";

const SPECS: readonly VendorSpec[] = [
  { host: "vendor1.test", route: "/price/:symbol", amount: "1000" },
  { host: "vendor2.test", route: "/sentiment/:symbol", amount: "2000" },
  { host: "vendor3.test", route: "/news/:symbol", amount: "3000" },
];
const URLS = ["http://vendor1.test/price/SOL", "http://vendor2.test/sentiment/SOL", "http://vendor3.test/news/SOL"];

let facilitator: Facilitator;

beforeAll(async () => {
  facilitator = await startFacilitator();
});

afterAll(async () => {
  await facilitator.close();
});

function world(specs: readonly VendorSpec[] = SPECS, f: Facilitator = facilitator) {
  const vendors = specs.map((spec) => vendor(spec, f.url));
  const { fetch, seen } = dispatchFetch(vendors);
  const rail = fakeRail();
  const buyerKeypair = new Uint8Array(randomBytes(32));
  const logs: string[] = [];
  const options: WakelessOptions = { buyerKeypair, rail, channelStoreLocal: tempStore(), log: (line) => logs.push(line) };
  return { vendors, fetch, seen, rail, buyerKeypair, logs, options, pay: wrapFetchWithWakeless(fetch, options) };
}

async function readJson(response: Response): Promise<unknown> {
  expect(response.status).toBe(200);
  return response.json();
}

describe("wrapFetchWithWakeless", () => {
  it("first call deposits, the next nineteen do not", async () => {
    const w = world();
    for (let i = 0; i < 20; i++) {
      const body = (await readJson(await w.pay(URLS[i % 3]!))) as { served: boolean };
      expect(body.served).toBe(true);
    }
    // One deposit per vendor across twenty requests: three in all, one for the first call to each.
    expect(w.rail.calls).toHaveLength(3);
    const envelopes = paidEnvelopes(w.seen);
    expect(envelopes).toHaveLength(20);
    expect(envelopes.filter((e) => e.payload.type === "deposit")).toHaveLength(3);
    expect(envelopes.filter((e) => e.payload.type === "voucher")).toHaveLength(17);

    // Per vendor: deposit = 100 × price (the middleware's default minDeposit), first voucher = price + fee, then cumulative steps of price + fee.
    const trajectory = w.pay.getTrajectory();
    expect(trajectory).toHaveLength(20);
    for (const [index, v] of w.vendors.entries()) {
      const price = BigInt(v.spec.amount);
      const step = chargeOf(price, 10);
      const mine = trajectory.filter((t) => t.vendor === v.payTo);
      expect(mine.map((t) => t.cumulative)).toEqual(mine.map((_, i) => (step * BigInt(i + 1)).toString()));
      expect(mine.map((t) => t.amount)).toEqual(mine.map(() => price.toString()));
      expect(mine.map((t) => t.route)).toEqual(mine.map(() => new URL(URLS[index]!).pathname));
      expect(mine[0]!.deposit).toBe((price * 100n).toString());
      expect(mine.slice(1).every((t) => t.deposit === undefined)).toBe(true);
      expect(w.rail.calls.find((c) => c.to === facilitator.escrow && c.amount === price * 100n)).toBeDefined();
    }
    // The facilitator agrees on every watermark.
    for (const channel of w.pay.getChannels()) {
      const record = await facilitator.stores.channels.get(channel.channelId);
      expect(record?.accepted.toString()).toBe(channel.accepted);
      expect(record?.deposit.toString()).toBe(channel.deposit);
      expect(channel.pendingDeposit).toBeUndefined();
    }
  });

  it("a corrective 402 triggers exactly one top-up", async () => {
    const w = world([{ host: "vendor1.test", route: "/price/:symbol", amount: "1000", minDeposit: "5000" }]);
    await readJson(await w.pay(URLS[0]!));
    expect(w.rail.calls).toHaveLength(1);
    const [channel] = w.pay.getChannels();
    // The local view goes stale: the facilitator holds less deposit than this client believes,
    // so the next voucher (2002) exceeds the deposit there (1500) while the client, at 5000, sees no shortfall.
    await facilitator.stores.channels.update(channel!.channelId, (record) => ({ ...record!, deposit: 1_500n }));
    const before = w.seen.length;
    await readJson(await w.pay(URLS[0]!));
    const attempts = paidEnvelopes(w.seen.slice(before));
    // One voucher refused with the corrective 402, one top-up accepted; one more private transfer, no more.
    expect(attempts.map((a) => a.payload.type)).toEqual(["voucher", "deposit"]);
    expect(w.rail.calls).toHaveLength(2);
    expect(w.logs.some((l) => l.includes("cumulative_exceeds_deposit"))).toBe(true);
    // The top-up is the corrective entry's minDeposit: the route's target or the shortfall, whichever is larger.
    const topUp = w.rail.calls[1]!;
    expect(topUp.amount).toBe(5_000n);
    expect(topUp.ref.id).toBe(w.rail.calls[0]!.ref.id);
    const after = w.pay.getChannels()[0]!;
    expect(BigInt(after.accepted)).toBe(2n * chargeOf(1000n, 10));
    expect(after.deposit).toBe("6500");
    expect(after.pendingDeposit).toBeUndefined();
    expect(w.pay.getTrajectory().map((t) => t.deposit)).toEqual(["5000", "5000"]);
    // A third request is a plain voucher against the resynchronised state.
    await readJson(await w.pay(URLS[0]!));
    expect(paidEnvelopes(w.seen).at(-1)!.payload.type).toBe("voucher");
    expect(w.rail.calls).toHaveLength(2);
  });

  it("a corrective mismatch resynchronises the watermark without a top-up", async () => {
    const w = world([SPECS[0]!]);
    await readJson(await w.pay(URLS[0]!));
    await readJson(await w.pay(URLS[0]!));
    const [channel] = w.pay.getChannels();
    // Another process of this buyer paid twice more: the facilitator's watermark is ahead with a voucher this buyer signed.
    const ahead = BigInt(channel!.accepted) + 2n * chargeOf(1000n, 10);
    const voucher = signVoucher({ secretKey: w.buyerKeypair }, { channelId: channel!.channelId, maxClaimableAmount: ahead.toString(), expiresAt: 0 });
    await facilitator.stores.channels.update(channel!.channelId, (record) => ({ ...record!, accepted: ahead, latestVoucher: voucher }));
    const before = w.seen.length;
    await readJson(await w.pay(URLS[0]!));
    expect(paidEnvelopes(w.seen.slice(before)).map((a) => a.payload.type)).toEqual(["voucher", "voucher"]);
    expect(w.rail.calls).toHaveLength(1);
    expect(BigInt(w.pay.getChannels()[0]!.accepted)).toBe(ahead + chargeOf(1000n, 10));
  });

  it("a snapshot quoting a voucher this buyer did not sign is not adopted", async () => {
    const w = world([SPECS[0]!]);
    await readJson(await w.pay(URLS[0]!));
    const [channel] = w.pay.getChannels();
    const forged = signVoucher({ secretKey: new Uint8Array(randomBytes(32)) }, { channelId: channel!.channelId, maxClaimableAmount: "99000", expiresAt: 0 });
    await facilitator.stores.channels.update(channel!.channelId, (record) => ({ ...record!, accepted: 99_000n, latestVoucher: forged }));
    const response = await w.pay(URLS[0]!);
    expect(response.status).toBe(402);
    expect(w.rail.calls).toHaveLength(1);
    expect(w.pay.getChannels()[0]!.accepted).toBe(channel!.accepted);
  });

  it("a deposit whose request was not served is resent, not remade", async () => {
    let fail = true;
    const w = world([{ host: "vendor1.test", route: "/price/:symbol", amount: "1000", handler: () => (fail ? new Response("down", { status: 503 }) : Response.json({ served: true })) }]);
    const first = await w.pay(URLS[0]!);
    expect(first.status).toBe(503);
    expect(w.rail.calls).toHaveLength(1);
    const pending = w.pay.getChannels()[0]!;
    expect(pending.pendingDeposit?.signature).toBeDefined();
    expect(pending.deposit).toBe("0");
    expect(w.pay.getTrajectory()).toHaveLength(0);

    fail = false;
    await readJson(await w.pay(URLS[0]!));
    // The same private transfer, presented again; no second transfer.
    expect(w.rail.calls).toHaveLength(1);
    const envelopes = paidEnvelopes(w.seen);
    expect(envelopes.map((e) => e.payload.type)).toEqual(["deposit", "deposit"]);
    const after = w.pay.getChannels()[0]!;
    expect(after.pendingDeposit).toBeUndefined();
    expect(after.deposit).toBe("100000");
    expect(w.pay.getTrajectory()).toHaveLength(1);
    // A third request is a plain voucher.
    await readJson(await w.pay(URLS[0]!));
    expect(paidEnvelopes(w.seen).at(-1)!.payload.type).toBe("voucher");
  });

  it("concurrent calls to one vendor serialise", async () => {
    const w = world([{ host: "vendor1.test", route: "/price/:symbol", amount: "1000", delayMs: 5 }]);
    const responses = await Promise.all(Array.from({ length: 10 }, (_, i) => w.pay(`http://vendor1.test/price/S${i}`)));
    for (const r of responses) expect(r.status).toBe(200);
    expect(w.vendors[0]!.maxInFlight).toBe(1);
    expect(w.rail.calls).toHaveLength(1);
    const cumulatives = paidEnvelopes(w.seen).map((e) => BigInt(e.payload.voucher.maxClaimableAmount));
    expect(cumulatives).toHaveLength(10);
    expect([...cumulatives].sort((a, b) => (a < b ? -1 : 1))).toEqual(cumulatives);
    expect(new Set(cumulatives).size).toBe(10);
    // And the other way round: two vendors run side by side without waiting on each other.
    const two = world(SPECS.slice(0, 2));
    await Promise.all([two.pay(URLS[0]!), two.pay(URLS[1]!)]);
    expect(two.rail.calls).toHaveLength(2);
  });

  it("teeValidator is verified once per session", async () => {
    // The client's own rail path: MagicBlockBuyer over the binding's fake transport.
    const seed = new Uint8Array(randomBytes(32));
    // Solana CLI format: seed then public key.
    const buyerKeypair = Uint8Array.from([...seed, ...decodeBase58Exact(publicKeyOf({ secretKey: seed }), 32)!]);
    const buyerAddress = await getAddressFromPublicKey((await createKeyPairFromBytes(buyerKeypair)).publicKey);
    // Token accounts are any 32-byte address on the fake wire; the fake never derives PDAs.
    const buyerAta = address() as Address;
    const escrowAddress = facilitator.escrow as Address;
    const escrowAta = address() as Address;
    const transport = new FakeTransport({ escrowAddress, escrowAta, wallets: new Map([[buyerAddress, { ata: buyerAta, balance: 100_000_000n }]]) });
    const attest = vi.spyOn(transport, "verifyTeeRpcIntegrity");

    const vendors = SPECS.map((spec) => vendor(spec, facilitator.url));
    const { fetch } = dispatchFetch(vendors);
    const pay = wrapFetchWithWakeless(fetch, {
      buyerKeypair,
      paymentsApi: PAYMENTS_API,
      teeRpc: TEE_RPC,
      baseRpc: BASE_RPC,
      mint: USDC,
      transport,
      channelStoreLocal: tempStore(),
    });
    expect(attest).not.toHaveBeenCalled();
    for (let i = 0; i < 20; i++) await readJson(await pay(URLS[i % 3]!));
    expect(attest).toHaveBeenCalledTimes(1);
    expect(attest).toHaveBeenCalledWith(TEE_RPC);
    expect(transport.teeCalls.filter((c) => c.method === "getIdentity")).toHaveLength(1);
    // Three real (fake-wire) private transfers, buyer → escrow, visibility private, no memo.
    const transfers = transport.transferBodies();
    expect(transfers).toHaveLength(3);
    for (const body of transfers) {
      expect(body).toMatchObject({ from: buyerAddress, to: escrowAddress, visibility: "private", toBalance: "ephemeral" });
      expect(body).not.toHaveProperty("memo");
    }
    expect(VALIDATOR).toBe(TEE_VALIDATOR);
  });

  it("a vendor whose teeValidator is not the attested identity is not paid", async () => {
    const other = await startFacilitator(address());
    try {
      const w = world([SPECS[0]!], other);
      const error = await w.pay(URLS[0]!).catch((e: unknown) => e);
      expect(error).toBeInstanceOf(WakelessClientError);
      expect((error as WakelessClientError).code).toBe("shielded_attestation_failed");
      expect(w.rail.calls).toHaveLength(0);
      expect(paidEnvelopes(w.seen)).toHaveLength(0);
    } finally {
      await other.close();
    }
  });

  it("local channel state is written with mode 0600", async () => {
    const w = world([SPECS[0]!]);
    await readJson(await w.pay(URLS[0]!));
    const path = w.options.channelStoreLocal!;
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(dirname(path)).mode & 0o777).toBe(0o700);
    const file = JSON.parse(readFileSync(path, "utf8")) as { version: number; channels: Record<string, unknown>; trajectory: unknown[] };
    expect(file.version).toBe(1);
    expect(Object.keys(file.channels)).toHaveLength(1);
    expect(file.trajectory).toHaveLength(1);
    // A second wrapper over the same file sees the channel and does not deposit again.
    const again = wrapFetchWithWakeless(w.fetch, w.options);
    await readJson(await again(URLS[0]!));
    expect(w.rail.calls).toHaveLength(1);
    expect(again.getTrajectory()).toHaveLength(2);
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });

  it("a channel file this client cannot read is refused, not overwritten", async () => {
    const w = world([SPECS[0]!]);
    const { writeFileSync, mkdirSync } = await import("node:fs");
    const path = w.options.channelStoreLocal!;
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, '{"version":1,"channels":{"x":{"salt":1}},"trajectory":[]}');
    const error = await w.pay(URLS[0]!).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(WakelessClientError);
    expect((error as WakelessClientError).code).toBe("shielded_client_store_unreadable");
    expect(readFileSync(path, "utf8")).toContain('"salt":1');
    expect(w.rail.calls).toHaveLength(0);
  });

  it("the buyer key never leaves the process", async () => {
    const w = world();
    const secret = w.buyerKeypair;
    for (let i = 0; i < 6; i++) await readJson(await w.pay(URLS[i % 3]!));

    const forms = [encodeBase58(secret), Buffer.from(secret).toString("base64"), Buffer.from(secret).toString("hex"), JSON.stringify([...secret])];
    const texts: string[] = [];
    for (const s of w.seen) {
      texts.push(s.url, s.body, JSON.stringify(s.headers));
      // The payment header decoded, so a key hidden in base64 would be found too.
      const header = s.headers["payment-signature"];
      if (header) texts.push(Buffer.from(header, "base64").toString("utf8"));
    }
    texts.push(...w.rail.transportSaw);
    texts.push(readFileSync(w.options.channelStoreLocal!, "utf8"));
    for (const text of texts) for (const form of forms) expect(text).not.toContain(form);
    // Only the public key travels.
    expect(paidEnvelopes(w.seen).length).toBe(6);
    expect(w.seen.some((s) => s.headers["payment-signature"] && Buffer.from(s.headers["payment-signature"], "base64").toString("utf8").includes(w.pay.buyer))).toBe(true);
    // The log names channels and codes, never a signature, a key or a token.
    expect(w.logs.length).toBeGreaterThan(0);
    for (const line of w.logs) {
      expect(line).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
      expect(line).not.toMatch(/bearer/i);
      for (const form of forms) expect(line).not.toContain(form);
    }
  });

  it("beforePayment sees the charge and a throw there signs nothing", async () => {
    const seen: { vendor: string; route: string; amount: bigint; charge: bigint }[] = [];
    let refuse = false;
    const w = world([SPECS[0]!]);
    const pay = wrapFetchWithWakeless(w.fetch, {
      ...w.options,
      beforePayment(p) {
        seen.push({ vendor: p.vendor, route: p.route, amount: p.amount, charge: p.charge });
        if (refuse) throw new Error("over budget");
      },
    });
    await readJson(await pay(URLS[0]!));
    expect(seen).toEqual([{ vendor: w.vendors[0]!.payTo, route: "/price/SOL", amount: 1000n, charge: 1001n }]);
    expect(w.rail.calls).toHaveLength(1);

    refuse = true;
    const before = w.seen.length;
    await expect(pay(URLS[0]!)).rejects.toThrow("over budget");
    // The policy ran once, after the unpaid 402 and before any paid attempt: no deposit, no voucher, no trajectory entry.
    expect(seen).toHaveLength(2);
    expect(paidEnvelopes(w.seen.slice(before))).toHaveLength(0);
    expect(w.rail.calls).toHaveLength(1);
    expect(pay.getTrajectory()).toHaveLength(1);
    expect(pay.getChannels()[0]!.accepted).toBe("1001");
  });

  it("a 402 without a shielded entry, or on another network, is returned as it came", async () => {
    const w = world([SPECS[0]!]);
    const plain = async () => new Response("pay me", { status: 402, headers: { "PAYMENT-REQUIRED": Buffer.from(JSON.stringify({ x402Version: 2, resource: { url: "x" }, accepts: [{ scheme: "exact", network: DEVNET_CAIP2, amount: "1", asset: address(), payTo: address(), maxTimeoutSeconds: 60, extra: {} }] })).toString("base64") } });
    const pay = wrapFetchWithWakeless(plain as typeof fetch, w.options);
    const response = await pay("http://other.test/x");
    expect(response.status).toBe(402);
    expect(await response.text()).toBe("pay me");
    expect(w.rail.calls).toHaveLength(0);
    expect(() => wrapFetchWithWakeless(w.fetch, { ...w.options, network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })).toThrow(WakelessClientError);
  });
});
