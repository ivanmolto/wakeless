// What the escrow's binding and the buyer's rail share: the devnet-only checks, TEE
// attestation, the two logins, the private-balance read, and the sign-and-submit of a
// built transaction to the attested TEE RPC. Exactly the calls scripts/spike-magicblock.ts
// proved on 31 Oct 2026. No memo field anywhere.
import { writeFileSync } from "node:fs";
import {
  type generateKeyPair,
  getAddressFromPublicKey,
  getBase58Decoder,
  getBase64EncodedWireTransaction,
  getBase64Encoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  partiallySignTransaction,
  signBytes,
  type Address,
  type Signature,
} from "@solana/kit";
import { BINDING_ERROR_CODES, BindingError, DEVNET_CAIP2, type Caip2 } from "@wakeless/binding";
import {
  mapTransferError,
  parseChallenge,
  parseIdentity,
  parseLoginToken,
  parsePrivateBalance,
  parseTeeTransaction,
  UnconfirmedTransferError,
  type BuiltTransaction,
  type PrivateBalance,
} from "./api.js";
import type { MagicBlockTransport } from "./transport.js";

/** Pinned in package.json; the unit test checks the installed package agrees. */
export const KIT_VERSION = "0.17.3";
export const ATTESTATION_COLLATERAL = "https://pccs.phala.network/tdx/certification/v4";

/** The Payments API `cluster` that routes to the TEE validator on devnet (`devnet` is the public validator). */
const API_CLUSTER_BY_NETWORK: Readonly<Record<string, string>> = { [DEVNET_CAIP2]: "devnet-private" };
const TEE_HOST_BY_NETWORK: Readonly<Record<string, string>> = { [DEVNET_CAIP2]: "devnet-tee.magicblock.app" };

/** A WebCrypto Ed25519 key pair, as the kit creates it (`createKeyPairFromBytes`, `generateKeyPair`). */
export type EscrowKeyPair = Awaited<ReturnType<typeof generateKeyPair>>;

export interface AttestationReport {
  readonly verified: boolean;
  readonly rpcUrl: string;
  readonly host: string;
  readonly validatorIdentity: string | null;
  readonly cluster: Caip2;
  readonly verifier: { readonly package: string; readonly version: string; readonly method: string };
  readonly collateral: string;
  readonly verifiedAt: string;
  readonly error?: string;
}

/** Configuration the escrow's binding and the buyer's rail have in common. */
export interface MagicBlockSessionConfig {
  /** Devnet only in v1; mainnet is a human decision after Gate D. */
  readonly network: Caip2;
  /** Helius devnet RPC. Carries an API key: never logged. */
  readonly baseRpcUrl: string;
  readonly teeRpcUrl: string;
  readonly paymentsApiUrl: string;
  readonly mint: Address;
  /** When set, the attestation report is written here at construction, verified or not. */
  readonly attestationReportPath?: string;
  /** How long to wait for an ephemeral transaction to be readable; default 20 × 1 s. */
  readonly confirm?: { readonly attempts: number; readonly intervalMs: number };
  readonly transport?: MagicBlockTransport;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

export interface Resolved {
  readonly apiCluster: string;
  readonly teeRpcUrl: string;
}

/** Refuses anything but devnet before any network call: the CAIP-2 id, the RPC hostnames, the TEE host. */
export function resolveNetwork(config: MagicBlockSessionConfig): Resolved {
  const apiCluster = API_CLUSTER_BY_NETWORK[config.network];
  const teeHost = TEE_HOST_BY_NETWORK[config.network];
  if (apiCluster === undefined || teeHost === undefined) {
    throw new Error(`Refusing network ${config.network}: this binding runs on devnet only`);
  }
  assertNotMainnetUrl(config.baseRpcUrl, "baseRpcUrl");
  assertNotMainnetUrl(config.paymentsApiUrl, "paymentsApiUrl");
  const teeRpcUrl = config.teeRpcUrl.replace(/\/$/, "");
  if (new URL(teeRpcUrl).protocol !== "https:" || new URL(teeRpcUrl).host !== teeHost) {
    throw new Error(`Refusing teeRpcUrl: expected https://${teeHost}`);
  }
  return { apiCluster, teeRpcUrl };
}

function assertNotMainnetUrl(url: string, name: string): void {
  let hostname: string;
  try {
    hostname = new URL(url).hostname;
  } catch {
    throw new Error(`${name} is not a valid URL`);
  }
  if (/mainnet/i.test(hostname)) throw new Error(`Refusing a mainnet ${name}: this binding runs on devnet only`);
}

/** TEE attestation. A session that cannot attest does not start; the report is written either way. */
export async function attest(transport: MagicBlockTransport, teeRpcUrl: string, cluster: Caip2, now: () => Date, reportPath?: string): Promise<AttestationReport> {
  const identity = await transport
    .teeRpc(teeRpcUrl, "getIdentity", [])
    .then(parseIdentity)
    .catch(() => null);
  const base = {
    rpcUrl: teeRpcUrl,
    host: new URL(teeRpcUrl).hostname,
    validatorIdentity: identity,
    cluster,
    verifier: { package: "@magicblock-labs/ephemeral-rollups-kit", version: KIT_VERSION, method: "verifyTeeRpcIntegrity" },
    collateral: ATTESTATION_COLLATERAL,
    verifiedAt: now().toISOString(),
  };
  let failure: string | undefined;
  try {
    if ((await transport.verifyTeeRpcIntegrity(teeRpcUrl)) === false) failure = "verifier returned false";
  } catch (error) {
    failure = error instanceof Error ? `${error.name}: ${error.message}` : String(error);
  }
  const report: AttestationReport = failure === undefined ? { verified: true, ...base } : { verified: false, ...base, error: failure };
  if (reportPath) writeFileSync(reportPath, JSON.stringify(report, null, 2) + "\n");
  if (!report.verified) {
    throw new BindingError(BINDING_ERROR_CODES.attestationFailed, `TEE attestation of ${base.host} failed: ${failure}`);
  }
  return report;
}

/** The base layer is the cluster the CAIP-2 id names, not a proxy. */
export async function assertCluster(transport: MagicBlockTransport, network: Caip2): Promise<void> {
  const genesis = await transport.baseGenesisHash();
  if (`solana:${genesis.slice(0, 32)}` !== network) throw new Error(`Refusing cluster solana:${genesis.slice(0, 32)}: expected ${network}`);
}

export type Session = {
  readonly address: Address;
  /** The Payments API's own login token (private reads and builds). */
  readonly apiToken: string;
  /** The TEE RPC's token (submit to and read from the rollup). The two differ. */
  readonly teeToken: string;
};

/**
 * Logs a wallet in twice: at the TEE RPC (`getAuthToken`) and at the Payments API
 * (`/v1/spl/challenge` + `/v1/spl/login`), which rejects the TEE token
 * (`TOKEN_IDENTITY_MISMATCH`). Tokens never leave the session object.
 */
export async function login(transport: MagicBlockTransport, resolved: Resolved, keyPair: EscrowKeyPair): Promise<Session> {
  const address = await getAddressFromPublicKey(keyPair.publicKey);
  const signMessage = (message: Uint8Array) => signBytes(keyPair.privateKey, message).then((s) => new Uint8Array(s));
  const { token: teeToken } = await transport.teeLogin(resolved.teeRpcUrl, address, signMessage);
  const challenge = parseChallenge(await transport.api({ method: "GET", path: `/v1/spl/challenge?pubkey=${address}&cluster=${resolved.apiCluster}` }));
  const challengeSignature = getBase58Decoder().decode(await signMessage(new TextEncoder().encode(challenge)));
  const apiToken = parseLoginToken(await transport.api({ method: "POST", path: "/v1/spl/login", body: { pubkey: address, challenge, signature: challengeSignature, cluster: resolved.apiCluster } }));
  return { address, apiToken, teeToken };
}

export async function readPrivateBalance(transport: MagicBlockTransport, resolved: Resolved, session: Session, mint: Address): Promise<PrivateBalance> {
  return parsePrivateBalance(
    await transport.api({ method: "GET", path: `/v1/spl/private-balance?address=${session.address}&mint=${mint}&cluster=${resolved.apiCluster}`, token: session.apiToken }),
  );
}

export interface Confirm {
  readonly attempts: number;
  readonly intervalMs: number;
}

export const DEFAULT_CONFIRM: Confirm = { attempts: 20, intervalMs: 1_000 };

/**
 * Signs a transaction the API built and submits it inside the rollup: the build must be
 * routed to the ephemeral layer at the attested TEE RPC, the session's key must be its only
 * missing signer, and it must be readable with `err: null` before this returns. A build that
 * would land on the public base layer is refused before anything is signed: a public
 * transfer is never made. Returns the signature and the wire bytes exactly as submitted.
 */
export async function submitEphemeral(
  transport: MagicBlockTransport,
  resolved: Resolved,
  session: Session,
  keyPair: EscrowKeyPair,
  built: BuiltTransaction,
  confirm: Confirm,
  sleep: (ms: number) => Promise<void>,
): Promise<{ signature: Signature; wire: string }> {
  if (built.sendTo !== "ephemeral") {
    throw new BindingError(BINDING_ERROR_CODES.bindingRejected, "the builder routed the transfer onto the base layer; a public transfer is never made", { apiCode: "SEND_TO_BASE" });
  }
  const endpoint = (built.sendRpcEndpoint ?? resolved.teeRpcUrl).replace(/\/$/, "");
  if (endpoint !== resolved.teeRpcUrl) {
    throw new BindingError(BINDING_ERROR_CODES.bindingRejected, "the builder named an ephemeral endpoint other than the attested TEE RPC", { apiCode: "UNATTESTED_ENDPOINT" });
  }

  const missing = built.requiredSigners.filter((s) => s !== session.address);
  if (missing.length) throw new Error(`transfer requires a signer this session does not hold (${missing.length} missing)`);
  const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(built.transactionBase64));
  const signed = await partiallySignTransaction([keyPair], unsigned);
  if (Object.values(signed.signatures).some((s) => s === null)) throw new Error("transfer still needs a signature after signing with the session key");
  const wire = getBase64EncodedWireTransaction(signed);
  const signature = getSignatureFromTransaction(signed);

  try {
    await transport.teeRpc(resolved.teeRpcUrl, "sendTransaction", [wire, { encoding: "base64", preflightCommitment: "confirmed" }], session.teeToken);
  } catch (error) {
    mapTransferError(error);
  }
  for (let attempt = 0; ; attempt++) {
    const tx = parseTeeTransaction(await transport.teeRpc(resolved.teeRpcUrl, "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], session.teeToken));
    if (tx !== null) {
      if (tx.err !== null) throw new Error(`ephemeral transaction ${signature} failed inside the rollup: ${JSON.stringify(tx.err)}`);
      break;
    }
    if (attempt + 1 >= confirm.attempts) throw new UnconfirmedTransferError(signature, confirm.attempts * confirm.intervalMs);
    await sleep(confirm.intervalMs);
  }
  return { signature, wire };
}
