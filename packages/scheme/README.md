# @wakeless/scheme

Status: devnet alpha, unaudited

Types and pure functions of the x402 `batch-settlement-shielded` scheme: the `accepts[]` entry and its `extra`, the `deposit` and `voucher` payloads, `SettlementResponse`, the error codes, the 50-byte voucher message with Ed25519 sign and verify, the channel id and `clientRefId` derivations, and the watermark rule. No network, no I/O, no privacy primitive; `docs/SCHEME.md` is the reference and names the spec lines.

```ts
import { clientRefOf, deriveChannelId, nextWatermark, publicKeyOf, signVoucher, verifyVoucher } from "@wakeless/scheme";

// buyerKeypair: 64-byte Solana keypair (or 32-byte seed); escrowAddress: the 402's extra.escrowAddress; mint: its asset
const buyer = publicKeyOf({ secretKey: buyerKeypair });
const channelId = deriveChannelId({ buyer, escrowAddress, mint, salt: "7" });
const clientRefId = clientRefOf(channelId); // decimal u64, the private transfer's reference
const voucher = signVoucher({ secretKey: buyerKeypair }, { channelId, maxClaimableAmount: "1001", expiresAt: 0 });
console.log(verifyVoucher(buyer, voucher)); // true
console.log(nextWatermark(0n, voucher, 1000n, 100_000n)); // { ok: true, watermark: 1001n }
console.log(clientRefId.length <= 20); // true: digits only, fits a u64
```

`npm install @wakeless/scheme@0.1.0-alpha.0`. ESM only, Node 22 or later.

## Voucher message

Exactly the SVM scheme's bytes, so a standard `batch-settlement` client signs a Wakeless voucher unchanged:

| Offset | Length | Content | Encoding |
| ---: | ---: | --- | --- |
| 0 | 2 | magic | `0x56 0x01` |
| 2 | 32 | `channelId` | base58-decoded |
| 34 | 8 | `maxClaimableAmount` | u64 little-endian, cumulative |
| 42 | 8 | `expiresAt` | i64 little-endian, always `0` |

The signature is Ed25519 over the raw 50 bytes by the buyer's key, carried base58. `expiresAt` is fixed at `0`; a nonzero value is `invalid_batch_settlement_svm_voucher_expiry` and is never signed. `verifyVoucher` returns false and never throws for a malformed voucher, key or signature. Vouchers are verified off-chain only and never placed on-chain, so the cumulative amount is never public.

## Channel id and `clientRefId`

The SVM scheme derives `channelId` as a PDA of the payment-channels program over `("channel", payer, feePayer, token, payerAuthorizer, salt, openSlot)`. Wakeless has no program, no `feePayer` and no `openSlot` (it existed only as a seed), and the buyer is both payer and authorizer, so:

```text
channelId   = base58( sha256( buyer[32] || escrowAddress[32] || mint[32] || u64le(salt) ) )
clientRefId = decimal( u64le( channelId[0..8] ) )
```

`channelId` is 32 bytes and fits the voucher message at offset 2 unchanged. The facilitator recomputes it on every request; a payload whose `channelId` differs is `invalid_batch_settlement_svm_channel_id_mismatch`. `clientRefId` is digits only, fits a u64, and is the encrypted reference field of the binding's private transfers. Never a Memo.

## Watermark

`nextWatermark(prev, voucher, amount, deposit)` returns the new accepted cumulative or a code:

| Rule | Code |
| --- | --- |
| `expiresAt` must be `0` | `invalid_batch_settlement_svm_voucher_expiry` |
| `maxClaimableAmount` must be a decimal u64 | `invalid_payload` |
| must be `> prev` and `>= prev + amount` | `invalid_batch_settlement_svm_cumulative_amount_mismatch` |
| must be `<= deposit` | `invalid_batch_settlement_svm_cumulative_exceeds_deposit` |

`>` holds even for a zero-price route, so a voucher equal to the watermark never pays for anything. `>=` rather than `==` because the client adds the `privacyFeeBps` share to `amount`.

## Error codes

Core x402 V2 codes and the `invalid_batch_settlement_svm_*` codes whose condition exists in the shielded flow are reused verbatim (`SCHEME_ERROR_CODES`), plus `settlement_pending` and `duplicate_settlement`. Shielded-only codes: `shielded_binding_rejected` (a private call was refused and is never retried, never publicly), `shielded_attestation_failed` (the binding could not verify the TEE), `shielded_verify_required` (`/settle` of a voucher without a `/verify` of the same payload within `maxTimeoutSeconds`), `shielded_rate_limited` (the facilitator's 429, retryable after `Retry-After`) and `shielded_unauthorized` (the facilitator's 401 or 403 on its token-protected `/receipts` and `/admin/*` routes). Clients match on the code, never on message text.

## Receipts

`SettlementReceipt` is `{ channelId, period, cumulative, amount, signature, facilitatorSignature }`: one per redeemed period of a channel, `cumulative` the channel's settled watermark after the period (gross of the privacy fee), `amount` what the vendor's private balance received, `signature` the private transfer's, `facilitatorSignature` the facilitator's Ed25519 signature over the 122-byte message `0x52 0x01 || channelId || u64(period).le || u64(cumulative).le || u64(amount).le || signature` (`encodeReceiptMessage`, `RECEIPT_MAGIC`, distinct from the voucher's). `signReceipt(keypair, unsigned)` and `verifyReceipt(pubkey, receipt)` mirror the voucher helpers; `parseSettlementReceipt` checks shape only. The public key is the facilitator's `/supported` `signers["solana:*"][0]`; the vendor fetches receipts from `GET /receipts/:channelId`.

## Payloads

`deposit`: `{ type, channelConfig, depositSignature, deposit: { amount, transaction }, voucher }`. `depositSignature` is the signature of the buyer's private transfer to `extra.escrowAddress` (visibility `private`, `toBalance` `ephemeral`, `clientRefId = clientRefOf(channelId)`), already submitted by the buyer; `deposit.transaction` is that same client-signed transfer in base64 wire format, which the facilitator's binding decodes to verify the buyer and the amount, since the rollup returns neither for an ephemeral signature. The facilitator never co-signs or broadcasts it. A reused `depositSignature` is `duplicate_settlement`; a transfer the binding cannot confirm is `invalid_transaction_state`. `voucher`: unchanged from the spec. `ChannelConfig` is `{ buyer, vendor, mint, salt, withdrawDelay }`. The facilitator-signed off-chain receipt (below) is served by the facilitator's `GET /receipts/:channelId` and may travel in `SettlementResponse.extra.receipt`.

## Dependencies

`@noble/ed25519` 3.2.0, `@noble/hashes` 2.4.0 (sha256 for the channel id, sha512 wired into noble-ed25519's synchronous API), `bs58` 6.0.0. All exact; a test asserts the list.
