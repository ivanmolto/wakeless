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
import {
  BINDING_ERROR_CODES,
  BindingError,
  DEVNET_CAIP2,
  type Caip2,
  type ClientRef,
  type DepositRef,
  type ObserverView,
  type Receipt,
  type SettleRef,
  type SettlementBinding,
} from "@wakeless/binding";
import {
  mapTransferError,
  parseBuiltTransaction,
  parseChallenge,
  parseIdentity,
  parseLoginToken,
  parsePrivateBalance,
  parseTeeTransaction,
  UnconfirmedTransferError,
  type BuiltTransaction,
} from "./api.js";
import { decodeSignedTransaction } from "./deposit.js";
import { parseObserverView } from "./observe.js";
import { assertDelayWindow, DEFAULT_DELAY_WINDOW_MS, pickDelay, splitFor, type DelayWindowMs } from "./policy.js";
import { createTransport, type MagicBlockTransport } from "./transport.js";

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

export interface MagicBlockBindingConfig {
  /** Devnet only in v1; mainnet is a human decision after Gate D. */
  readonly network: Caip2;
  /** Helius devnet RPC. Carries an API key: never logged. */
  readonly baseRpcUrl: string;
  readonly teeRpcUrl: string;
  readonly paymentsApiUrl: string;
  readonly mint: Address;
  /** The escrow keypair. Its private balance is the pool. */
  readonly escrow: EscrowKeyPair;
  /** Window for the randomised settlement delay; default 30 s to 5 min. */
  readonly delayWindowMs?: DelayWindowMs;
  /** When set, the attestation report is written here at construction, verified or not. */
  readonly attestationReportPath?: string;
  /** How long to wait for an ephemeral transaction to be readable; default 20 × 1 s. */
  readonly confirm?: { readonly attempts: number; readonly intervalMs: number };
  readonly transport?: MagicBlockTransport;
  readonly random?: () => number;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
}

type Session = {
  address: Address;
  ata: Address;
  apiToken: string;
  teeToken: string;
};

/**
 * `SettlementBinding` over MagicBlock's Private Payments API and the devnet Private
 * Ephemeral Rollup, with exactly the calls `scripts/spike-magicblock.ts` proved. Build with
 * `MagicBlockBinding.create`; it attests the TEE first and refuses to exist otherwise.
 */
export class MagicBlockBinding implements SettlementBinding {
  readonly id = "magicblock" as const;
  readonly attestation: AttestationReport;

  private readonly transport: MagicBlockTransport;
  private readonly apiCluster: string;
  private readonly window: DelayWindowMs;
  private readonly confirm: { attempts: number; intervalMs: number };
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  /** The part of the escrow's private balance already attributed to a deposit or spent. */
  private accounted: bigint;
  private readonly creditedDeposits = new Set<string>();

  private constructor(
    private readonly config: MagicBlockBindingConfig,
    transport: MagicBlockTransport,
    private readonly session: Session,
    attestation: AttestationReport,
    initialBalance: bigint,
  ) {
    this.transport = transport;
    this.attestation = attestation;
    this.apiCluster = API_CLUSTER_BY_NETWORK[config.network]!;
    this.window = config.delayWindowMs ?? DEFAULT_DELAY_WINDOW_MS;
    this.confirm = config.confirm ?? { attempts: 20, intervalMs: 1_000 };
    this.random = config.random ?? Math.random;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.accounted = initialBalance;
  }

  static async create(config: MagicBlockBindingConfig): Promise<MagicBlockBinding> {
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
    if (config.delayWindowMs) assertDelayWindow(config.delayWindowMs);
    const transport = config.transport ?? createTransport({ paymentsApiUrl: config.paymentsApiUrl, baseRpcUrl: config.baseRpcUrl });
    const now = config.now ?? (() => new Date());

    // 1. Attestation. A binding that cannot attest does not start.
    const attestation = await attest(transport, teeRpcUrl, config.network, now, config.attestationReportPath);

    // 2. The base layer is the cluster the CAIP-2 id names, not a proxy.
    const genesis = await transport.baseGenesisHash();
    if (`solana:${genesis.slice(0, 32)}` !== config.network) throw new Error(`Refusing cluster solana:${genesis.slice(0, 32)}: expected ${config.network}`);

    // 3. Logins: the TEE RPC's token (submit and read inside the rollup) and the API's own
    //    token, which differ (TOKEN_IDENTITY_MISMATCH otherwise).
    const address = await getAddressFromPublicKey(config.escrow.publicKey);
    const signMessage = (message: Uint8Array) => signBytes(config.escrow.privateKey, message).then((s) => new Uint8Array(s));
    const { token: teeToken } = await transport.teeLogin(teeRpcUrl, address, signMessage);
    const challenge = parseChallenge(await transport.api({ method: "GET", path: `/v1/spl/challenge?pubkey=${address}&cluster=${apiCluster}` }));
    const challengeSignature = getBase58Decoder().decode(await signMessage(new TextEncoder().encode(challenge)));
    const apiToken = parseLoginToken(await transport.api({ method: "POST", path: "/v1/spl/login", body: { pubkey: address, challenge, signature: challengeSignature, cluster: apiCluster } }));

    // 4. The escrow's token account and opening balance.
    const balance = parsePrivateBalance(await transport.api({ method: "GET", path: `/v1/spl/private-balance?address=${address}&mint=${config.mint}&cluster=${apiCluster}`, token: apiToken }));
    const session: Session = { address, ata: balance.ata as Address, apiToken, teeToken };
    return new MagicBlockBinding({ ...config, teeRpcUrl }, transport, session, attestation, balance.balance);
  }

  network(): Caip2 {
    return this.config.network;
  }

  escrowAddress(): Address {
    return this.session.address;
  }

  async privateBalance(): Promise<bigint> {
    return (await this.readBalance()).balance;
  }

  private async readBalance() {
    return parsePrivateBalance(
      await this.transport.api({ method: "GET", path: `/v1/spl/private-balance?address=${this.session.address}&mint=${this.config.mint}&cluster=${this.apiCluster}`, token: this.session.apiToken }),
    );
  }

  async readDeposit(sig: Signature, ref: DepositRef): Promise<{ amount: bigint; buyer: Address } | null> {
    if (ref.amount <= 0n) throw new RangeError("deposit amount must be positive");
    if (this.creditedDeposits.has(sig)) return null;

    // What the client signed: the buyer and the amount, paying the escrow's token account.
    const decoded = decodeSignedTransaction(ref.transaction);
    if (decoded.signature !== sig || decoded.memo || !decoded.signers.includes(ref.buyer)) return null;
    const pays = decoded.transfers.some((t) => t.destination === this.session.ata && t.authority === ref.buyer && t.amount === ref.amount && (t.mint === undefined || t.mint === this.config.mint));
    if (!pays) return null;

    // It landed inside the rollup and succeeded.
    const tx = parseTeeTransaction(await this.transport.teeRpc(this.config.teeRpcUrl, "getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], this.session.teeToken));
    if (tx === null || tx.err !== null) return null;

    // The escrow's private balance grew by at least the amount since the last attribution.
    const balance = (await this.readBalance()).balance;
    if (balance - this.accounted < ref.amount) return null;
    this.accounted += ref.amount;
    this.creditedDeposits.add(sig);
    return { amount: ref.amount, buyer: ref.buyer };
  }

  async settle(to: Address, amount: bigint, ref: SettleRef): Promise<{ sig: Signature; receipt: Receipt }> {
    const { minDelayMs, maxDelayMs } = pickDelay(this.window, this.random);
    const sig = await this.privateTransfer(to, amount, ref, { minDelayMs: String(minDelayMs), maxDelayMs: String(maxDelayMs), split: splitFor(amount) });
    return { sig, receipt: { channelId: ref.channelId, period: ref.period, cumulative: ref.cumulative, amount, signature: sig, ref: ref.id } };
  }

  async refund(to: Address, amount: bigint, ref: ClientRef): Promise<{ sig: Signature }> {
    return { sig: await this.privateTransfer(to, amount, ref, {}) };
  }

  async observe(sig: Signature): Promise<ObserverView> {
    return parseObserverView(sig, await this.transport.baseTransaction(sig));
  }

  /**
   * One private transfer escrow → `to` inside the rollup, as spike step 4: built by the API,
   * signed here, submitted to the TEE RPC with the escrow's TEE token, read back from it.
   * No memo field, ever. Any refusal is `shielded_binding_rejected`; nothing is retried.
   */
  private async privateTransfer(to: Address, amount: bigint, ref: ClientRef, shaping: { minDelayMs?: string; maxDelayMs?: string; split?: number }): Promise<Signature> {
    if (amount <= 0n) throw new RangeError("amount must be positive");
    const request = {
      from: this.session.address,
      to,
      cluster: this.apiCluster,
      mint: this.config.mint,
      amount: Number(amount),
      visibility: "private",
      fromBalance: "ephemeral",
      toBalance: "ephemeral",
      clientRefId: ref.id,
      ...shaping,
      gasless: false,
      initAtasIfMissing: true,
    };
    let built: BuiltTransaction;
    try {
      built = parseBuiltTransaction(await this.transport.api({ method: "POST", path: "/v1/spl/transfer", body: request, token: this.session.apiToken }));
    } catch (error) {
      mapTransferError(error);
    }
    if (built.sendTo !== "ephemeral") {
      throw new BindingError(BINDING_ERROR_CODES.bindingRejected, "the builder routed the transfer onto the base layer; a public transfer is never made", { apiCode: "SEND_TO_BASE" });
    }
    const endpoint = (built.sendRpcEndpoint ?? this.config.teeRpcUrl).replace(/\/$/, "");
    if (endpoint !== this.config.teeRpcUrl) {
      throw new BindingError(BINDING_ERROR_CODES.bindingRejected, "the builder named an ephemeral endpoint other than the attested TEE RPC", { apiCode: "UNATTESTED_ENDPOINT" });
    }

    const missing = built.requiredSigners.filter((s) => s !== this.session.address);
    if (missing.length) throw new Error(`transfer requires a signer the escrow does not hold (${missing.length} missing)`);
    const unsigned = getTransactionDecoder().decode(getBase64Encoder().encode(built.transactionBase64));
    const signed = await partiallySignTransaction([this.config.escrow], unsigned);
    if (Object.values(signed.signatures).some((s) => s === null)) throw new Error("transfer still needs a signature after signing with the escrow key");
    const wire = getBase64EncodedWireTransaction(signed);
    const signature = getSignatureFromTransaction(signed);

    try {
      await this.transport.teeRpc(this.config.teeRpcUrl, "sendTransaction", [wire, { encoding: "base64", preflightCommitment: "confirmed" }], this.session.teeToken);
    } catch (error) {
      mapTransferError(error);
    }
    for (let attempt = 0; ; attempt++) {
      const tx = parseTeeTransaction(await this.transport.teeRpc(this.config.teeRpcUrl, "getTransaction", [signature, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], this.session.teeToken));
      if (tx !== null) {
        if (tx.err !== null) throw new Error(`ephemeral transaction ${signature} failed inside the rollup: ${JSON.stringify(tx.err)}`);
        break;
      }
      if (attempt + 1 >= this.confirm.attempts) throw new UnconfirmedTransferError(signature, this.confirm.attempts * this.confirm.intervalMs);
      await this.sleep(this.confirm.intervalMs);
    }
    this.accounted -= amount;
    return signature;
  }
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

async function attest(transport: MagicBlockTransport, teeRpcUrl: string, cluster: Caip2, now: () => Date, reportPath?: string): Promise<AttestationReport> {
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
