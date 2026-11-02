import { generateKeyPairSync } from "node:crypto";
import { type Address, getAddressDecoder } from "@solana/kit";

export const KEY_ROLES = [
  { name: "buyer", envVar: "BUYER_KEYPAIR" },
  { name: "escrow", envVar: "ESCROW_KEYPAIR" },
  { name: "vendor1", envVar: "VENDOR1_KEYPAIR" },
  { name: "vendor2", envVar: "VENDOR2_KEYPAIR" },
  { name: "vendor3", envVar: "VENDOR3_KEYPAIR" },
  /** The facilitator's receipt signer (task 7.2). Signs off-chain receipts only; holds no funds. */
  { name: "facilitator", envVar: "FACILITATOR_KEYPAIR" },
] as const;

/** Solana CLI format: a JSON array of 64 bytes, seed then public key. */
export function generateKeypairJson(): string {
  const { privateKey, publicKey } = generateKeyPairSync("ed25519");
  const seed = Buffer.from(privateKey.export({ format: "jwk" }).d as string, "base64url");
  const pub = Buffer.from(publicKey.export({ format: "jwk" }).x as string, "base64url");
  return JSON.stringify([...seed, ...pub]);
}

/** Errors never quote the input: it is secret key material. */
export function publicKeyFromKeypairJson(json: string): Address {
  let bytes: unknown;
  try {
    bytes = JSON.parse(json);
  } catch {
    throw new Error("Keypair file is not valid JSON");
  }
  if (
    !Array.isArray(bytes) ||
    bytes.length !== 64 ||
    !bytes.every((b) => Number.isInteger(b) && b >= 0 && b <= 255)
  ) {
    throw new Error("Keypair file is not an array of 64 bytes");
  }
  return getAddressDecoder().decode(Uint8Array.from(bytes.slice(32)));
}

/** keys/mainnet/ is never loaded by devnet code paths. */
export function assertNotMainnetKeyPath(path: string): void {
  if (/(^|[\\/])keys[\\/]mainnet([\\/]|$)/.test(path)) {
    throw new Error("Refusing a key under keys/mainnet/: this code path runs on devnet only");
  }
}
