import { createHash } from "node:crypto";

/**
 * JSON with object keys sorted at every level, so two encodings of the same
 * request hash alike whatever order a client wrote its fields in. Arrays keep
 * their order. `undefined` members are dropped, as `JSON.stringify` drops them.
 */
export function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== "object") return JSON.stringify(value) ?? "null";
  if (Array.isArray(value)) return `[${value.map((item) => canonicalJson(item === undefined ? null : item)).join(",")}]`;
  const entries = Object.entries(value as Record<string, unknown>)
    .filter(([, v]) => v !== undefined)
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  return `{${entries.map(([k, v]) => `${JSON.stringify(k)}:${canonicalJson(v)}`).join(",")}}`;
}

/**
 * The payload hash: sha256 over the canonical JSON of `{paymentPayload,
 * paymentRequirements}`, hex. It keys the verified set and the settled results,
 * and may be logged: it reveals nothing about the payload.
 */
export function payloadHash(paymentPayload: unknown, paymentRequirements: unknown): string {
  return createHash("sha256").update(canonicalJson({ paymentPayload, paymentRequirements })).digest("hex");
}
