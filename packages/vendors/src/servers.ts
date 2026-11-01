import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
import { x402Shielded } from "@wakeless/vendor";
import { Hono } from "hono";
import { SYMBOL, newsFeed, priceFeed, sentimentFeed } from "./data.js";

export interface VendorDefinition {
  readonly name: "vendor1" | "vendor2" | "vendor3";
  /** The one paid route, `GET`. */
  readonly route: string;
  /** Price per request in atomic units of USDC. */
  readonly amount: string;
  readonly defaultPort: number;
  /** A new feed for a seed: symbol to response body. */
  readonly feed: (seed: string) => (symbol: string) => unknown;
}

export const VENDORS: readonly VendorDefinition[] = [
  { name: "vendor1", route: "/price/:symbol", amount: "1000", defaultPort: 4021, feed: priceFeed },
  { name: "vendor2", route: "/sentiment/:symbol", amount: "2000", defaultPort: 4022, feed: sentimentFeed },
  { name: "vendor3", route: "/news/:symbol", amount: "3000", defaultPort: 4023, feed: newsFeed },
];

export interface VendorAppOptions {
  readonly facilitatorUrl: string;
  readonly payTo: string;
  readonly seed: string;
}

export function createVendorApp(definition: VendorDefinition, options: VendorAppOptions): Hono {
  const feed = definition.feed(options.seed);
  const app = new Hono();
  app.use(
    "*",
    x402Shielded({
      facilitatorUrl: options.facilitatorUrl,
      payTo: options.payTo,
      amountPerRoute: { [definition.route]: definition.amount },
      maxTimeoutSeconds: 60,
      alsoAcceptPublic: false,
    }),
  );
  app.get(definition.route, (c) => {
    const symbol = c.req.param("symbol")?.toUpperCase() ?? "";
    // A 400 here is not charged: the middleware settles only a successful response.
    if (!SYMBOL.test(symbol)) return c.json({ error: "symbol must be 1 to 12 letters or digits" }, 400);
    return c.json(feed(symbol) as object);
  });
  return app;
}

export interface VendorConfig {
  readonly definition: VendorDefinition;
  readonly payTo: string;
  /** `0` picks a free port. */
  readonly port: number;
}

export interface RunningVendor {
  readonly name: string;
  readonly route: string;
  readonly payTo: string;
  readonly port: number;
  readonly url: string;
}

export interface RunningVendors {
  readonly vendors: readonly RunningVendor[];
  readonly close: () => Promise<void>;
}

/** Starts one server per vendor on 127.0.0.1, all or none. */
export async function startVendors(configs: readonly VendorConfig[], options: Omit<VendorAppOptions, "payTo">): Promise<RunningVendors> {
  const closers: (() => Promise<void>)[] = [];
  const close = async () => {
    await Promise.all(closers.splice(0).map((closer) => closer()));
  };
  const vendors: RunningVendor[] = [];
  try {
    for (const { definition, payTo, port } of configs) {
      const app = createVendorApp(definition, { ...options, payTo });
      vendors.push(
        await new Promise<RunningVendor>((resolve, reject) => {
          const server = serve({ fetch: app.fetch, port, hostname: "127.0.0.1" }, (info: AddressInfo) => {
            closers.push(
              () =>
                new Promise((done) => {
                  server.close(() => done());
                }),
            );
            resolve({ name: definition.name, route: definition.route, payTo, port: info.port, url: `http://127.0.0.1:${info.port}` });
          });
          server.once("error", reject);
        }),
      );
    }
  } catch (error) {
    await close();
    throw error;
  }
  return { vendors, close };
}
