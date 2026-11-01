# @wakeless/client

Status: devnet alpha, unaudited

The buyer side of the `batch-settlement-shielded` scheme. Today it holds `deposit()`, the buyer half of task 4.1: open a channel, or top one up, with a private transfer to the facilitator's escrow and build the x402 `deposit` payload. The fetch wrapper that pays requests with vouchers arrives in a later task.

```ts
import { deposit } from "@wakeless/client";
import { MagicBlockBuyer } from "@wakeless/binding-magicblock";

const rail = await MagicBlockBuyer.create({ network, baseRpcUrl, teeRpcUrl, paymentsApiUrl, mint, buyer: buyerKeyPair });
const { payload, channelId, signature } = await deposit({
  rail,
  requirements,          // the batch-settlement-shielded entry of the 402's accepts[]
  buyer: { secretKey },  // the buyer's 64-byte Solana keypair (or its 32-byte seed); signs the voucher
  salt: "7",             // fresh for a new channel, the channel's own for a top-up
  amount: 1_000_000n,    // the deposit, base units; at least extra.minDeposit
  cumulative: 10_010n,   // the first voucher: amount plus the fee share
});
// payload goes in PAYMENT-SIGNATURE as { x402Version: 2, accepted: requirements, payload }
```

## What `deposit()` does

1. Refuses an accept this rail cannot serve, before anything is sent: another scheme, another `extra.binding`, another network, an `extra.teeValidator` that is not the identity the rail attested, an amount below `extra.minDeposit`.
2. Derives `channelId = base58(sha256(buyer || escrowAddress || mint || u64(salt).le))` and `clientRefId` (the first eight bytes, little-endian u64) with `@wakeless/scheme`.
3. Asks the rail for the private transfer of `amount` from the buyer's private balance to `extra.escrowAddress` with that `clientRefId`. On MagicBlock this is one ephemeral → ephemeral transfer built by the Private Payments API (visibility `private`, `toBalance` `ephemeral`), signed by the buyer, submitted to the attested TEE RPC and read back from it; the buyer's private balance must already hold the amount. A rail that cannot do this privately throws (`shielded_binding_rejected`, or the rail's own error); nothing is ever sent publicly.
4. Signs the first (or next) cumulative voucher and returns `{ type: "deposit", channelConfig, depositSignature, deposit: { amount, transaction }, voucher }`. `deposit.transaction` is the client-signed transfer in base64 wire format, which the facilitator's binding decodes to verify the buyer and the amount, since the rollup returns neither for an ephemeral signature.

The buyer key signs the voucher in this package and the transfer inside the rail; neither the key nor its seed is ever passed to the rail's transport or put on the wire. Only the public key (`channelConfig.buyer`) travels.

## Trust boundary

The deposit is private against the public ledger. Three operators see inside: the facilitator (it receives the signed transaction and the amounts), MagicBlock's enclave (it executes the transfer) and, for channels funded through Aurora Confidential Intents, NEAR's private shard (origin and route). The buyer's own vault deposit (`POST /v1/spl/deposit`) that creates its private balance is a base-layer transaction naming the buyer and the vault; it is not made here.

## Dependencies

`@solana/kit` 8.6.0 (the `Address` type of the rail's call), `@wakeless/binding` (the `BuyerBinding` interface), `@wakeless/scheme`. No rail is imported: the caller constructs `MagicBlockBuyer` and passes it in.
