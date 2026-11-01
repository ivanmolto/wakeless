import { fail, ok, type SchemeErrorCode, type SchemeResult } from "./errors.js";

export const U64_MAX = (1n << 64n) - 1n;

const DECIMAL_U64 = /^(0|[1-9][0-9]*)$/;

export function isU64(value: bigint): boolean {
  return value >= 0n && value <= U64_MAX;
}

/**
 * Parse a decimal u64 string: digits only, no sign, no leading zeros, within
 * range. The wire carries every amount this way (`docs/SCHEME.md` §1.2, §1.3).
 */
export function parseU64(value: unknown, field: string, code: SchemeErrorCode): SchemeResult<bigint> {
  if (typeof value !== "string" || !DECIMAL_U64.test(value)) {
    return fail(code, `${field} must be a decimal u64 string`);
  }
  const n = BigInt(value);
  if (n > U64_MAX) return fail(code, `${field} exceeds u64`);
  return ok(n);
}

export function encodeU64Le(value: bigint): Uint8Array {
  if (!isU64(value)) throw new RangeError("value is not a u64");
  const out = new Uint8Array(8);
  new DataView(out.buffer).setBigUint64(0, value, true);
  return out;
}

export function decodeU64Le(bytes: Uint8Array, offset = 0): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigUint64(0, true);
}

export function decodeI64Le(bytes: Uint8Array, offset = 0): bigint {
  return new DataView(bytes.buffer, bytes.byteOffset + offset, 8).getBigInt64(0, true);
}
