import { describe } from "vitest";

/**
 * A `describe` that skips when `envVar` is unset or empty, and says why.
 * Prints the variable's name, never its value.
 *
 *   skipUnless("HELIUS_API_KEY", "needs devnet RPC")("deposit", () => { ... });
 */
export function skipUnless(envVar: string, reason: string) {
  const present = Boolean(process.env[envVar]);
  if (!present) console.warn(`[skip] ${reason} (${envVar} is not set)`);
  return describe.skipIf(!present);
}
