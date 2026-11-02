import { createHash, timingSafeEqual } from "node:crypto";
import { decodeBase58Exact } from "@wakeless/scheme";

/**
 * Tokens for the two protected surfaces: `GET /receipts/:channelId` (one token per
 * vendor address, so a vendor reads only its own channels) and `/admin/*` (one
 * token, loopback only). Tokens are compared in constant time through their
 * digests and are never logged (`CLAUDE.md`, Secrets).
 */

/** Constant-time equality of two secrets of any length. */
export function tokenMatches(given: string | undefined, expected: string | undefined): boolean {
  if (given === undefined || expected === undefined || given.length === 0 || expected.length === 0) return false;
  const a = createHash("sha256").update(given).digest();
  const b = createHash("sha256").update(expected).digest();
  return timingSafeEqual(a, b);
}

/** The bearer token of an `Authorization` header, or undefined. */
export function bearerOf(header: string | undefined): string | undefined {
  const match = header === undefined ? null : /^Bearer\s+(\S+)$/i.exec(header.trim());
  return match === null ? undefined : match[1];
}

/** `127.0.0.1`, `::1` and the IPv4-mapped form. An unknown address (an in-process call) counts as local. */
export function isLoopback(address: string | undefined): boolean {
  if (address === undefined) return true;
  const bare = address.replace(/^\[|\]$/g, "");
  return bare === "127.0.0.1" || bare === "::1" || bare === "::ffff:127.0.0.1" || bare.startsWith("127.");
}

/**
 * `FACILITATOR_RECEIPT_TOKENS`: `<vendor base58>=<token>` entries separated by commas.
 * Throws on a malformed entry, naming the position and never the token.
 */
export function parseReceiptTokens(text: string | undefined): ReadonlyMap<string, string> {
  const out = new Map<string, string>();
  if (text === undefined || text.trim() === "") return out;
  text.split(",").forEach((entry, i) => {
    const trimmed = entry.trim();
    if (trimmed === "") return;
    const eq = trimmed.indexOf("=");
    const vendor = eq === -1 ? "" : trimmed.slice(0, eq).trim();
    const token = eq === -1 ? "" : trimmed.slice(eq + 1).trim();
    if (decodeBase58Exact(vendor, 32) === null || token.length < 16) {
      throw new Error(`FACILITATOR_RECEIPT_TOKENS entry ${i + 1} is not <vendor base58>=<token of 16+ chars>`);
    }
    if (out.has(vendor)) throw new Error(`FACILITATOR_RECEIPT_TOKENS names vendor ${vendor.slice(0, 4)}…${vendor.slice(-4)} twice`);
    out.set(vendor, token);
  });
  return out;
}

/** The vendor a receipt token belongs to, or undefined. Every token is compared, so timing does not name the vendor. */
export function vendorOfToken(tokens: ReadonlyMap<string, string>, given: string | undefined): string | undefined {
  let found: string | undefined;
  for (const [vendor, token] of tokens) if (tokenMatches(given, token)) found = vendor;
  return found;
}
