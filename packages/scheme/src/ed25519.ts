// noble-ed25519 ships no hash; its synchronous API needs sha512 wired in once. Doing it
// here, on the first call rather than at module load, keeps the package free of top-level
// side effects, which `"sideEffects": false` in package.json promises (task 11.2 review).
import * as ed from "@noble/ed25519";
import { sha512 } from "@noble/hashes/sha2.js";

let wired = false;

/** Idempotent; exported for the test that proves the module loads without wiring. */
export function ensureHashes(): void {
  if (wired) return;
  ed.hashes.sha512 = sha512;
  wired = true;
}

export function sign(message: Uint8Array, seed: Uint8Array): Uint8Array {
  ensureHashes();
  return ed.sign(message, seed);
}

export function verify(signature: Uint8Array, message: Uint8Array, publicKey: Uint8Array): boolean {
  ensureHashes();
  return ed.verify(signature, message, publicKey);
}

export function getPublicKey(seed: Uint8Array): Uint8Array {
  ensureHashes();
  return ed.getPublicKey(seed);
}

/** Whether `ensureHashes` has run; for tests only. */
export function hashesWired(): boolean {
  return wired;
}
