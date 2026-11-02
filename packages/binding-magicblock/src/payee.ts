import type { Address, Signature } from "@solana/kit";
import type { Caip2, PayeeBinding } from "@wakeless/binding";
import { parsePrivateBalance, parseTeeTransaction, referenceIdsIn } from "./api.js";
import { assertCluster, attest, login, resolveNetwork, type AttestationReport, type EscrowKeyPair, type MagicBlockSessionConfig, type Resolved, type Session } from "./session.js";
import { createTransport, type MagicBlockTransport } from "./transport.js";

export interface MagicBlockPayeeConfig extends MagicBlockSessionConfig {
  /** The vendor keypair: signs its two logins and nothing else. Never leaves the process. */
  readonly payee: EscrowKeyPair;
}

/**
 * `PayeeBinding` over MagicBlock: the vendor's own read of its private balance and of the
 * transfers made to it. Build with `MagicBlockPayee.create`; it attests the TEE first and
 * refuses to exist otherwise, then logs the vendor in at the TEE RPC and the Payments API.
 * The TEE RPC answers an ephemeral signature with existence and success only (spike,
 * 31 Oct 2026), so that is all `transferStatus` can say.
 */
export class MagicBlockPayee implements PayeeBinding {
  readonly id = "magicblock" as const;
  readonly attestation: AttestationReport;

  private constructor(
    private readonly config: MagicBlockPayeeConfig,
    private readonly transport: MagicBlockTransport,
    private readonly resolved: Resolved,
    private readonly session: Session,
    attestation: AttestationReport,
  ) {
    this.attestation = attestation;
  }

  static async create(config: MagicBlockPayeeConfig): Promise<MagicBlockPayee> {
    const resolved = resolveNetwork(config);
    const transport = config.transport ?? createTransport({ paymentsApiUrl: config.paymentsApiUrl, baseRpcUrl: config.baseRpcUrl });
    const now = config.now ?? (() => new Date());
    const attestation = await attest(transport, resolved.teeRpcUrl, config.network, now, config.attestationReportPath);
    await assertCluster(transport, config.network);
    const session = await login(transport, resolved, config.payee);
    return new MagicBlockPayee(config, transport, resolved, session, attestation);
  }

  network(): Caip2 {
    return this.config.network;
  }

  address(): Address {
    return this.session.address;
  }

  async privateBalance(): Promise<{ balance: bigint; referenceIds: readonly string[] }> {
    const json = await this.transport.api({
      method: "GET",
      path: `/v1/spl/private-balance?address=${this.session.address}&mint=${this.config.mint}&cluster=${this.resolved.apiCluster}`,
      token: this.session.apiToken,
    });
    return { balance: parsePrivateBalance(json).balance, referenceIds: referenceIdsIn(json) };
  }

  async transferStatus(sig: Signature): Promise<"landed" | "failed" | "not_found"> {
    const tx = parseTeeTransaction(
      await this.transport.teeRpc(this.resolved.teeRpcUrl, "getTransaction", [sig, { encoding: "json", commitment: "confirmed", maxSupportedTransactionVersion: 0 }], this.session.teeToken),
    );
    if (tx === null) return "not_found";
    return tx.err === null ? "landed" : "failed";
  }
}
