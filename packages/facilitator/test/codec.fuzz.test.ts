import { randomBytes } from "node:crypto";
import { clientRefOf, encodeBase58, U64_MAX } from "@wakeless/scheme";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { StoreError, type ChannelRecord, type OperationRecord } from "../src/index.js";
import { decodeChannel, decodeOperation, encodeChannel, encodeOperation } from "../src/stores/codec.js";

const SIGNATURE = encodeBase58(randomBytes(64));
const CHANNEL_ID = encodeBase58(randomBytes(32));

const channelArb: fc.Arbitrary<ChannelRecord> = fc.record({
  channelId: fc.constant(CHANNEL_ID),
  clientRef: fc.constant(clientRefOf(CHANNEL_ID)),
  buyer: fc.string({ minLength: 1 }),
  vendor: fc.string({ minLength: 1 }),
  mint: fc.string({ minLength: 1 }),
  deposit: fc.bigInt(0n, U64_MAX),
  settled: fc.bigInt(0n, U64_MAX),
  accepted: fc.bigInt(0n, U64_MAX),
  latestVoucher: fc.option(
    fc.bigInt(0n, U64_MAX).map((cumulative) => ({
      channelId: CHANNEL_ID,
      maxClaimableAmount: cumulative.toString(),
      expiresAt: 0 as const,
      signature: SIGNATURE,
    })),
  ),
  state: fc.constantFrom("open", "closing", "closed"),
  lastActivityAt: fc.nat(),
});

/** Stored bytes are external input: anything else in the key must fail as `corrupt_record`. */
function onlyCorrupt(decode: (raw: string) => unknown, raw: string): void {
  try {
    decode(raw);
  } catch (error) {
    expect(error).toBeInstanceOf(StoreError);
    expect((error as StoreError).code).toBe("corrupt_record");
  }
}

describe("store codec", () => {
  it("a channel survives encode and decode", () => {
    fc.assert(
      fc.property(channelArb, (record) => {
        expect(decodeChannel(encodeChannel(record.channelId, record))).toEqual(record);
      }),
    );
  });

  it("arbitrary stored strings decode or fail as corrupt_record", () => {
    fc.assert(
      fc.property(fc.oneof(fc.string(), fc.json()), (raw) => {
        onlyCorrupt(decodeChannel, raw);
        onlyCorrupt(decodeOperation, raw);
      }),
    );
  });

  it("a mutated channel field decodes or fails as corrupt_record", () => {
    fc.assert(
      fc.property(
        channelArb,
        fc.constantFrom<keyof ChannelRecord>(
          "channelId",
          "clientRef",
          "deposit",
          "accepted",
          "latestVoucher",
          "state",
          "lastActivityAt",
        ),
        fc.jsonValue(),
        (record, field, junk) => {
          const wire = JSON.parse(encodeChannel(record.channelId, record)) as Record<string, unknown>;
          wire[field] = junk;
          onlyCorrupt(decodeChannel, JSON.stringify(wire));
        },
      ),
    );
  });

  it("errors name the field and carry no value", () => {
    const secret = encodeBase58(randomBytes(64));
    const operation = { opId: "op", channelId: CHANNEL_ID, type: "settle", payload: {}, status: "pending", attempts: 0 };
    let message = "";
    try {
      decodeOperation(JSON.stringify({ ...operation, signature: `${secret}!` }));
    } catch (error) {
      message = (error as Error).message;
    }
    expect(message).toBe("operation: field signature is invalid");
    expect(message).not.toContain(secret);
  });

  it("a bigint inside a payload is refused as invalid_record", () => {
    const operation = {
      opId: "op",
      channelId: CHANNEL_ID,
      type: "settle",
      payload: { amount: 1n },
      status: "pending",
      attempts: 0,
    } as unknown as OperationRecord;
    expect(() => encodeOperation(operation)).toThrow(StoreError);
  });
});
