// The MCP server (task 6.1): five tools over any transport. Three pay a vendor through
// `wrapFetchWithWakeless`; two belong to the owner and touch the caps. The caps run
// inside the client's `beforePayment` hook, so a refused request signs nothing.
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { PAYMENT_REQUIRED_HEADER, WakelessClientError, parsePaymentRequired, wrapFetchWithWakeless, type WakelessFetch, type WakelessOptions } from "@wakeless/client";
import { z } from "zod";
import { Budget, BudgetRefusedError, parseUsdc } from "./budget.js";

export const SERVER_NAME = "wakeless";
export const SERVER_VERSION = "0.0.0";

/** Devnet USDC: the one asset the caps are denominated in. */
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";

/** The vendors' own rule for a symbol (`@wakeless/vendors`); the server upper-cases first. */
export const SYMBOL = /^[A-Z0-9]{1,12}$/;

export type DataTool = "get_price" | "get_sentiment" | "get_news";

export interface VendorRoute {
  readonly tool: DataTool;
  readonly path: string;
  readonly description: string;
  readonly defaultPort: number;
}

/** The facilitator sets the fee (`extra.privacyFeeBps`, 10 bps by default), so the descriptions name the share without a number. Run-1's agent noticed the difference. */
const FEE_NOTE = ", plus the facilitator's privacy fee share, which budget_status counts in the charge";

/** One tool per vendor, in `@wakeless/vendors` order; a test holds the two lists together. */
export const ROUTES: readonly VendorRoute[] = [
  { tool: "get_price", path: "/price", description: `The latest price of a symbol in USD from vendor1, a paid synthetic feed (1000 USDC atomic units per request${FEE_NOTE}).`, defaultPort: 4021 },
  { tool: "get_sentiment", path: "/sentiment", description: `The market sentiment of a symbol, -1 bearish to 1 bullish, from vendor2, a paid synthetic feed (2000 USDC atomic units per request${FEE_NOTE}).`, defaultPort: 4022 },
  { tool: "get_news", path: "/news", description: `Recent news headlines about a symbol from vendor3, a paid synthetic feed (3000 USDC atomic units per request${FEE_NOTE}).`, defaultPort: 4023 },
];

export const TOOL_NAMES = [...ROUTES.map((r) => r.tool), "budget_status", "set_limits"] as const;

export interface VendorUrls {
  readonly get_price: string;
  readonly get_sentiment: string;
  readonly get_news: string;
}

export interface BudgetedPayOptions extends Omit<WakelessOptions, "beforePayment"> {
  readonly budget: Budget;
  /** The asset the caps are in. Default devnet USDC; a vendor pricing in anything else is refused. */
  readonly asset?: string;
}

/**
 * `wrapFetchWithWakeless` with the caps in `beforePayment`: each request's charge (price
 * plus fee share) is checked against the per-payment cap and the rolling 24h ledger and
 * reserved, before any deposit or voucher. A refusal throws `BudgetRefusedError`.
 */
export function createBudgetedPay(fetchImpl: typeof fetch, options: BudgetedPayOptions): WakelessFetch {
  const { budget, asset = DEVNET_USDC, ...wakeless } = options;
  return wrapFetchWithWakeless(fetchImpl, {
    ...wakeless,
    beforePayment(payment) {
      if (payment.asset !== asset) throw new BudgetRefusedError("refused: the vendor prices in an asset the caps are not denominated in. Nothing was signed.");
      budget.reserve(payment.charge);
    },
  });
}

export interface WakelessMcpServerOptions {
  readonly pay: WakelessFetch;
  readonly budget: Budget;
  /** Base URL of each vendor, no trailing slash. */
  readonly vendors: VendorUrls;
  /** One line per event: tool names, statuses and codes. Never an amount, a signature or a token. */
  readonly log?: (line: string) => void;
}

/** RPC URLs carry API keys; anything that might quote one goes through this. */
export function redactSecrets(message: string): string {
  return message.replace(/(api[-_]?key=)[^&\s"']+/gi, "$1[redacted]");
}

function text(value: unknown): CallToolResult {
  return { content: [{ type: "text", text: typeof value === "string" ? value : JSON.stringify(value, null, 2) }] };
}

function refused(message: string): CallToolResult {
  return { content: [{ type: "text", text: message }], isError: true };
}

const symbolSchema = z.string().min(1).max(12).describe("The symbol, 1 to 12 letters or digits, like SOLX");
const usdcSchema = z.union([z.string(), z.number()]).describe('A USDC amount with at most six decimals, like "0.05"');

export function createWakelessMcpServer(options: WakelessMcpServerOptions): McpServer {
  const { pay, budget, vendors } = options;
  const log = options.log ?? (() => undefined);
  const server = new McpServer({ name: SERVER_NAME, version: SERVER_VERSION }, { instructions: "Each data tool pays one vendor through a Wakeless shielded channel on Solana devnet, under the owner's caps. budget_status shows the caps and the last 24 hours; set_limits changes the caps." });

  for (const route of ROUTES) {
    server.registerTool(
      route.tool,
      {
        title: route.tool.replace(/^get_/, "").replace(/^./, (c) => c.toUpperCase()),
        description: route.description,
        inputSchema: { symbol: symbolSchema },
        annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: false, openWorldHint: true },
      },
      async ({ symbol }) => {
        const upper = symbol.trim().toUpperCase();
        if (!SYMBOL.test(upper)) return refused("symbol must be 1 to 12 letters or digits");
        const url = `${vendors[route.tool]}${route.path}/${encodeURIComponent(upper)}`;
        try {
          const response = await pay(url);
          const body = await response.text();
          if (response.ok) {
            log(`${route.tool} 200`);
            return text(body);
          }
          if (response.status === 402) {
            const code = parsePaymentRequired(response.headers.get(PAYMENT_REQUIRED_HEADER))?.error ?? "no code";
            log(`${route.tool} 402 ${code}`);
            return refused(`the vendor refused payment (${code}); nothing was charged`);
          }
          log(`${route.tool} ${response.status}`);
          return refused(`the vendor answered ${response.status}; nothing was charged`);
        } catch (error) {
          if (error instanceof BudgetRefusedError) {
            log(`${route.tool} refused ${error.code}`);
            return refused(error.message);
          }
          if (error instanceof WakelessClientError) {
            log(`${route.tool} failed ${error.code}`);
            return refused(`payment failed before anything was sent: ${redactSecrets(error.message)}`);
          }
          const name = error instanceof Error ? error.name : "Error";
          log(`${route.tool} failed ${name}`);
          return refused(`the request failed (${name}): ${redactSecrets(error instanceof Error ? error.message : String(error))}`);
        }
      },
    );
  }

  server.registerTool(
    "budget_status",
    {
      title: "Budget status",
      description: "The owner's caps (per payment and per rolling 24 hours, USDC), what the last 24 hours charged, how many payments, and the channels this buyer holds.",
      inputSchema: {},
      annotations: { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async () => {
      const status = budget.status();
      const channels = pay.getChannels();
      log("budget_status");
      return text({ ...status, buyer: pay.buyer, channels: channels.length, trajectory: pay.getTrajectory().length, network: "solana devnet" });
    },
  );

  server.registerTool(
    "set_limits",
    {
      title: "Set limits",
      description: 'Changes the owner\'s caps: perPayment (the most one request may charge) and perDay (the most all requests may charge in any 24 hours), in USDC, like {"perPayment": "0.05", "perDay": "1"}. Either or both.',
      inputSchema: { perPayment: usdcSchema.optional(), perDay: usdcSchema.optional() },
      annotations: { readOnlyHint: false, destructiveHint: false, idempotentHint: true, openWorldHint: false },
    },
    async ({ perPayment, perDay }) => {
      if (perPayment === undefined && perDay === undefined) return refused("set_limits needs perPayment, perDay or both");
      try {
        budget.setLimits({
          ...(perPayment === undefined ? {} : { perPayment: parseUsdc(perPayment, "perPayment") }),
          ...(perDay === undefined ? {} : { perDay: parseUsdc(perDay, "perDay") }),
        });
        log("set_limits changed");
        return text({ limits: budget.status().limits });
      } catch (error) {
        if (error instanceof RangeError) return refused(error.message);
        throw error;
      }
    },
  );

  return server;
}
