import type { Address, Signature } from "@solana/kit";
import { type BuyerBinding, type Caip2, type ClientRef } from "@wakeless/binding";
import { mapTransferError, parseBuiltTransaction, type BuiltTransaction } from "./api.js";
import {
  assertCluster,
  attest,
  DEFAULT_CONFIRM,
  login,
  readPrivateBalance,
  resolveNetwork,
  signBuilt,
  submitEphemeral,
  type AttestationReport,
  type Confirm,
  type EscrowKeyPair,
  type MagicBlockSessionConfig,
  type Resolved,
  type Session,
} from "./session.js";
import { createTransport, type MagicBlockTransport } from "./transport.js";

export interface MagicBlockBuyerConfig extends MagicBlockSessionConfig {
  /** The buyer keypair: signs the deposit transfer. Never leaves the process. */
  readonly buyer: EscrowKeyPair;
}

/** The buyer's private balance is below the deposit. The message names no amount. */
export class InsufficientPrivateBalanceError extends Error {
  constructor() {
    super("the buyer's private balance is below the deposit amount; fund it with POST /v1/spl/deposit (private: true) first");
    this.name = "InsufficientPrivateBalanceError";
  }
}

/**
 * `BuyerBinding` over MagicBlock: the buyer's one private transfer to the escrow, as spike
 * step 3b. Build with `MagicBlockBuyer.create`; it attests the TEE first (the buyer submits
 * its deposit there) and refuses to exist otherwise. `teeValidator` is the attested
 * identity, for the client to compare with the vendor's `extra.teeValidator`.
 */
export class MagicBlockBuyer implements BuyerBinding {
  readonly id = "magicblock" as const;
  readonly attestation: AttestationReport;
  readonly teeValidator: Address;

  private readonly confirm: Confirm;
  private readonly sleep: (ms: number) => Promise<void>;

  private constructor(
    private readonly config: MagicBlockBuyerConfig,
    private readonly transport: MagicBlockTransport,
    private readonly resolved: Resolved,
    private readonly session: Session,
    attestation: AttestationReport,
    teeValidator: Address,
  ) {
    this.attestation = attestation;
    this.teeValidator = teeValidator;
    this.confirm = config.confirm ?? DEFAULT_CONFIRM;
    this.sleep = config.sleep ?? ((ms) => new Promise((r) => setTimeout(r, ms)));
  }

  static async create(config: MagicBlockBuyerConfig): Promise<MagicBlockBuyer> {
    const resolved = resolveNetwork(config);
    const transport = config.transport ?? createTransport({ paymentsApiUrl: config.paymentsApiUrl, baseRpcUrl: config.baseRpcUrl });
    const now = config.now ?? (() => new Date());
    const attestation = await attest(transport, resolved.teeRpcUrl, config.network, now, config.attestationReportPath);
    if (attestation.validatorIdentity === null) throw new Error("the attested TEE RPC reported no validator identity");
    await assertCluster(transport, config.network);
    const session = await login(transport, resolved, config.buyer);
    return new MagicBlockBuyer(config, transport, resolved, session, attestation, attestation.validatorIdentity as Address);
  }

  network(): Caip2 {
    return this.config.network;
  }

  address(): Address {
    return this.session.address;
  }

  /** The buyer's private balance in base units. */
  async privateBalance(): Promise<bigint> {
    return (await readPrivateBalance(this.transport, this.resolved, this.session, this.config.mint)).balance;
  }

  /**
   * The deposit: a private ephemeral → ephemeral transfer buyer → `to` built by the API with
   * `clientRefId = ref.id`, signed here, submitted to the attested TEE RPC with the buyer's
   * TEE token and read back from it. Fails loudly when the buyer's private balance is short,
   * when the API refuses the route, or when the build would land on the base layer; nothing
   * is retried and nothing is ever sent publicly.
   */
  async deposit(to: Address, amount: bigint, ref: ClientRef): Promise<{ sig: Signature; transaction: string }> {
    if (amount <= 0n) throw new RangeError("deposit amount must be positive");
    if ((await this.privateBalance()) < amount) throw new InsufficientPrivateBalanceError();
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
      initAtasIfMissing: true,
    };
    let built: BuiltTransaction;
    try {
      built = parseBuiltTransaction(await this.transport.api({ method: "POST", path: "/v1/spl/transfer", body: request, token: this.session.apiToken }));
    } catch (error) {
      mapTransferError(error);
    }
    const { signature, wire } = await submitEphemeral(this.transport, this.resolved, this.session, this.config.buyer, built, this.confirm, this.sleep);
    return { sig: signature, transaction: wire };
  }

  /**
   * The buyer's withdrawal to its base token account, as spike step 6 did for the vendor:
   * `POST /v1/spl/withdraw` builds a base-layer transaction the buyer signs and submits to
   * the base RPC. It is a public transaction naming the buyer and the vault, and the only
   * base-layer submission in this package; the client makes it only when its owner says so.
   */
  async withdraw(amount: bigint): Promise<{ sig: Signature }> {
    if (amount <= 0n) throw new RangeError("withdraw amount must be positive");
    if ((await this.privateBalance()) < amount) throw new InsufficientPrivateBalanceError();
    const request = { owner: this.session.address, cluster: this.resolved.apiCluster, mint: this.config.mint, amount: Number(amount), initAtasIfMissing: true, idempotent: true };
    const built = parseBuiltTransaction(await this.transport.api({ method: "POST", path: "/v1/spl/withdraw", body: request, token: this.session.apiToken }));
    if (built.sendTo !== "base") throw new Error("the withdraw builder did not route to the base layer");
    const { signature, wire } = await signBuilt(this.session, this.config.buyer, built);
    await this.transport.baseSubmit(wire, signature, built.lastValidBlockHeight);
    return { sig: signature };
  }
}
