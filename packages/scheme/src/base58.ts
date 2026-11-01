import bs58 from "bs58";

export function encodeBase58(bytes: Uint8Array): string {
  return bs58.encode(bytes);
}

/** Decode base58, or return null on any malformed input. Never throws. */
export function decodeBase58(text: unknown): Uint8Array | null {
  if (typeof text !== "string" || text.length === 0) return null;
  try {
    return bs58.decode(text);
  } catch {
    return null;
  }
}

/** Decode base58 and require an exact byte length (32 for a key or id, 64 for a signature). */
export function decodeBase58Exact(text: unknown, length: number): Uint8Array | null {
  const bytes = decodeBase58(text);
  return bytes !== null && bytes.byteLength === length ? bytes : null;
}
