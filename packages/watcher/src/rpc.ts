// The watcher's own read of the base layer: `getTransaction` with `jsonParsed` through the
// RPC URL it is given, devnet only. The URL carries an API key, so no error message ever
// quotes it. Read methods only; the package loads no keypair and signs nothing.
import { createSolanaRpc, type Signature } from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { parseBaseTransaction, type BaseTransaction } from "./parse.js";

export type FetchTransaction = (signature: Signature) => Promise<BaseTransaction>;

/** RPC URLs carry API keys; anything printed from an RPC error goes through this. */
export function redactSecrets(message: string): string {
  return message.replace(/(api[-_]?key=)[^&\s"']+/gi, "$1[redacted]");
}

/** Refuses before any RPC call; the message never contains the URL. */
export function assertDevnetRpcUrl(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error("the RPC URL is not a valid URL");
  }
  if (/mainnet/i.test(hostname)) throw new Error("refusing a mainnet RPC URL: the watcher's observer runs on devnet only");
}

/** The URL check cannot catch a proxy, so the first call asks the cluster itself. */
export function assertDevnetGenesisHash(genesisHash: string): void {
  const caip2 = `solana:${genesisHash.slice(0, 32)}`;
  if (caip2 !== DEVNET_CAIP2) throw new Error(`refusing cluster ${caip2}: expected ${DEVNET_CAIP2}`);
}

/**
 * A reader over the devnet RPC. The genesis hash is asserted once, before the first
 * transaction is fetched; every later call reuses the check.
 */
export function createDevnetReader(rpcUrl: string): FetchTransaction {
  assertDevnetRpcUrl(rpcUrl);
  const rpc = createSolanaRpc(rpcUrl);
  let asserted: Promise<void> | undefined;
  return async (signature) => {
    asserted ??= rpc
      .getGenesisHash()
      .send()
      .then((hash) => assertDevnetGenesisHash(hash));
    await asserted;
    let json: unknown;
    try {
      // Version 1 transactions (SIMD-0385) exist on devnet; kit 8 types still say 0.
      json = await rpc.getTransaction(signature, { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 as unknown as 0, commitment: "confirmed" }).send();
    } catch (error) {
      // The cause is kept for the stack, the message is what a log may print: redacted.
      throw new Error(`getTransaction failed: ${redactSecrets(error instanceof Error ? error.message : String(error))}`, { cause: error });
    }
    return parseBaseTransaction(signature, json);
  };
}

/** A reader over recorded responses, keyed by signature; a signature not recorded is not on the base layer. */
export function createRecordedReader(recorded: Readonly<Record<string, unknown>>): FetchTransaction {
  return async (signature) => parseBaseTransaction(signature, recorded[signature] ?? null);
}
