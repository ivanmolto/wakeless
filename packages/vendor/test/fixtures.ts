// An in-process facilitator over real HTTP for the vendor tests. Its binding answers only what
// `/supported` and the request parser read: a voucher settles off-chain and nothing is
// transferred in a unit test. No MagicBlock code: the binding interface is enough.
import { randomBytes } from "node:crypto";
import type { AddressInfo } from "node:net";
import { serve, type ServerType } from "@hono/node-server";
import type { SettlementBinding } from "@wakeless/binding";
import { createFacilitatorApp, createMemoryStores, type BindingState, type ChannelRecord, type Stores } from "@wakeless/facilitator";
import {
  DEVNET_CAIP2,
  clientRefOf,
  deriveChannelId,
  encodeBase58,
  publicKeyOf,
  signVoucher,
  type PaymentPayload,
  type PaymentRequired,
  type PaymentRequirements,
  type VoucherKeypair,
} from "@wakeless/scheme";
import { PAYMENT_REQUIRED_HEADER, PAYMENT_SIGNATURE_HEADER, type VendorPaymentRequired } from "../src/index.js";

export const TEE_VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
export const DEPOSIT = 10_000_000n;

export function address(): string {
  return encodeBase58(randomBytes(32));
}

const unused = (what: string) => () => Promise.reject(new Error(`${what} is not used in this test`));

export function fakeBinding(escrowAddress = address()): SettlementBinding {
  return {
    id: "magicblock",
    network: () => DEVNET_CAIP2,
    escrowAddress: () => escrowAddress as ReturnType<SettlementBinding["escrowAddress"]>,
    readDeposit: unused("readDeposit"),
    settle: unused("settle"),
    refund: unused("refund"),
    privateBalance: unused("privateBalance"),
    observe: unused("observe"),
  };
}

/** Serves a fetch handler on an ephemeral local port. */
export function listen(fetch: (request: Request) => Response | Promise<Response>): Promise<{ url: string; close: () => Promise<void>; server: ServerType }> {
  return new Promise((resolve) => {
    const server = serve({ fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        server,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
  });
}

export interface InProcessFacilitator {
  readonly url: string;
  readonly stores: Stores;
  readonly close: () => Promise<void>;
}

export async function startFacilitator(binding: BindingState = { status: "ready", binding: fakeBinding(), teeValidator: TEE_VALIDATOR }): Promise<InProcessFacilitator> {
  const stores = createMemoryStores();
  const app = createFacilitatorApp({ binding, stores });
  const { url, close } = await listen(app.fetch);
  return { url, stores, close };
}

export function decodeRequired(response: Response): VendorPaymentRequired {
  const header = response.headers.get(PAYMENT_REQUIRED_HEADER);
  if (header === null) throw new Error("no PAYMENT-REQUIRED header");
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as VendorPaymentRequired;
}

export function decodeHeader<T>(response: Response, name: string): T {
  const header = response.headers.get(name);
  if (header === null) throw new Error(`no ${name} header`);
  return JSON.parse(Buffer.from(header, "base64").toString("utf8")) as T;
}

export function encodeHeader(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

export function shieldedEntry(required: PaymentRequired | VendorPaymentRequired): PaymentRequirements {
  const entry = required.accepts.find((accept) => accept.scheme === "batch-settlement-shielded");
  if (entry === undefined) throw new Error("no shielded entry");
  return entry as PaymentRequirements;
}

/** A buyer with a confirmed channel to `accept.payTo`; `payment` signs its next voucher into a `PAYMENT-SIGNATURE`. */
export async function fundedBuyer(facilitator: InProcessFacilitator, accept: PaymentRequirements, salt = "7") {
  const buyer: VoucherKeypair = { secretKey: new Uint8Array(randomBytes(32)) };
  const buyerAddress = publicKeyOf(buyer);
  const channelId = deriveChannelId({ buyer: buyerAddress, escrowAddress: accept.extra.escrowAddress, mint: accept.asset, salt });
  const record: ChannelRecord = {
    channelId,
    clientRef: clientRefOf(channelId),
    buyer: buyerAddress,
    vendor: accept.payTo,
    mint: accept.asset,
    deposit: DEPOSIT,
    settled: 0n,
    accepted: 0n,
    latestVoucher: null,
    state: "open",
    lastActivityAt: 1_700_000_000,
  };
  await facilitator.stores.channels.put(record);
  return {
    buyerAddress,
    channelId,
    payment(cumulative: bigint, accepted: unknown = accept): Record<string, string> {
      const voucher = signVoucher(buyer, { channelId, maxClaimableAmount: cumulative.toString(), expiresAt: 0 });
      const payload: PaymentPayload["payload"] = {
        type: "voucher",
        channelConfig: { buyer: buyerAddress, vendor: accept.payTo, mint: accept.asset, salt, withdrawDelay: accept.extra.withdrawDelay },
        voucher,
      };
      return { [PAYMENT_SIGNATURE_HEADER]: encodeHeader({ x402Version: 2, accepted, payload }) };
    },
  };
}
