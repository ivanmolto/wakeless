// Task 8.1, the buyer side: `pay.close(channelId)` sends the signed close request to the
// facilitator (not through a vendor), polls it, records the refund, and then offers a
// withdrawal to the base token account that it never performs on its own. The rail is
// the real MagicBlockBuyer over the fake transport, so `/v1/spl/withdraw` can be spied.
import { randomBytes } from "node:crypto";
import { readFileSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { createKeyPairFromPrivateKeyBytes, getAddressFromPublicKey, type Address, type Blockhash, type Signature } from "@solana/kit";
import type { ClientRef, SettleRef, SettlementBinding } from "@wakeless/binding";
import { createDepositHandler, createFacilitatorApp, createMemoryStores, createRedeemer, feeOf, type Redeemer, type Stores } from "@wakeless/facilitator";
import { encodeBase58 } from "@wakeless/scheme";
import { afterAll, describe, expect, it } from "vitest";
import { BASE_RPC, FakeTransport, PAYMENTS_API, TEE_RPC } from "../../binding-magicblock/test/fake-transport.js";
import { CLIENT_ERROR_CODES, WITHDRAW_NOTE, WakelessClientError, chargeOf, createMagicBlockRail, wrapFetchWithWakeless, type LocalChannel } from "../src/index.js";
import { TEE_VALIDATOR, confirmingBinding, dispatchFetch, tempStore, vendor } from "./harness.js";

const PRICE = 500_000n; // 0.5 USDC per call
const DEPOSIT = 2_000_000n; // 2 USDC
const WITHDRAW_DELAY = 3600; // the vendor middleware's default extra.withdrawDelay
const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{87,88}/;

type Call = { kind: "settle"; to: Address; amount: bigint; ref: SettleRef } | { kind: "refund"; to: Address; amount: bigint; ref: ClientRef };

interface World {
  url: string;
  stores: Stores;
  redeemer: Redeemer;
  calls: Call[];
  clock: { now: number };
  close: () => Promise<void>;
}

const cleanups: (() => Promise<void>)[] = [];
afterAll(async () => {
  for (const c of cleanups) await c();
});

/** A facilitator on a local port whose binding records settlements and refunds, with an injected clock for the grace period. */
async function facilitator(escrow: string): Promise<World> {
  const calls: Call[] = [];
  const binding: SettlementBinding = {
    ...confirmingBinding(escrow),
    async settle(to, amount, ref) {
      calls.push({ kind: "settle", to, amount, ref });
      const sig = encodeBase58(randomBytes(64)) as Signature;
      return { sig, receipt: { channelId: ref.channelId, period: ref.period, cumulative: ref.cumulative, amount, signature: sig, ref: ref.id } };
    },
    async refund(to, amount, ref) {
      calls.push({ kind: "refund", to, amount, ref });
      return { sig: encodeBase58(randomBytes(64)) as Signature };
    },
  };
  const stores = createMemoryStores();
  const clock = { now: 1_700_000_000 };
  const redeemer = createRedeemer({ binding, stores, signer: { secretKey: new Uint8Array(randomBytes(32)) }, now: () => clock.now });
  const app = createFacilitatorApp({ binding: { status: "ready", binding, teeValidator: TEE_VALIDATOR }, stores, deposits: createDepositHandler({ binding, stores }), redeemer, now: () => clock.now });
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      const close = () =>
        new Promise<void>((done) => {
          server.close(() => done());
          (server as { closeAllConnections?: () => void }).closeAllConnections?.();
        });
      cleanups.push(close);
      resolve({ url: `http://127.0.0.1:${info.port}`, stores, redeemer, calls, clock, close });
    });
  });
}

async function world() {
  // The buyer and its rail over the fake wire: the escrow is a fixed address the fake knows the token account of.
  const buyerKeypair = new Uint8Array(randomBytes(32));
  const buyerAddress = await getAddressFromPublicKey((await createKeyPairFromPrivateKeyBytes(buyerKeypair)).publicKey);
  // Token accounts are whatever addresses the fake is told: it builds, it does not derive.
  const escrowAddress = encodeBase58(randomBytes(32)) as Address;
  const escrowAta = encodeBase58(randomBytes(32)) as Address;
  const buyerAta = encodeBase58(randomBytes(32)) as Address;
  // A fresh blockhash per build, so a second deposit of the same amount is a distinct transaction, as on the real wire.
  const transport = new FakeTransport({ escrowAddress, escrowAta, wallets: new Map([[buyerAddress, { ata: buyerAta, balance: 5_000_000n }]]), blockhash: () => encodeBase58(randomBytes(32)) as Blockhash });
  const f = await facilitator(escrowAddress);
  const v = vendor({ host: "vendor1.test", route: "/price/:symbol", amount: PRICE.toString(), minDeposit: DEPOSIT.toString() }, f.url);
  const dispatched = dispatchFetch([v]);
  // Vendors by host name; anything else (the facilitator) over the real socket.
  const fetchImpl: typeof fetch = (input, init) => (new URL(new Request(input, init).url).hostname.endsWith(".test") ? dispatched.fetch(input, init) : fetch(input, init));
  const logs: string[] = [];
  const channelStoreLocal = tempStore();
  const pay = wrapFetchWithWakeless(fetchImpl, {
    buyerKeypair,
    rail: () => createMagicBlockRail(buyerKeypair, { paymentsApi: PAYMENTS_API, teeRpc: TEE_RPC, baseRpc: BASE_RPC, transport }),
    channelStoreLocal,
    facilitatorUrl: f.url,
    log: (line) => logs.push(line),
  });
  return { f, v, transport, pay, logs, channelStoreLocal, buyerAddress };
}

const withdrawCalls = (transport: FakeTransport) => transport.calls("POST", "/v1/spl/withdraw");

describe("pay.close", () => {
  it("after a refund the client offers but does not perform a withdraw", async () => {
    const w = await world();
    // Deposit 2, spend 0.5 (one call at 0.5 USDC plus the fee share).
    expect((await w.pay("http://vendor1.test/price/SOL")).status).toBe(200);
    const [channel] = w.pay.getChannels();
    expect(channel).toBeDefined();
    expect(channel!.deposit).toBe(DEPOSIT.toString());
    expect(channel!.accept?.payTo).toBe(w.v.payTo);

    // The close request: the channel is closing, nothing refunded yet, no offer.
    const requested = await w.pay.close(channel!.channelId);
    expect(requested).toEqual({ channelId: channel!.channelId, state: "closing", refundAfter: w.f.clock.now + WITHDRAW_DELAY });
    expect(requested.withdraw).toBeUndefined();
    expect((await w.f.stores.channels.get(channel!.channelId))?.state).toBe("closing");
    const local = w.pay.getChannels()[0]!;
    expect(local.close).toMatchObject({ state: "closing", requestedAt: new Date(w.f.clock.now * 1000).toISOString() });
    expect(local.close?.refund).toBeUndefined();
    expect(withdrawCalls(w.transport)).toHaveLength(0);

    // Polling before the grace ends changes nothing; after it the worker pays the vendor first, then refunds.
    expect((await w.pay.close(channel!.channelId)).state).toBe("closing");
    w.f.clock.now += WITHDRAW_DELAY;
    expect(await w.f.redeemer.closeOnce()).toMatchObject({ due: 1, settled: 1, refunded: 1, closed: 1 });
    // The buyer's cumulative is the price plus the fee share it adds (rounded up); the vendor nets the price.
    const charge = chargeOf(PRICE, 10);
    expect(charge).toBe(500_500n);
    expect(w.f.calls.map((c) => c.kind)).toEqual(["settle", "refund"]);
    expect(w.f.calls[0]).toMatchObject({ kind: "settle", to: w.v.payTo, amount: charge - feeOf(charge, 10) });
    expect(w.f.calls[1]).toMatchObject({ kind: "refund", to: w.buyerAddress, amount: DEPOSIT - charge });

    // The refund is confirmed: the client records it and offers the withdrawal. Spy: no withdraw was built or sent.
    const closed = await w.pay.close(channel!.channelId);
    expect(closed.state).toBe("closed");
    expect(closed.refund).toEqual({ amount: DEPOSIT - charge, signature: expect.stringMatching(BASE58_88) });
    expect(closed.withdraw).toBeDefined();
    expect(closed.withdraw!.amount).toBe(DEPOSIT - charge);
    expect(closed.withdraw!.note).toBe(WITHDRAW_NOTE);
    expect(closed.withdraw!.note).toMatch(/public base-layer transaction/);
    expect(withdrawCalls(w.transport)).toHaveLength(0);
    expect(w.transport.baseSubmits).toHaveLength(0);

    // The owner's view (the channel file) carries the refund, the offer and the note; no withdrawal performed.
    const after = w.pay.getChannels()[0]!;
    expect(after.close).toMatchObject({ state: "closed", refund: { amount: (DEPOSIT - charge).toString(), signature: closed.refund!.signature }, withdraw: { note: WITHDRAW_NOTE } });
    expect(after.close?.withdraw?.performed).toBeUndefined();
    const file = JSON.parse(readFileSync(w.channelStoreLocal, "utf8")) as { channels: Record<string, LocalChannel> };
    expect(Object.values(file.channels)[0]!.close?.withdraw?.note).toContain("public base-layer transaction");

    // Polling again still offers (nothing was done), and still sends nothing.
    expect((await w.pay.close(channel!.channelId)).withdraw).toBeDefined();
    expect(withdrawCalls(w.transport)).toHaveLength(0);

    // Only the owner's explicit perform() makes the withdrawal: one build, one base-layer submission, recorded in the file.
    const { signature } = await closed.withdraw!.perform();
    expect(signature).toMatch(BASE58_88);
    expect(withdrawCalls(w.transport)).toHaveLength(1);
    expect(withdrawCalls(w.transport)[0]!.body).toMatchObject({ owner: w.buyerAddress, amount: Number(DEPOSIT - charge) });
    expect(w.transport.baseSubmits.map((s) => s.signature)).toEqual([signature]);
    expect(w.pay.getChannels()[0]!.close?.withdraw?.performed).toMatchObject({ amount: (DEPOSIT - charge).toString(), signature });
    // Twice is refused, and the outcome no longer offers.
    await expect(closed.withdraw!.perform()).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.withdrawUnavailable });
    expect((await w.pay.close(channel!.channelId)).withdraw).toBeUndefined();
    expect(withdrawCalls(w.transport)).toHaveLength(1);

    // Paying the same vendor again opens a new channel; the closed one stays in the file.
    expect((await w.pay("http://vendor1.test/price/ETH")).status).toBe(200);
    expect(w.pay.getChannels().map((c) => c.close?.state)).toEqual(["closed", undefined].sort());
    // No log line carries a signature or an amount.
    for (const line of w.logs) {
      expect(line).not.toMatch(BASE58_88);
      expect(line).not.toMatch(/1499500|2000000|500500/);
    }
  });

  it("close needs the facilitator URL and a channel this buyer holds", async () => {
    const w = await world();
    await expect(w.pay.close(encodeBase58(randomBytes(32)))).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.closeUnconfigured });
    const bare = wrapFetchWithWakeless(fetch, { buyerKeypair: new Uint8Array(randomBytes(32)), channelStoreLocal: tempStore() });
    await expect(bare.close(encodeBase58(randomBytes(32)))).rejects.toBeInstanceOf(WakelessClientError);
    // A facilitator that refuses (the channel is unknown there) is reported with its code.
    expect((await w.pay("http://vendor1.test/price/SOL")).status).toBe(200);
    const [channel] = w.pay.getChannels();
    await w.f.stores.channels.update(channel!.channelId, (c) => ({ ...c!, buyer: encodeBase58(randomBytes(32)) }));
    await expect(w.pay.close(channel!.channelId)).rejects.toMatchObject({ code: CLIENT_ERROR_CODES.closeRefused, message: expect.stringContaining("channel_state") });
    expect(withdrawCalls(w.transport)).toHaveLength(0);
  });
});
