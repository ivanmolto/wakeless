import { describe, expect, it, vi } from "vitest";
import {
  assertDevnetGenesisHash,
  assertDevnetRpcUrl,
  redactSecrets,
} from "../lib/devnet.js";
import { expandEnvValue } from "../lib/env.js";
import { assertNotMainnetKeyPath } from "../lib/keypairs.js";
import { isFaucetClosedError, isRateLimitError, MAX_RETRIES, withRateLimitRetry } from "../lib/retry.js";

const noSleep = () => Promise.resolve();

describe("devnet guards", () => {
  it("refuses mainnet rpc urls without echoing the key", () => {
    for (const url of [
      "https://mainnet.helius-rpc.com/?api-key=SECRET",
      "https://api.mainnet-beta.solana.com",
    ]) {
      expect(() => assertDevnetRpcUrl(url)).toThrow(/mainnet/);
      try {
        assertDevnetRpcUrl(url);
      } catch (error) {
        expect((error as Error).message).not.toContain("SECRET");
      }
    }
  });

  it("accepts devnet rpc urls and refuses an empty helius key", () => {
    expect(() => assertDevnetRpcUrl("https://devnet.helius-rpc.com/?api-key=abc")).not.toThrow();
    expect(() => assertDevnetRpcUrl("https://api.devnet.solana.com")).not.toThrow();
    expect(() => assertDevnetRpcUrl("https://devnet.helius-rpc.com/?api-key=")).toThrow(/HELIUS_API_KEY/);
  });

  it("asserts the devnet caip-2 id from the genesis hash", () => {
    expect(() => assertDevnetGenesisHash("EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcWgWkw7hKo")).not.toThrow();
    expect(() => assertDevnetGenesisHash("5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpKuc147dw2N9d")).toThrow(/Refusing/);
  });

  it("redacts api keys from messages", () => {
    expect(redactSecrets("fetch https://x/?api-key=SECRET&a=1 failed")).toBe(
      "fetch https://x/?api-key=[redacted]&a=1 failed",
    );
  });

  it("refuses keys under keys/mainnet", () => {
    expect(() => assertNotMainnetKeyPath("/repo/keys/mainnet/buyer.json")).toThrow(/mainnet/);
    expect(() => assertNotMainnetKeyPath("/repo/keys/buyer.json")).not.toThrow();
  });
});

describe("expandEnvValue", () => {
  it("expands the helius key into the rpc url", () => {
    expect(expandEnvValue("https://x/?api-key=$HELIUS_API_KEY", { HELIUS_API_KEY: "k" })).toBe("https://x/?api-key=k");
    expect(expandEnvValue("${A}-$B", { A: "1" })).toBe("1-");
  });
});

describe("withRateLimitRetry", () => {
  const rateLimited = () => Object.assign(new Error("x"), { context: { statusCode: 429 } });

  it("retries a rate limit at most three times", async () => {
    const attempt = vi.fn().mockRejectedValue(rateLimited());
    await expect(withRateLimitRetry(attempt, noSleep)).rejects.toThrow();
    expect(MAX_RETRIES).toBe(3);
    expect(attempt).toHaveBeenCalledTimes(1 + MAX_RETRIES);
  });

  it("returns once a retry succeeds", async () => {
    const attempt = vi.fn().mockRejectedValueOnce(rateLimited()).mockResolvedValue("ok");
    await expect(withRateLimitRetry(attempt, noSleep)).resolves.toBe("ok");
    expect(attempt).toHaveBeenCalledTimes(2);
  });

  it("does not retry other errors", async () => {
    const attempt = vi.fn().mockRejectedValue(new Error("invalid param"));
    await expect(withRateLimitRetry(attempt, noSleep)).rejects.toThrow("invalid param");
    expect(attempt).toHaveBeenCalledTimes(1);
  });

  it("does not retry a closed faucet", async () => {
    const closed = Object.assign(new Error("Gone"), { context: { statusCode: 410 } });
    const attempt = vi.fn().mockRejectedValue(closed);
    await expect(withRateLimitRetry(attempt, noSleep)).rejects.toThrow("Gone");
    expect(attempt).toHaveBeenCalledTimes(1);
    expect(isFaucetClosedError(closed)).toBe(true);
    expect(isFaucetClosedError(rateLimited())).toBe(false);
  });

  it("finds a rate limit in the cause chain and the server message", () => {
    expect(isRateLimitError(new Error("outer", { cause: rateLimited() }))).toBe(true);
    expect(isRateLimitError(Object.assign(new Error("y"), { context: { __serverMessage: "airdrop limit reached" } }))).toBe(true);
    expect(isRateLimitError(new Error("blockhash not found"))).toBe(false);
  });
});
