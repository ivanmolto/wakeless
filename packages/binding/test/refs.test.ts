import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { channelId, clientRefId } from "../src/index.js";

describe("clientRefId", () => {
  it("accepts any decimal u64 and rejects everything else", () => {
    expect(clientRefId("0")).toBe("0");
    expect(clientRefId(2001n)).toBe("2001");
    expect(clientRefId(18446744073709551615n)).toBe("18446744073709551615");
    for (const bad of ["", "01", "-1", "1.5", "1e3", "abc", "18446744073709551616", " 1", "1\n"]) {
      expect(() => clientRefId(bad), bad).toThrow(RangeError);
    }
  });

  it("never echoes the rejected input and round-trips every u64 (fuzz)", () => {
    fc.assert(
      fc.property(fc.bigInt({ min: 0n, max: (1n << 64n) - 1n }), (n) => {
        expect(clientRefId(n)).toBe(n.toString());
        expect(clientRefId(n.toString())).toBe(n.toString());
      }),
    );
    fc.assert(
      fc.property(fc.string(), (s) => {
        try {
          const ok = clientRefId(s);
          expect(ok).toBe(s);
          expect(s).toMatch(/^(0|[1-9][0-9]*)$/);
        } catch (error) {
          expect(error).toBeInstanceOf(RangeError);
          if (s.length > 8) expect((error as Error).message).not.toContain(s);
        }
      }),
    );
  });
});

describe("channelId", () => {
  it("is 32 bytes of lowercase hex", () => {
    expect(channelId("00000000000007d1" + "ff".repeat(24))).toBe("00000000000007d1" + "ff".repeat(24));
    expect(() => channelId("AB".repeat(32))).toThrow(RangeError);
    expect(() => channelId("ab".repeat(31))).toThrow(RangeError);
  });

  it("derives no clientRefId: that is the scheme package's job", async () => {
    // The scheme's `clientRefOf` (base58 id, little-endian u64) is the one derivation;
    // the binding's earlier big-endian hex helper disagreed with it (docs/DEVIATIONS.md,
    // task 3.1) and is gone.
    const binding = await import("../src/index.js");
    expect("clientRefIdFromChannelId" in binding).toBe(false);
  });
});
