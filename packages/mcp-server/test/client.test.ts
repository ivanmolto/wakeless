// An MCP client against the server: the five tools, a paid get_price through the real
// vendor1 and facilitator on loopback (the facilitator log shows the verified voucher),
// refusals that sign nothing, clean logs, and the stdio entry listing its tools.
import { randomBytes } from "node:crypto";
import { writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { Client } from "@modelcontextprotocol/sdk/client/index.js";
import { StdioClientTransport } from "@modelcontextprotocol/sdk/client/stdio.js";
import type { CallToolResult } from "@modelcontextprotocol/sdk/types.js";
import { decodeBase58Exact, encodeBase58, publicKeyOf, verifyVoucher } from "@wakeless/scheme";
import { VENDORS } from "@wakeless/vendors";
import { describe, expect, it } from "vitest";
import { Budget, ROUTES, TOOL_NAMES } from "../src/index.js";
import { startWorld, tempDir, textOf } from "./harness.js";

const ROOT = resolve(import.meta.dirname, "..", "..", "..");

describe("MCP client", () => {
  it("an MCP client lists the five tools", async () => {
    const w = await startWorld();
    try {
      const { tools } = await w.client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      expect(tools).toHaveLength(5);
      for (const tool of tools) expect(tool.description, tool.name).toBeTruthy();
      // The charge exceeds the listed price by the fee share; the agent must be told, not left to notice.
      for (const tool of tools.filter((t) => t.name.startsWith("get_"))) expect(tool.description, tool.name).toContain("privacy fee share");
      const price = tools.find((t) => t.name === "get_price")!;
      expect(price.inputSchema).toMatchObject({ type: "object", required: ["symbol"] });
      expect(tools.find((t) => t.name === "budget_status")!.annotations?.readOnlyHint).toBe(true);
      // The tool routes are the vendors' routes, in order.
      expect(ROUTES.map((r) => `${r.path}/:symbol`)).toEqual(VENDORS.map((v) => v.route));
      expect(ROUTES.map((r) => r.defaultPort)).toEqual(VENDORS.map((v) => v.defaultPort));
    } finally {
      await w.close();
    }
  });

  it("get_price pays an in-process vendor and returns the price shape", async () => {
    const w = await startWorld();
    try {
      const result = (await w.client.callTool({ name: "get_price", arguments: { symbol: "solx" } })) as CallToolResult;
      expect(result.isError).not.toBe(true);
      const body = JSON.parse(textOf(result)) as Record<string, unknown>;
      expect(body).toMatchObject({ symbol: "SOLX", currency: "USD", step: 0, synthetic: true });
      expect(typeof body.price).toBe("number");
      expect(typeof body.asOf).toBe("string");

      // The facilitator verified one payload and settled it: the deposit that opened the channel, carrying the first voucher.
      expect(w.facilitatorLog.filter((l) => l.startsWith("POST /verify 200 valid"))).toHaveLength(1);
      expect(w.facilitatorLog.filter((l) => l.startsWith("POST /settle 200 settled"))).toHaveLength(1);
      expect(w.facilitatorLog.some((l) => /POST \/(verify|settle) 200 (?!valid|settled)/.test(l))).toBe(false);
      expect(w.rail.calls).toHaveLength(1);
      expect(w.rail.calls[0]).toMatchObject({ to: w.escrow, amount: 100_000n });

      // The channel the facilitator holds is this buyer's, at the first voucher's cumulative, with the buyer's own signature.
      const buyer = publicKeyOf({ secretKey: w.buyerKeypair });
      const records = await Promise.all((w.facilitatorLog.filter((l) => l.startsWith("POST /settle 200 settled")).map((l) => l.split(" ").at(-1)!)).map((id) => w.stores.channels.get(id)));
      expect(records).toHaveLength(1);
      const record = records[0]!;
      expect(record.buyer).toBe(buyer);
      expect(record.vendor).toBe(w.payTo.vendor1);
      expect(record.accepted).toBe(1001n);
      expect(record.latestVoucher).not.toBeNull();
      expect(verifyVoucher(buyer, record.latestVoucher!)).toBe(true);

      // A second call is a plain voucher: verified, settled, no second deposit.
      const again = (await w.client.callTool({ name: "get_price", arguments: { symbol: "SOLX" } })) as CallToolResult;
      expect((JSON.parse(textOf(again)) as { step: number }).step).toBe(1);
      expect(w.facilitatorLog.filter((l) => l.startsWith("POST /verify 200 valid"))).toHaveLength(2);
      expect(w.rail.calls).toHaveLength(1);
      expect((await w.stores.channels.get(record.channelId))!.accepted).toBe(2002n);

      // The budget saw both charges; budget_status says so without an address other than the buyer's.
      const status = JSON.parse(textOf((await w.client.callTool({ name: "budget_status", arguments: {} })) as CallToolResult)) as Record<string, unknown>;
      expect(status).toMatchObject({ limits: { perPayment: "0.05", perDay: "1" }, last24h: { spent: "0.002002", remaining: "0.997998", payments: 2 }, buyer, channels: 1, trajectory: 2 });

      // Logs name tools, statuses, codes and channel ids: never a signature, a key or a token.
      expect(w.logs.length).toBeGreaterThan(0);
      const forms = [encodeBase58(w.buyerKeypair), Buffer.from(w.buyerKeypair).toString("base64"), Buffer.from(w.buyerKeypair).toString("hex")];
      for (const line of [...w.logs, ...w.facilitatorLog]) {
        expect(line).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
        expect(line).not.toMatch(/bearer/i);
        for (const form of forms) expect(line).not.toContain(form);
      }
    } finally {
      await w.close();
    }
  });

  it("a refused payment signs nothing and says why; a bad symbol is not paid for", async () => {
    const budget = new Budget({ path: null, limits: { perPayment: 1500n, perDay: 1_000_000n } });
    const w = await startWorld({ serve: ["vendor1", "vendor2"], budget });
    try {
      // vendor2 charges 2002 against a per-payment cap of 1500: refused before anything is signed.
      const refused = (await w.client.callTool({ name: "get_sentiment", arguments: { symbol: "SOLX" } })) as CallToolResult;
      expect(refused.isError).toBe(true);
      expect(textOf(refused)).toContain("per-payment cap of 0.0015 USDC");
      expect(w.rail.calls).toHaveLength(0);
      expect(w.facilitatorLog.filter((l) => l.startsWith("POST /"))).toHaveLength(0);
      expect(budget.spentInWindow()).toBe(0n);

      // vendor1 fits.
      const paid = (await w.client.callTool({ name: "get_price", arguments: { symbol: "SOLX" } })) as CallToolResult;
      expect(paid.isError).not.toBe(true);
      expect(w.rail.calls).toHaveLength(1);

      // A symbol the vendor would reject is refused here, with no request made.
      const before = w.facilitatorLog.length;
      const bad = (await w.client.callTool({ name: "get_price", arguments: { symbol: "SOL-X" } })) as CallToolResult;
      expect(bad.isError).toBe(true);
      expect(textOf(bad)).toContain("symbol must be");
      expect(w.facilitatorLog).toHaveLength(before);
      expect(budget.spentInWindow()).toBe(1001n);

      // A vendor that is down is an error with nothing charged.
      const down = (await w.client.callTool({ name: "get_news", arguments: { symbol: "SOLX" } })) as CallToolResult;
      expect(down.isError).toBe(true);
      expect(w.rail.calls).toHaveLength(1);
      expect(budget.spentInWindow()).toBe(1001n);
      expect(w.logs.some((l) => l.startsWith("get_news failed"))).toBe(true);
    } finally {
      await w.close();
    }
  });

  it("the stdio entry starts from BUYER_KEYPAIR and lists the same five tools", async () => {
    const dir = tempDir();
    const keypair = join(dir, "buyer.json");
    const seed = randomBytes(32);
    // Solana CLI format: seed then public key. The server derives the public half from the seed.
    writeFileSync(keypair, JSON.stringify([...seed, ...decodeBase58Exact(publicKeyOf({ secretKey: new Uint8Array(seed) }), 32)!]));
    const transport = new StdioClientTransport({
      command: resolve(ROOT, "node_modules/.bin/tsx"),
      args: ["--conditions=development", resolve(ROOT, "packages/mcp-server/src/main.ts")],
      cwd: ROOT,
      env: {
        PATH: process.env.PATH ?? "",
        HOME: dir,
        BUYER_KEYPAIR: keypair,
        SOLANA_RPC_URL: "https://devnet.helius-rpc.com/?api-key=test",
        WAKELESS_BUDGET_FILE: join(dir, "budget.json"),
        WAKELESS_CHANNEL_STORE: join(dir, "channels.json"),
        WAKELESS_PER_DAY_USDC: "0.5",
      },
      stderr: "pipe",
    });
    const stderr: string[] = [];
    transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
    const client = new Client({ name: "test", version: "0.0.0" });
    try {
      await client.connect(transport);
      const { tools } = await client.listTools();
      expect(tools.map((t) => t.name).sort()).toEqual([...TOOL_NAMES].sort());
      const status = JSON.parse(textOf((await client.callTool({ name: "budget_status", arguments: {} })) as CallToolResult)) as { limits: { perDay: string } };
      expect(status.limits.perDay).toBe("0.5");
    } finally {
      await client.close();
    }
    const log = stderr.join("");
    expect(log).toContain("[mcp-server] ready over stdio");
    expect(log).not.toContain("api-key=test");
    expect(log).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
    expect(log).not.toContain(JSON.stringify([...seed]).slice(1, 40));
  }, 30_000);

  it("the stdio entry refuses a mainnet RPC URL and a key under keys/mainnet/", async () => {
    const dir = tempDir();
    const run = async (env: Record<string, string>): Promise<string> => {
      const transport = new StdioClientTransport({
        command: resolve(ROOT, "node_modules/.bin/tsx"),
        args: ["--conditions=development", resolve(ROOT, "packages/mcp-server/src/main.ts")],
        cwd: ROOT,
        env: { PATH: process.env.PATH ?? "", HOME: dir, ...env },
        stderr: "pipe",
      });
      const stderr: string[] = [];
      transport.stderr?.on("data", (chunk: Buffer) => stderr.push(chunk.toString()));
      const client = new Client({ name: "test", version: "0.0.0" });
      await expect(client.connect(transport)).rejects.toThrow();
      await client.close().catch(() => undefined);
      return stderr.join("");
    };
    const keypair = join(dir, "buyer.json");
    writeFileSync(keypair, JSON.stringify([...randomBytes(64)]));
    const mainnetRpc = await run({ BUYER_KEYPAIR: keypair, SOLANA_RPC_URL: "https://mainnet.helius-rpc.com/?api-key=secret" });
    expect(mainnetRpc).toContain("Refusing a mainnet RPC URL");
    expect(mainnetRpc).not.toContain("secret");
    const mainnetKey = await run({ BUYER_KEYPAIR: "keys/mainnet/buyer.json", SOLANA_RPC_URL: "https://devnet.helius-rpc.com/?api-key=x" });
    expect(mainnetKey).toContain("Refusing a key under keys/mainnet/");
  }, 30_000);
});
