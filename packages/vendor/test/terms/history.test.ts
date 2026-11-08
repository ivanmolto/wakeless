import { randomBytes } from "node:crypto";
import { mkdtempSync, readFileSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { encodeBase58 } from "@wakeless/scheme";
import { describe, expect, it } from "vitest";
import { FileTermsHistory, MemoryTermsHistory, activeIncidents, capitalBpsOf, parseHistoryFile, quoteFor, readHistoryFile } from "../../src/index.js";

const id = () => encodeBase58(randomBytes(32));
const clock = () => {
  let t = Date.parse("2026-11-08T10:00:00.000Z");
  return () => new Date((t += 1000));
};

describe("terms history", () => {
  it("a redeemed period with nothing owed adds 250 bps", () => {
    const store = new MemoryTermsHistory(undefined, undefined, clock());
    const buyer = id();
    const channel = id();
    store.seen(buyer, channel);
    expect(capitalBpsOf(store.get(buyer))).toBe(0);
    store.redeemed({ channelId: channel, period: 1, owed: 0n });
    expect(store.get(buyer)?.cleanPeriods).toBe(1);
    expect(capitalBpsOf(store.get(buyer))).toBe(250);
    // Owed after the transfer: not clean, no capital.
    store.redeemed({ channelId: channel, period: 2, owed: 5n });
    expect(store.get(buyer)?.cleanPeriods).toBe(1);
    // The buyer can be named instead of looked up; the channel is then learned.
    const other = id();
    store.redeemed({ channelId: other, buyer, period: 1, owed: 0n });
    expect(store.get(buyer)?.cleanPeriods).toBe(2);
    expect(store.buyerOf(other)).toBe(buyer);
    // Eleven clean periods: the cap, 2500.
    for (let p = 3; p <= 11; p++) store.redeemed({ channelId: channel, period: p, owed: 0n });
    expect(store.get(buyer)?.cleanPeriods).toBe(11);
    expect(capitalBpsOf(store.get(buyer))).toBe(2500);
    // A receipt for a channel nobody has paid through is not attributable and changes nothing.
    expect(store.redeemed({ channelId: id(), period: 1, owed: 0n })).toBeUndefined();
  });

  it("three corrective 402s in a period open repeated_exceeds_deposit", () => {
    const store = new MemoryTermsHistory(undefined, undefined, clock());
    const buyer = id();
    const channel = id();
    store.corrective(buyer, channel);
    store.corrective(buyer, channel);
    expect(activeIncidents(store.get(buyer))).toEqual([]);
    store.corrective(buyer, channel);
    const incidents = activeIncidents(store.get(buyer));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ kind: "repeated_exceeds_deposit", evidence: `3 corrective 402s in one period of channel ${channel.slice(0, 4)}…${channel.slice(-4)}` });
    // A fourth in the same period opens nothing new; the next period starts the count again, and the incident stays.
    store.corrective(buyer, channel);
    expect(activeIncidents(store.get(buyer))).toHaveLength(1);
    store.redeemed({ channelId: channel, period: 1, owed: 0n });
    expect(store.get(buyer)?.period).toBeUndefined();
    store.corrective(buyer, channel);
    store.corrective(buyer, channel);
    expect(activeIncidents(store.get(buyer))).toHaveLength(1);
    store.corrective(buyer, channel);
    expect(activeIncidents(store.get(buyer))).toHaveLength(2);
    // The quote carries it as a risk premium line with its evidence.
    const { unsigned, terms } = quoteFor(10_000n, buyer, store.get(buyer));
    expect(terms.premiumBps).toBe(2000);
    expect(unsigned.adjustments.map((a) => a.label)).toEqual(["relationship capital", "risk premium", "risk premium"]);
    expect(unsigned.adjustments[1]!.evidence.startsWith("repeated_exceeds_deposit: 3 corrective 402s")).toBe(true);
  });

  it("close with owed after grace opens close_with_unpaid", () => {
    const store = new MemoryTermsHistory(undefined, undefined, clock());
    const buyer = id();
    const channel = id();
    store.seen(buyer, channel);
    // Owed but still inside the grace period: not an incident yet.
    store.closed({ channelId: channel, owed: 1_000n, afterGrace: false });
    expect(activeIncidents(store.get(buyer))).toEqual([]);
    // Nothing owed after grace: a clean close, no incident.
    store.closed({ channelId: channel, owed: 0n, afterGrace: true });
    expect(activeIncidents(store.get(buyer))).toEqual([]);
    store.closed({ channelId: channel, owed: 1_000n, afterGrace: true });
    const incidents = activeIncidents(store.get(buyer));
    expect(incidents).toHaveLength(1);
    expect(incidents[0]).toMatchObject({ kind: "close_with_unpaid", evidence: `channel ${channel.slice(0, 4)}…${channel.slice(-4)} closed owing 1000 after the grace period` });
    expect(quoteFor(10_000n, buyer, store.get(buyer)).terms).toMatchObject({ price: 12_000n, fundingCalls: 50 });
    expect(store.closed({ channelId: id(), owed: 1n, afterGrace: true })).toBeUndefined();
  });

  it("the file store keeps the same shape on disk, mode 0600, and refuses a malformed file", () => {
    const dir = mkdtempSync(join(tmpdir(), "wakeless-terms-"));
    const path = join(dir, "state", "terms-vendor1.json");
    const store = new FileTermsHistory(path, clock());
    const buyer = id();
    const channel = id();
    store.seen(buyer, channel);
    store.redeemed({ channelId: channel, period: 1, owed: 0n });
    expect(statSync(path).mode & 0o777).toBe(0o600);
    const raw = JSON.parse(readFileSync(path, "utf8")) as { version: number; buyers: Record<string, { cleanPeriods: number; channels: string[] }> };
    expect(raw.version).toBe(1);
    expect(raw.buyers[buyer]).toMatchObject({ buyer, cleanPeriods: 1, channels: [channel], incidents: [] });
    // Reopened, the history is what was written, and the channel is known again.
    const again = new FileTermsHistory(path);
    expect(again.get(buyer)?.cleanPeriods).toBe(1);
    expect(again.buyerOf(channel)).toBe(buyer);
    expect(again.snapshot()).toEqual(parseHistoryFile(raw));
    expect(readHistoryFile(join(dir, "missing.json"))).toBeUndefined();
    expect(() => parseHistoryFile({ version: 1, buyers: { nope: {} } })).toThrow(/keyed by its address/);
    expect(() => parseHistoryFile({ version: 2, buyers: {} })).toThrow(/version 1/);
  });
});
