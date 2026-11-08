// `"sideEffects": false` in package.json is a promise that importing the package does
// nothing until a function is called. noble-ed25519 needs sha512 wired in; this proves the
// wiring happens on first use, not at load, and that the sources carry no top-level write
// to the noble module.
import { randomBytes } from "node:crypto";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const SRC = join(import.meta.dirname, "..", "src");

describe("@wakeless/scheme has no import-time side effects", () => {
  it("loading the package does not wire noble's hash; the first signature does, once", async () => {
    const scheme = await import("../src/index.js");
    const probe = await import("../src/ed25519.js");
    expect(probe.hashesWired()).toBe(false);

    const keypair = { secretKey: new Uint8Array(randomBytes(32)) };
    const buyer = scheme.publicKeyOf(keypair);
    expect(probe.hashesWired()).toBe(true);

    const channelId = scheme.encodeBase58(randomBytes(32));
    const voucher = scheme.signVoucher(keypair, { channelId, maxClaimableAmount: "1", expiresAt: 0 });
    expect(scheme.verifyVoucher(buyer, voucher)).toBe(true);
    probe.ensureHashes(); // idempotent
    expect(probe.hashesWired()).toBe(true);
  });

  it("no source assigns to noble's hashes at module level", () => {
    for (const name of readdirSync(SRC).filter((n) => n.endsWith(".ts"))) {
      const text = readFileSync(join(SRC, name), "utf8");
      if (name === "ed25519.ts") {
        // The one write lives inside ensureHashes(), indented, never at column 0.
        expect(text).not.toMatch(/^ed\.hashes\./m);
        expect(text).toMatch(/^ {2}ed\.hashes\.sha512 = sha512;$/m);
        continue;
      }
      expect(text, name).not.toMatch(/hashes\.sha512/);
      expect(text, name).not.toMatch(/from "@noble\/ed25519"/);
    }
  });
});
