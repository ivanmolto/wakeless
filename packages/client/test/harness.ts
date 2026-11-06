// End to end without chain: the real vendor middleware over the real facilitator app,
// served on a local port so the middleware's HTTP client is exercised, and a fake
// buyer rail. Two fakes stand where the primitive would be, both of protocol only:
// the rail answers a deposit with a random signature and records what a transport
// would see, and the facilitator's binding confirms a deposit from the reference the
// facilitator hands it. The private transfer itself is MagicBlockBuyer's, tested in
// its own package and on devnet; nothing here simulates it.
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { serve } from "@hono/node-server";
import type { Address, Signature } from "@solana/kit";
import { DEVNET_CAIP2, type BuyerBinding, type ClientRef, type SettlementBinding } from "@wakeless/binding";
import { createDepositHandler, createFacilitatorApp, createMemoryStores, type Stores } from "@wakeless/facilitator";
import { encodeBase58 } from "@wakeless/scheme";
import { x402Shielded } from "@wakeless/vendor";
import { Hono } from "hono";
import { PAYMENT_SIGNATURE_HEADER } from "../src/index.js";

export const TEE_VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";

export const address = (): string => encodeBase58(randomBytes(32));

export function tempStore(): string {
  return join(mkdtempSync(join(tmpdir(), "wakeless-client-")), "state", "channels.json");
}

/** The facilitator's binding for these tests: a deposit is what its reference says, credited once per signature. */
export function confirmingBinding(escrowAddress: string): SettlementBinding {
  const credited = new Set<string>();
  const unused = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));
  return {
    id: "magicblock",
    network: () => DEVNET_CAIP2,
    escrowAddress: () => escrowAddress as Address,
    async readDeposit(sig, ref) {
      if (credited.has(sig)) return null;
      credited.add(sig);
      return { amount: ref.amount, buyer: ref.buyer };
    },
    settle: unused("settle"),
    refund: unused("refund"),
    privateBalance: unused("privateBalance"),
    transferStatus: unused("transferStatus"),
    observe: unused("observe"),
  };
}

export interface FakeRail extends BuyerBinding {
  readonly calls: { to: Address; amount: bigint; ref: ClientRef }[];
  /** What a transport would see: the request body of each transfer, nothing else. */
  readonly transportSaw: string[];
}

export function fakeRail(teeValidator: string = TEE_VALIDATOR): FakeRail {
  const rail: FakeRail = {
    id: "magicblock",
    teeValidator: teeValidator as Address,
    calls: [],
    transportSaw: [],
    network: () => DEVNET_CAIP2,
    async deposit(to, amount, ref) {
      rail.calls.push({ to, amount, ref });
      rail.transportSaw.push(JSON.stringify({ to, amount: Number(amount), clientRefId: ref.id }));
      return { sig: encodeBase58(randomBytes(64)) as Signature, transaction: randomBytes(200).toString("base64") };
    },
  };
  return rail;
}

export interface Facilitator {
  readonly url: string;
  readonly stores: Stores;
  readonly escrow: string;
  readonly close: () => Promise<void>;
}

export async function startFacilitator(teeValidator: string = TEE_VALIDATOR, escrow: string = address()): Promise<Facilitator> {
  const binding = confirmingBinding(escrow);
  const stores = createMemoryStores();
  const app = createFacilitatorApp({ binding: { status: "ready", binding, teeValidator }, stores, deposits: createDepositHandler({ binding, stores }) });
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        stores,
        escrow,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
  });
}

export interface VendorSpec {
  readonly host: string;
  readonly route: string;
  readonly amount: string;
  readonly minDeposit?: string;
  /** Replaces the handler's answer; the default is a 200 JSON body. */
  readonly handler?: (path: string) => Promise<Response> | Response;
  /** Milliseconds the handler takes, to make concurrent paid requests overlap when they can. */
  readonly delayMs?: number;
}

export interface Vendor {
  readonly spec: VendorSpec;
  readonly payTo: string;
  readonly app: Hono;
  /** Paid requests (with `PAYMENT-SIGNATURE`) in flight at once, by channel id, and the maximum seen. */
  readonly inFlight: Map<string, number>;
  maxInFlight: number;
}

export function vendor(spec: VendorSpec, facilitatorUrl: string): Vendor {
  const payTo = address();
  const app = new Hono();
  const v: Vendor = { spec, payTo, app, inFlight: new Map(), maxInFlight: 0 };
  app.use("*", async (c, next) => {
    const header = c.req.header(PAYMENT_SIGNATURE_HEADER);
    if (header === undefined) return next();
    const envelope = JSON.parse(Buffer.from(header, "base64").toString("utf8")) as { payload: { voucher: { channelId: string } } };
    const channelId = envelope.payload.voucher.channelId;
    const count = (v.inFlight.get(channelId) ?? 0) + 1;
    v.inFlight.set(channelId, count);
    v.maxInFlight = Math.max(v.maxInFlight, count);
    try {
      await next();
    } finally {
      v.inFlight.set(channelId, (v.inFlight.get(channelId) ?? 1) - 1);
    }
  });
  app.use("*", x402Shielded({ facilitatorUrl, payTo, amountPerRoute: { [spec.route]: spec.amount }, ...(spec.minDeposit === undefined ? {} : { minDeposit: spec.minDeposit }) }));
  app.get(spec.route, async (c) => {
    if (spec.delayMs) await new Promise((r) => setTimeout(r, spec.delayMs));
    if (spec.handler) return spec.handler(c.req.path);
    return c.json({ path: c.req.path, served: true });
  });
  return v;
}

export interface Seen {
  readonly url: string;
  readonly headers: Record<string, string>;
  readonly body: string;
}

/** A fetch over the vendors' apps, dispatched by host name, recording every request as a transport would see it. */
export function dispatchFetch(vendors: readonly Vendor[]): { fetch: typeof fetch; seen: Seen[] } {
  const seen: Seen[] = [];
  const byHost = new Map(vendors.map((v) => [v.spec.host, v.app]));
  const doFetch = async (input: string | URL | Request, init?: RequestInit): Promise<Response> => {
    const request = new Request(input, init);
    const url = new URL(request.url);
    seen.push({ url: request.url, headers: Object.fromEntries(request.headers.entries()), body: await request.clone().text() });
    const app = byHost.get(url.hostname);
    if (app === undefined) return new Response("no such vendor", { status: 502 });
    return app.fetch(request);
  };
  return { fetch: doFetch as typeof fetch, seen };
}

/** The decoded `PAYMENT-SIGNATURE` of every paid request seen. */
export function paidEnvelopes(seen: readonly Seen[]): { payload: { type: string; voucher: { channelId: string; maxClaimableAmount: string }; deposit?: { amount: string } } }[] {
  return seen
    .map((s) => s.headers[PAYMENT_SIGNATURE_HEADER.toLowerCase()])
    .filter((h): h is string => h !== undefined)
    .map((h) => JSON.parse(Buffer.from(h, "base64").toString("utf8")) as { payload: { type: string; voucher: { channelId: string; maxClaimableAmount: string }; deposit?: { amount: string } } });
}
