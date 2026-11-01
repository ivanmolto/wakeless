// The world the MCP tests pay into: the real facilitator app and the real vendor1 from
// `@wakeless/vendors`, each on a loopback port, with the client package's fake rail and
// confirming binding standing where the primitive would be (protocol fakes only; the
// private transfer itself is MagicBlockBuyer's, tested in its package and on devnet).
import { randomBytes } from "node:crypto";
import { mkdtempSync } from "node:fs";
import type { AddressInfo } from "node:net";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { InMemoryTransport } from "@modelcontextprotocol/sdk/inMemory.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { serve } from "@hono/node-server";
import { createDepositHandler, createFacilitatorApp, createMemoryStores, type Stores } from "@wakeless/facilitator";
import { encodeBase58 } from "@wakeless/scheme";
import { VENDORS, createVendorApp, type VendorDefinition } from "@wakeless/vendors";
import type { Hono } from "hono";
import { TEE_VALIDATOR, confirmingBinding, fakeRail, type FakeRail } from "../../client/test/harness.js";
import { Budget, createBudgetedPay, createWakelessMcpServer, type VendorUrls } from "../src/index.js";

export { TEE_VALIDATOR, fakeRail, type FakeRail };

export const address = (): string => encodeBase58(randomBytes(32));

export function tempDir(): string {
  return mkdtempSync(join(tmpdir(), "wakeless-mcp-"));
}

interface Served {
  readonly url: string;
  readonly close: () => Promise<void>;
}

function serveApp(app: Hono): Promise<Served> {
  return new Promise((resolve) => {
    const server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, (info: AddressInfo) => {
      resolve({
        url: `http://127.0.0.1:${info.port}`,
        close: () =>
          new Promise<void>((done) => {
            server.close(() => done());
            (server as { closeAllConnections?: () => void }).closeAllConnections?.();
          }),
      });
    });
  });
}

export interface World {
  readonly facilitatorUrl: string;
  readonly facilitatorLog: string[];
  readonly stores: Stores;
  readonly escrow: string;
  readonly vendors: VendorUrls;
  readonly payTo: Record<string, string>;
  readonly rail: FakeRail;
  readonly buyerKeypair: Uint8Array;
  readonly budget: Budget;
  readonly logs: string[];
  readonly client: Client;
  readonly close: () => Promise<void>;
}

export interface WorldOptions {
  /** Which vendors to serve; the others point at a closed port. Default: vendor1 only. */
  readonly serve?: readonly VendorDefinition["name"][];
  readonly budget?: Budget;
  readonly now?: () => Date;
}

/** Everything on loopback, an MCP client connected in memory to the server. */
export async function startWorld(options: WorldOptions = {}): Promise<World> {
  const escrow = address();
  const binding = confirmingBinding(escrow);
  const stores = createMemoryStores();
  const facilitatorLog: string[] = [];
  const facilitatorApp = createFacilitatorApp({
    binding: { status: "ready", binding, teeValidator: TEE_VALIDATOR },
    stores,
    deposits: createDepositHandler({ binding, stores, log: (line) => facilitatorLog.push(line) }),
    log: (line) => facilitatorLog.push(line),
  });
  const facilitator = await serveApp(facilitatorApp);

  const toServe = new Set(options.serve ?? ["vendor1"]);
  const served: Served[] = [];
  const urls: Record<string, string> = {};
  const payTo: Record<string, string> = {};
  for (const definition of VENDORS) {
    payTo[definition.name] = address();
    if (!toServe.has(definition.name)) {
      urls[definition.name] = "http://127.0.0.1:9";
      continue;
    }
    const app = createVendorApp(definition, { facilitatorUrl: facilitator.url, payTo: payTo[definition.name]!, seed: "test" });
    const running = await serveApp(app);
    served.push(running);
    urls[definition.name] = running.url;
  }
  const vendors: VendorUrls = { get_price: urls.vendor1!, get_sentiment: urls.vendor2!, get_news: urls.vendor3! };

  const rail = fakeRail();
  const buyerKeypair = new Uint8Array(randomBytes(32));
  const budget = options.budget ?? new Budget({ path: null });
  const logs: string[] = [];
  const pay = createBudgetedPay(fetch, {
    buyerKeypair,
    rail,
    budget,
    channelStoreLocal: join(tempDir(), "channels.json"),
    log: (line) => logs.push(`client ${line}`),
    ...(options.now === undefined ? {} : { now: options.now }),
  });
  const server = createWakelessMcpServer({ pay, budget, vendors, log: (line) => logs.push(line) });

  const [clientTransport, serverTransport] = InMemoryTransport.createLinkedPair();
  await server.connect(serverTransport);
  const client = new Client({ name: "test", version: "0.0.0" });
  await client.connect(clientTransport);

  return {
    facilitatorUrl: facilitator.url,
    facilitatorLog,
    stores,
    escrow,
    vendors,
    payTo,
    rail,
    buyerKeypair,
    budget,
    logs,
    client,
    async close() {
      await client.close();
      await server.close();
      await Promise.all(served.map((s) => s.close()));
      await facilitator.close();
    },
  };
}

/** The one text block of a tool result. */
export function textOf(result: CallToolResult): string {
  const [block] = result.content;
  if (block === undefined || block.type !== "text") throw new Error("the tool returned no text");
  return block.text;
}
