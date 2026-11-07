# @wakeless/binding

Status: devnet alpha, unaudited

The `SettlementBinding` interface: what a Wakeless settlement pool must provide, typed with `@solana/kit` addresses and signatures and `bigint` base-unit amounts. `@wakeless/binding-magicblock` implements it; Rings and Privacy Cash bindings follow the same shape. Nothing outside a `packages/binding-*` package may import a privacy primitive directly; an eslint rule enforces it.

```ts
import { BINDING_ERROR_CODES, clientRefId, isBindingError, type SettlementBinding } from "@wakeless/binding";

// Program against the interface; a binding package builds the instance (MagicBlockBinding.create on devnet).
export async function refundBuyer(binding: SettlementBinding, buyer: Parameters<SettlementBinding["refund"]>[0], owed: bigint, ref: string) {
  try {
    return { refunded: owed, sig: (await binding.refund(buyer, owed, { id: clientRefId(ref) })).sig };
  } catch (error) {
    if (isBindingError(error, BINDING_ERROR_CODES.bindingRejected)) return { refunded: 0n, stillOwed: owed }; // never retried publicly
    throw error;
  }
}
```

`npm install @wakeless/binding@0.1.0-alpha.0`. ESM only, Node 22 or later. Types only plus the error and reference helpers; it moves nothing by itself.

```ts
interface SettlementBinding {
  id: "magicblock" | "rings" | "privacycash";
  network(): Caip2;
  escrowAddress(): Address;
  readDeposit(sig: Signature, ref: DepositRef): Promise<{ amount: bigint; buyer: Address } | null>;
  settle(to: Address, amount: bigint, ref: SettleRef): Promise<{ sig: Signature; receipt: Receipt }>;
  refund(to: Address, amount: bigint, ref: ClientRef): Promise<{ sig: Signature }>;
  privateBalance(): Promise<bigint>;
  transferStatus(sig: Signature): Promise<"landed" | "failed" | "not_found">;
  observe(sig: Signature): Promise<ObserverView>;
}
```

## References

`ClientRefId` is the decimal u64 the Private Payments API's `clientRefId` field takes: digits only, encrypted inside the rollup, returned by no read endpoint. A channel's reference is derived by `@wakeless/scheme` (`clientRefOf`: the first eight bytes of the base58 channel id read as a little-endian u64) and handed to the binding as a `ClientRefId`; the binding derives nothing from a channel id. A binding never writes a Memo instruction; receipt data goes in `clientRefId` and in the facilitator-signed off-chain `Receipt`.

The three calls take three refinements of `ClientRef { id }`:

- `DepositRef` adds `buyer`, `amount` and the client-signed `transaction` (base64). The enclave returns neither sender, amount nor `clientRefId` for an ephemeral transaction, so a binding verifies the buyer and the amount from the signed transaction the x402 `deposit` payload carries, confirms the signature landed, and checks the escrow's private-balance delta. It cannot check the `clientRefId` against the chain; that reference is the facilitator's own bookkeeping.
- `SettleRef` adds `channelId`, `period` and `cumulative`, which fill the `Receipt`.
- `refund` takes a plain `ClientRef`.

## The buyer's side

`BuyerBinding` is the one call a buyer makes on a rail: `deposit(to, amount, ref)` builds, signs and submits the private transfer from the buyer's own private balance to the escrow with `ref.id` as the encrypted reference, waits until it is readable, and returns `{ sig, transaction }`, the signature and the signed transaction in base64 wire format exactly as submitted, which the x402 `deposit` payload carries for the facilitator's `readDeposit`. `teeValidator`, when the rail has a TEE, is the identity it attested at construction; `@wakeless/client` refuses an accept whose `extra.teeValidator` differs. `@wakeless/binding-magicblock` implements it as `MagicBlockBuyer`.

```ts
interface BuyerBinding {
  id: "magicblock" | "rings" | "privacycash";
  teeValidator?: Address;
  network(): Caip2;
  deposit(to: Address, amount: bigint, ref: ClientRef): Promise<{ sig: Signature; transaction: string }>;
  withdraw?(amount: bigint): Promise<{ sig: Signature }>;
}
```

`withdraw(amount)` (optional; task 8.1) moves part of the buyer's private balance back to its base-layer token account. It is a public base-layer transaction naming the buyer and the vault; the client offers it after a channel refund and performs it only when its owner says so.

## The vendor's side

`PayeeBinding` is a vendor's read-only view of a rail, logged in with the vendor's own key: its private balance with every reference id the rail's read endpoint exposes beside it (none is expected), and whether a transfer signature is readable on the rail and succeeded. It moves nothing. `@wakeless/binding-magicblock` implements it as `MagicBlockPayee`; the vendor's receipt reader (`pnpm vendor:receipts`) uses it.

```ts
interface PayeeBinding {
  id: "magicblock" | "rings" | "privacycash";
  network(): Caip2;
  address(): Address;
  privateBalance(): Promise<{ balance: bigint; referenceIds: readonly string[] }>;
  transferStatus(sig: Signature): Promise<"landed" | "failed" | "not_found">;
}
```

## Observer view

`observe(sig)` returns what the public ledger shows for a signature, which is what the watcher checks: `programIds`, `signers`, `plaintextAmounts`, `plaintextRecipients`, `memoText`, `feeTransfers`. A signature that executed inside the rollup is not on the base layer at all: `onBaseLayer` is false and every list is empty.

## Errors

| Code | Meaning | Retry |
| --- | --- | --- |
| `shielded_attestation_failed` | `verifyTeeRpcIntegrity` failed at construction; the binding does not start | no |
| `shielded_binding_rejected` | The private transfer was refused: `UNSUPPORTED_TRANSFER_ROUTE`, an ingress (screening) rejection, or a build that would route onto the public base layer. The amount stays owed | never, and never as a public transfer |

A binding that cannot complete a call privately throws; none falls back to a public transfer.

A third outcome has no code of its own: a transfer the binding submitted and did not see confirmed. The binding throws an error carrying the transfer's `signature` (the MagicBlock binding's `UnconfirmedTransferError`); `unconfirmedSignatureOf(error)` reads it from any thrown value by shape, a 64-byte base58 `signature`, so no caller has to import a binding. The caller keeps the amount owed and the signature, reports it as `settlement_pending`, and never resends on that signature alone: it asks the rail first through `transferStatus(sig)`, which answers `landed`, `failed` or `not_found` for a transfer the escrow submitted, under the escrow's own login, with existence and success only, never the amount or the recipient. `not_found` proves nothing either way, and the facilitator's worker then settles the fate against the escrow's private balance (`packages/facilitator/README.md`, Redemption).
