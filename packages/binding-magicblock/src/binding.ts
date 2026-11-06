import type { Address, Signature } from "@solana/kit";
import {
  type ClientRef,
  type DepositRef,
  type ObserverView,
  type Receipt,
  type SettleRef,
  type SettlementBinding,
  type Caip2,
} from "@wakeless/binding";
import { mapTransferError, parseBuiltTransaction, parseTeeTransaction, type BuiltTransaction } from "./api.js";
import { decodeSignedTransaction, UndecodableTransactionError } from "./deposit.js";
import { parseObserverView } from "./observe.js";
import { assertDelayWindow, DEFAULT_DELAY_WINDOW_MS, pickDelay, splitFor, type DelayWindowMs } from "./policy.js";
import {
  assertCluster,
  attest,
  DEFAULT_CONFIRM,
  login,
  readPrivateBalance,
  resolveNetwork,
  submitEphemeral,
  type AttestationReport,
  type Confirm,
  type EscrowKeyPair,
  type MagicBlockSessionConfig,
  type Resolved,
  type Session,
} from "./session.js";
import { createTransport, type MagicBlockTransport } from "./transport.js";

export { ATTESTATION_COLLATERAL, KIT_VERSION, type AttestationReport, type EscrowKeyPair } from "./session.js";

export interface MagicBlockBindingConfig extends MagicBlockSessionConfig {
  /** The escrow keypair. Its private balance is the pool. */
  readonly escrow: EscrowKeyPair;
  /** Window for the randomised settlement delay; default 30 s to 5 min. */
  readonly delayWindowMs?: DelayWindowMs;
  readonly random?: () => number;
}

/**
 * `SettlementBinding` over MagicBlock's Private Payments API and the devnet Private
 * Ephemeral Rollup, with exactly the calls `scripts/spike-magicblock.ts` proved. Build with
 * `MagicBlockBinding.create`; it attests the TEE first and refuses to exist otherwise.
 */
export class MagicBlockBinding implements SettlementBinding {
  readonly id = "magicblock" as const;
  readonly attestation: AttestationReport;

  private readonly transport: MagicBlockTransport;
  private readonly resolved: Resolved;
  private readonly window: DelayWindowMs;
  private readonly confirm: Confirm;
  private readonly random: () => number;
  private readonly sleep: (ms: number) => Promise<void>;
  private readonly ata: Address;
  /** The part of the escrow's private balance already attributed to a deposit or spent. */
  private accounted: bigint;
  private readonly creditedDeposits = new Set<string>();

  private constructor(
    private readonly config: MagicBlockBindingConfig,
    transport: MagicBlockTransport,
    resolved: Resolved,
    private readonly session: Session,
    ata: Address,
    attestation: AttestationReport,
    initialBalance: bigint,
  ) {
    this.transport = transport;
    this.resolved = resolved;
    this.attestation = attestation;
    this.ata = ata;
    this.window = config.delayWindowMs ?? DEFAULT_DELAY_WINDOW_MS;
    this.confirm = config.confirm ?? DEFAULT_CONFIRM;
    this.random = config.random ?? Math.random;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
    this.accounted = initialBalance;
  }

  static async create(config: MagicBlockBindingConfig): Promise<MagicBlockBinding> {
    const resolved = resolveNetwork(config);
    if (config.delayWindowMs) assertDelayWindow(config.delayWindowMs);
    const transport = config.transport ?? createTransport({ paymentsApiUrl: config.paymentsApiUrl, baseRpcUrl: config.baseRpcUrl });
    const now = config.now ?? (() => new Date());

    // 1. Attestation. A binding that cannot attest does not start.
    const attestation = await attest(transport, resolved.teeRpcUrl, config.network, now, config.attestationReportPath);
    // 2. The base layer is the cluster the CAIP-2 id names.
    await assertCluster(transport, config.network);
    // 3. Logins: the TEE RPC's token and the API's own token, which differ.
    const session = await login(transport, resolved, config.escrow);
    // 4. The escrow's token account and opening balance.
    const balance = await readPrivateBalance(transport, resolved, session, config.mint);
    return new MagicBlockBinding(config, transport, resolved, session, balance.ata as Address, attestation, balance.balance);
  }

  network(): Caip2 {
    return this.config.network;
  }

  escrowAddress(): Address {
    return this.session.address;
  }

  async privateBalance(): Promise<bigint> {
    return (await readPrivateBalance(this.transport, this.resolved, this.session, this.config.mint)).balance;
  }

  /** The TEE RPC answers an ephemeral signature with existence and success only (spike, 31 Oct 2026), under the escrow's own token. */
  async transferStatus(sig: Signature): Promise<"landed" | "failed" | "not_found"> {
    const tx = parseTeeTransaction(
      await this.transport.teeRpc(this.resolved.teeRpcUrl, "getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], this.session.teeToken),
    );
    if (tx === null) return "not_found";
    return tx.err === null ? "landed" : "failed";
  }

  async readDeposit(sig: Signature, ref: DepositRef): Promise<{ amount: bigint; buyer: Address } | null> {
    if (ref.amount <= 0n) throw new RangeError("deposit amount must be positive");
    if (this.creditedDeposits.has(sig)) return null;

    // What the client signed: the buyer and the amount, paying the escrow's token account.
    // Bytes that do not decode as a transaction are not the transaction behind `sig`.
    let decoded;
    try {
      decoded = decodeSignedTransaction(ref.transaction);
    } catch (error) {
      if (error instanceof UndecodableTransactionError) return null;
      throw error;
    }
    if (decoded.signature !== sig || decoded.memo || !decoded.signers.includes(ref.buyer)) return null;
    const pays = decoded.transfers.some((t) => t.destination === this.ata && t.authority === ref.buyer && t.amount === ref.amount && (t.mint === undefined || t.mint === this.config.mint));
    if (!pays) return null;

    // It landed inside the rollup and succeeded.
    const tx = parseTeeTransaction(await this.transport.teeRpc(this.resolved.teeRpcUrl, "getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], this.session.teeToken));
    if (tx === null || tx.err !== null) return null;

    // The escrow's private balance grew by at least the amount since the last attribution.
    const balance = await this.privateBalance();
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
      cluster: this.resolved.apiCluster,
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
    const { signature } = await submitEphemeral(this.transport, this.resolved, this.session, this.config.escrow, built, this.confirm, this.sleep);
    this.accounted -= amount;
    return signature;
  }
}
