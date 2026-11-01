import type { DepositPayload, PaymentRequirements, SettlementResponse } from "@wakeless/scheme";

/**
 * Where `/settle` hands a `deposit` payload once its shape and voucher have
 * passed `checkDeposit`. `createDepositHandler` (`../deposit.ts`) implements it
 * over `binding.readDeposit`: confirm the private transfer, record the channel
 * with `deposit = amount`, accept the first voucher. It throws a `Rejection` for
 * a verdict on the payment. A server without one answers
 * `unexpected_settle_error` and settles nothing.
 */
export interface DepositHandler {
  settle(input: {
    readonly payload: DepositPayload;
    readonly requirements: PaymentRequirements;
    readonly channelId: string;
    readonly clientRef: string;
  }): Promise<SettlementResponse>;
}
