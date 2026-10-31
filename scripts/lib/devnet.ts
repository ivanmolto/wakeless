export const DEVNET_CAIP2 = "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1";

/** RPC URLs carry API keys. Anything printed from an RPC error goes through this. */
export function redactSecrets(message: string): string {
  return message.replace(/(api[-_]?key=)[^&\s"']+/gi, "$1[redacted]");
}

/** Refuses before any RPC call. Error messages never contain the URL: it holds the API key. */
export function assertDevnetRpcUrl(url: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error("SOLANA_RPC_URL is not a valid URL");
  }
  if (/mainnet/i.test(hostname)) {
    throw new Error("Refusing a mainnet RPC URL: this code path runs on devnet only");
  }
  if (/[?&]api-key=(&|$)/.test(url)) {
    throw new Error("SOLANA_RPC_URL has an empty api-key: set HELIUS_API_KEY in .env");
  }
}

/** The URL check cannot catch a proxy, so the first RPC call asks the cluster itself. */
export function assertDevnetGenesisHash(genesisHash: string): void {
  const caip2 = `solana:${genesisHash.slice(0, 32)}`;
  if (caip2 !== DEVNET_CAIP2) {
    throw new Error(`Refusing cluster ${caip2}: expected ${DEVNET_CAIP2}`);
  }
}
