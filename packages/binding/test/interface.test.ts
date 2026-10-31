import { address, signature, type Address, type Signature } from "@solana/kit";
import { describe, expect, expectTypeOf, it } from "vitest";
import {
  BINDING_ERROR_CODES,
  BindingError,
  DEVNET_CAIP2,
  channelId,
  clientRefId,
  isBindingError,
  type Caip2,
  type DepositRef,
  type ObserverView,
  type Receipt,
  type SettleRef,
  type SettlementBinding,
} from "../src/index.js";

const ESCROW = address("EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6");
const SIG = signature("2JjvPa9kXC17oVmiZh49evtGu1xExduy2Fr9kDvDrn2kNGq6fXYUM5yYBYWS2XFdeoZy4J1ttpTdag2d7X8bdvTN");

/** A binding that does nothing private and exists only to type-check against the interface. */
class FakeBinding implements SettlementBinding {
  readonly id = "magicblock" as const;
  network(): Caip2 {
    return DEVNET_CAIP2;
  }
  escrowAddress(): Address {
    return ESCROW;
  }
  async readDeposit(_sig: Signature, ref: DepositRef) {
    return { amount: ref.amount, buyer: ref.buyer };
  }
  async settle(_to: Address, amount: bigint, ref: SettleRef): Promise<{ sig: Signature; receipt: Receipt }> {
    return { sig: SIG, receipt: { channelId: ref.channelId, period: ref.period, cumulative: ref.cumulative, amount, signature: SIG, ref: ref.id } };
  }
  async refund(): Promise<{ sig: Signature }> {
    return { sig: SIG };
  }
  async privateBalance() {
    return 0n;
  }
  async observe(sig: Signature): Promise<ObserverView> {
    return { signature: sig, onBaseLayer: false, programIds: [], signers: [], plaintextAmounts: [], plaintextRecipients: [], memoText: [], feeTransfers: [] };
  }
}

describe("SettlementBinding", () => {
  it("a fake binding satisfies SettlementBinding", async () => {
    const binding = new FakeBinding();
    expectTypeOf(binding).toMatchTypeOf<SettlementBinding>();
    expectTypeOf<SettlementBinding["settle"]>().returns.resolves.toEqualTypeOf<{ sig: Signature; receipt: Receipt }>();
    expectTypeOf<SettlementBinding["readDeposit"]>().returns.resolves.toEqualTypeOf<{ amount: bigint; buyer: Address } | null>();
    expectTypeOf<SettlementBinding["privateBalance"]>().returns.resolves.toBeBigInt();

    // ObserverView and Receipt shapes are exported with the fields the watcher and the facilitator read.
    expectTypeOf<ObserverView>().toHaveProperty("signature");
    expectTypeOf<ObserverView>().toHaveProperty("programIds");
    expectTypeOf<ObserverView>().toHaveProperty("signers");
    expectTypeOf<ObserverView>().toHaveProperty("plaintextAmounts");
    expectTypeOf<ObserverView>().toHaveProperty("plaintextRecipients");
    expectTypeOf<ObserverView>().toHaveProperty("memoText");
    expectTypeOf<ObserverView>().toHaveProperty("feeTransfers");
    expectTypeOf<Receipt>().toEqualTypeOf<{
      readonly channelId: ReturnType<typeof channelId>;
      readonly period: number;
      readonly cumulative: bigint;
      readonly amount: bigint;
      readonly signature: Signature;
      readonly ref: ReturnType<typeof clientRefId>;
    }>();

    const ref: SettleRef = { id: clientRefId("2001"), channelId: channelId("ab".repeat(32)), period: 1, cumulative: 500_000n };
    const { receipt } = await binding.settle(ESCROW, 500_000n, ref);
    expect(receipt).toEqual({ channelId: ref.channelId, period: 1, cumulative: 500_000n, amount: 500_000n, signature: SIG, ref: "2001" });
  });

  it("error codes take the shielded_ prefix and are never retryable", () => {
    expect(Object.values(BINDING_ERROR_CODES).every((c) => c.startsWith("shielded_"))).toBe(true);
    const err = new BindingError(BINDING_ERROR_CODES.bindingRejected, "route refused", { apiCode: "UNSUPPORTED_TRANSFER_ROUTE" });
    expect(err.retryable).toBe(false);
    expect(err.message).toBe("shielded_binding_rejected: route refused");
    expect(err.apiCode).toBe("UNSUPPORTED_TRANSFER_ROUTE");
    expect(isBindingError(err, "shielded_binding_rejected")).toBe(true);
    expect(isBindingError(err, "shielded_attestation_failed")).toBe(false);
    expect(isBindingError(new Error("x"))).toBe(false);
  });
});
