// The request parser reads untrusted JSON; it may refuse with HttpError and nothing else.
import { DEVNET_CAIP2 } from "@wakeless/binding";
import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { HttpError, Rejection, canonicalJson, parsePayload, parseRequest, payloadHash } from "../src/index.js";
import { CHARGE, envelope, scenario, voucherPayload } from "./fixtures.js";

const json = fc.jsonValue();
const expected = { network: DEVNET_CAIP2, escrowAddress: scenario().escrow };

describe("request parsing", () => {
  it("parseRequest throws only HttpError on arbitrary JSON", () => {
    fc.assert(
      fc.property(json, (value) => {
        try {
          parseRequest(value, expected);
          return false; // arbitrary JSON cannot be a valid request
        } catch (error) {
          return error instanceof HttpError && (error.status === 400 || error.status === 503);
        }
      }),
      { numRuns: 500 },
    );
  });

  it("parsePayload returns a Rejection, never throws, on arbitrary JSON", () => {
    const s = scenario();
    fc.assert(
      fc.property(json, (value) => parsePayload(value, s.requirements) instanceof Rejection),
      { numRuns: 500 },
    );
  });

  it("a mutated valid request is refused or parses to the same requirements", () => {
    const s = scenario(expected.escrowAddress);
    const good = envelope(s, voucherPayload(s, CHARGE));
    const mutate = fc.tuple(fc.constantFrom("x402Version", "paymentPayload", "paymentRequirements"), json);
    fc.assert(
      fc.property(mutate, ([key, value]) => {
        const body = { ...good, [key]: value };
        try {
          const parsed = parseRequest(body, expected);
          return canonicalJson(parsed.paymentRequirements) === canonicalJson(s.requirements);
        } catch (error) {
          return error instanceof HttpError;
        }
      }),
      { numRuns: 300 },
    );
    expect(parseRequest(good, expected).paymentRequirements).toEqual(s.requirements);
  });

  it("canonicalJson ignores key order and payloadHash follows it", () => {
    const obj = fc.dictionary(fc.string(), json, { maxKeys: 8 });
    fc.assert(
      fc.property(obj, (value) => {
        const reversed = Object.fromEntries(Object.entries(value).reverse());
        return canonicalJson(value) === canonicalJson(reversed) && payloadHash(value, reversed) === payloadHash(reversed, value);
      }),
      { numRuns: 300 },
    );
    expect(canonicalJson({ b: 1, a: [{ d: 2, c: 3 }] })).toBe('{"a":[{"c":3,"d":2}],"b":1}');
    expect(payloadHash({ a: 1 }, { b: 2 })).toMatch(/^[0-9a-f]{64}$/);
    expect(payloadHash({ a: 1 }, { b: 2 })).not.toBe(payloadHash({ a: 2 }, { b: 2 }));
  });
});
