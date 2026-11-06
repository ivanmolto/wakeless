# Wakeless and the x402 `batch-settlement` standard

Status: devnet alpha, unaudited. Task 1.3, read on 31 Oct 2026.

This document records what Wakeless takes verbatim from the x402 V2 standard, what it must change, and the `accepts[]` entry it advertises. It is the reference for `packages/scheme` (task 3.1) and for `docs/DEVIATIONS.md`. It contains no code.

**Sources.** All citations are to the clone at `vendor/x402` (gitignored), commit `e208bd39030be35a0f807eb3bf4f043354273866` of 31 Oct 2026. Paths are relative to that clone; a suffix such as `:L123` is line 123 of that file. Four spec files and the SVM mechanism's `batch-settlement` directory were read in full:

| Short name | Path |
| --- | --- |
| core | `specs/x402-specification-v2.md` |
| scheme | `specs/schemes/batch-settlement/scheme_batch_settlement.md` |
| svm | `specs/schemes/batch-settlement/scheme_batch_settlement_svm.md` |
| http | `specs/transports-v2/http.md` |
| code | `typescript/packages/mechanisms/svm/src/batch-settlement/` and the `payment-channels/` helpers it imports |

The standing rule from `CLAUDE.md` applies: when the spec and the code disagree, the spec wins and the disagreement goes to `docs/DEVIATIONS.md`. One such disagreement is noted in section 1.4 (`errorMessage`).

## 1. What we reuse verbatim

### 1.1 Transport

The scheme reuses the x402 V2 HTTP transport unchanged (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L220`-`L224`). The three headers are the whole wire protocol; bodies are a server concern (`specs/transports-v2/http.md:L235`):

| Header | Direction | Carries | Cite |
| --- | --- | --- | --- |
| `PAYMENT-REQUIRED` | server to client, on a `402` | base64 `PaymentRequired` | `specs/transports-v2/http.md:L11`-`L15`, `:L168` |
| `PAYMENT-SIGNATURE` | client to server | base64 `PaymentPayload` | `specs/transports-v2/http.md:L57`-`L60`, `:L169` |
| `PAYMENT-RESPONSE` | server to client | base64 `SettlementResponse` | `specs/transports-v2/http.md:L113`-`L116`, `:L170` |

Status mapping: payment required and payment failed are `402`, a malformed payload is `400`, a processing error is `500` (`specs/transports-v2/http.md:L241`-`L247`). The facilitator endpoints are `POST /verify`, `POST /settle` and `GET /supported` (`specs/x402-specification-v2.md:L307`, `:L395`, `:L441`). The scheme resolves to the protocol-default `authorization` flow, verify then resource then settle (`specs/x402-specification-v2.md:L297`; `specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L242`), so `/verify` is read-only and must not write chain or payment state (`specs/x402-specification-v2.md:L309`).

### 1.2 `PaymentRequired` and `PaymentRequirements`

`PaymentRequired` (`specs/x402-specification-v2.md:L112`-`L118`):

| Field | Type | Required |
| --- | --- | --- |
| `x402Version` | number, must be `2` | yes |
| `error` | string | no |
| `resource` | `ResourceInfo` | yes |
| `accepts` | `PaymentRequirements[]` | yes |
| `extensions` | object | no |

`ResourceInfo` is `url` (required), `description`, `mimeType`, `serviceName` (printable ASCII, max 32), `tags` (max 5), `iconUrl` (`specs/x402-specification-v2.md:L134`-`L141`).

Each `PaymentRequirements` entry in `accepts[]` (`specs/x402-specification-v2.md:L122`-`L130`):

| Field | Type | Required | Note |
| --- | --- | --- | --- |
| `scheme` | string | yes | |
| `network` | string | yes | CAIP-2 |
| `amount` | string | yes | atomic units |
| `asset` | string | yes | mint address on SVM |
| `payTo` | string | yes | recipient |
| `maxTimeoutSeconds` | number | yes | |
| `extra` | object | no | reserved keys `assetTransferMethod`, `paymentFlow`; other keys are scheme-specific |

The SVM scheme makes `extra` required and fixes `scheme` to `"batch-settlement"`, `asset` to a concrete SPL or Token-2022 mint, and `amount` to the per-request amount (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L228`-`L236`). Its `extra` keys (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L240`-`L258`), with the Wakeless decision for each (reasoning in section 4):

| `extra` key | Required | Wakeless |
| --- | --- | --- |
| `paymentFlow` | no, must be `"authorization"` when present (`:L242`) | keep |
| `feePayer` | yes (`:L243`) | drop, no sponsor and no rent |
| `receiverAuthorizer` | yes (`:L244`) | drop in v1, no cooperative close signature |
| `voucherSigner` | no, `"client"` or `"server"` (`:L245`) | keep, always `"client"` |
| `operator` | only in server mode (`:L246`) | drop, never server mode |
| `withdrawDelay` | yes, `900..=2592000`, `>= maxTimeoutSeconds` (`:L247`) | keep |
| `tokenProgram` | yes (`:L248`) | keep |
| `memo` | no, max 256 bytes (`:L249`) | drop, a Memo is a watcher failure |
| `recentBlockhash`, `recentSlot` | no (`:L250`-`L251`) | drop, no client-built transaction |
| `minDeposit` | no, `>= amount` (`:L252`) | keep |
| `maxIdleSecs` | no, copied from `/supported` (`:L253`) | keep |
| `transactionVersions` | no (`:L254`) | drop |
| `maxClaimChannels`, `maxSettleChannels` | no (`:L255`-`L256`) | drop |
| `channelState`, `voucherState` | no, corrective 402 only (`:L257`-`L258`) | keep |

`minDeposit` is a target the client should honour; the server may reject below it with `invalid_batch_settlement_svm_deposit_below_min_deposit`, and the facilitator must not enforce it (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L265`-`L271`). The reference type for all of this is `BatchExtra` (`typescript/packages/mechanisms/svm/src/batch-settlement/types.ts:L10`-`L40`) and `BatchRequirements` (`:L372`-`L380`); the guard `isBatchRequirements` additionally requires `network` to start with `solana:` (`:L486`-`L499`).

### 1.3 `PaymentPayload` and its variants

The envelope (`specs/x402-specification-v2.md:L197`-`L205`): `x402Version` (required), `resource` (optional), `accepted` (required, a copy of the chosen `PaymentRequirements`), `payload` (required, scheme-specific), `extensions` (optional). For every facilitator call `paymentPayload.accepted` must equal `paymentRequirements` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L729`-`L731`).

The inner `payload` is a tagged union on `payload.type`. `/verify` takes all four client variants; `/settle` takes `deposit` and `refund` directly, and a `voucher` is accepted off-chain by the server (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L483`-`L486`). Wakeless v1 implements two of them.

**`ChannelConfig`**, carried by every variant (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L347`-`L357`): `payer`, `payerAuthorizer`, `receiver` (must equal `payTo`), `receiverAuthorizer`, `token` (must equal `asset`), `withdrawDelay`, `salt` (decimal u64), `openSlot` (u64), optional `voucherSigner`. Reference type `BatchChannelConfig` (`typescript/packages/mechanisms/svm/src/batch-settlement/types.ts:L71`-`L81`).

**`BatchVoucher`** (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L395`-`L400`): `channelId` (base58), `maxClaimableAmount` (decimal string, cumulative), `expiresAt` (must be `0`), `signature` (base58 Ed25519 by `channelConfig.payerAuthorizer`). Reference type `BatchVoucher` (`typescript/packages/mechanisms/svm/src/batch-settlement/types.ts:L83`-`L88`). The signed bytes are section 2.

**`deposit`** opens a channel or tops it up and authorizes the current request (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L488`-`L498`):

| Field | Note | Wakeless |
| --- | --- | --- |
| `type` | `"deposit"` | same |
| `channelConfig` | full `ChannelConfig` | reduced, section 4 |
| `voucher` | required in client mode: cumulative for this request | same, the first voucher |
| `authorization` | server mode only | never |
| `deposit.amount` | atomic units | same |
| `deposit.transaction` | base64 client-signed `open` or `top_up` for the facilitator to co-sign and broadcast | kept, with another meaning: the buyer's already-submitted private transfer, base64, which the binding decodes to verify buyer and amount; plus `depositSignature`, section 4 |

Reference type `BatchDepositPayload` (`typescript/packages/mechanisms/svm/src/batch-settlement/types.ts:L95`-`L104`).

**`voucher`** is the steady-state paid request with no transaction (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L545`-`L552`): `type: "voucher"`, `channelConfig`, `voucher`. Reference type `BatchVoucherPayload` (`typescript/packages/mechanisms/svm/src/batch-settlement/types.ts:L106`-`L110`). Wakeless carries it unchanged.

**`authorization`** (server mode, `:L595`-`L602`) is not implemented in v1. **`refund`** (close, `:L629`-`L639`) is, since task 8.1, with the payer-signed `request_close` transaction (`:L639`) replaced by a buyer-signed close message: `type: "refund"`, `channelConfig`, `voucher` (the buyer's latest), `closeSignature` (Ed25519 by `channelConfig.buyer` over `0x56 0x02 || channelId || u64(maxClaimableAmount).le`, 42 bytes). The buyer sends it to the facilitator's `/settle` directly; the channel moves to `closing`, the vendor's latest voucher is accepted for `withdrawDelay` seconds, then the facilitator pays the vendor what is owed and makes a private transfer of `deposit - settled` back to the buyer's private balance (briefing §3, x402 mapping table). `/settle` answers `extra.closeState` and the same request later reports the close as it stands. A wrong close signature is `invalid_batch_settlement_svm_close_authorization` (reused from `:L1970`, below).

Verify rules the facilitator applies to a `voucher` and to the voucher on a `deposit`: `maxClaimableAmount >= Channel.settled + PaymentRequirements.amount` and `maxClaimableAmount > Channel.settled` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L71`), `maxClaimableAmount <= deposit` (`:L1627`), `expiresAt == 0` (`:L1619`-`L1620`), and in client mode `maxClaimableAmount == chargedCumulativeAmount + amount` (`:L1626`). These are the rules `nextWatermark` in task 3.1 encodes.

### 1.4 `SettlementResponse` and `VerifyResponse`

Core `SettlementResponse` (`specs/x402-specification-v2.md:L244`-`L253`):

| Field | Type | Required |
| --- | --- | --- |
| `success` | boolean | yes |
| `errorReason` | string | no |
| `errorMessage` | string | no |
| `payer` | string | no |
| `transaction` | string | yes, empty string when nothing was broadcast |
| `network` | string | yes |
| `amount` | string | no |
| `extensions` | object | no |

The SVM scheme nests its fields under `extra` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L684`-`L697`): `extra.commitmentId` (must be non-empty on voucher acceptance, e.g. `channelId:maxClaimableAmount`, `:L692`), `extra.chargedAmount` (required, `:L693`), `extra.channelState` (`:L694`), `extra.voucher` (server mode only, `:L695`). For voucher acceptance `transaction` is `""` and `amount` is empty (`:L689`, `:L691`, example `:L700`-`L725`). The generic scheme requires a non-empty commitment identifier on success (`specs/schemes/batch-settlement/scheme_batch_settlement.md:L21`). Reference type `BatchSettlementResponse` (`typescript/packages/mechanisms/svm/src/batch-settlement/types.ts:L392`-`L408`).

`ChannelState` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L473`-`L479`): `channelId`, `balance`, `totalClaimed`, `withdrawRequestedAt`, `chargedCumulativeAmount` (server-authored only). Wakeless keeps the shape; `balance` is the confirmed private deposit and `totalClaimed` the cumulative already redeemed to the vendor.

`VerifyResponse` (`specs/x402-specification-v2.md:L262`-`L269`): `isValid` (required), `invalidReason`, `invalidMessage`, `payer`, `extensions`, `extra`. The SVM scheme adds `extra.channelId`, `extra.balance`, `extra.totalClaimed`, `extra.withdrawRequestedAt` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L755`-`L763`).

`GET /supported` returns `kinds[]` of `{x402Version, scheme, network, extra?}`, `extensions[]` and `signers` (`specs/x402-specification-v2.md:L481`-`L494`); the SVM facilitator advertises `feePayer`, `transactionVersions`, `maxClaimChannels`, `maxSettleChannels`, `maxIdleSecs` and, for delegated closes, `receiverAuthorizer` in `kinds[].extra` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L1170`-`L1183`).

Deviation to record: the spec names `errorMessage` as optional on `SettlementResponse` (`specs/x402-specification-v2.md:L248`), and the SVM types carry it (`typescript/packages/mechanisms/svm/src/batch-settlement/types.ts:L399`), but the SVM scheme's own response table omits it (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L684`-`L695`). Wakeless follows the core spec and emits it.

### 1.5 Error codes reused verbatim

Clients match on the code, never on message text (`specs/x402-specification-v2.md:L595`). Core codes Wakeless reuses (`specs/x402-specification-v2.md:L597`-`L612`):

| Code | Cite |
| --- | --- |
| `insufficient_funds` | `:L597` |
| `invalid_network` | `:L603` |
| `invalid_payload` | `:L604` |
| `invalid_payment_requirements` | `:L605` |
| `invalid_scheme` | `:L606` |
| `unsupported_scheme` | `:L607` |
| `invalid_x402_version` | `:L608` |
| `invalid_transaction_state` | `:L609` |
| `unexpected_verify_error` | `:L610` |
| `unexpected_settle_error` | `:L611` |
| `settlement_pending` (non-terminal; must carry a non-empty `transaction`) | `:L612` |

The `invalid_exact_evm_*` codes (`:L598`-`L602`) belong to the `exact` scheme and are not reused.

Scheme codes, prefix `invalid_batch_settlement_svm_` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L1951`-`L2017`; constants in `typescript/packages/mechanisms/svm/src/batch-settlement/errors.ts:L3`-`L31`). The prefix stays `svm` because the binding is still SVM and a client that already maps these codes keeps working. Wakeless reuses the ones whose condition exists in its flow:

| Code | Cite | Wakeless condition |
| --- | --- | --- |
| `invalid_batch_settlement_svm_payload_type` | `:L1951` | `type` other than `deposit` or `voucher` for the operation |
| `invalid_batch_settlement_svm_payment_flow` | `:L1953` | `extra.paymentFlow` present and not `"authorization"` |
| `invalid_batch_settlement_svm_token_program` | `:L1955` | `extra.tokenProgram` does not own the mint |
| `invalid_batch_settlement_svm_voucher_signature` | `:L1957` | signature invalid or signer is not the channel's buyer key |
| `invalid_batch_settlement_svm_channel_id_mismatch` | `:L1959` | `channelId` is not the Wakeless derivation of section 4.3 |
| `invalid_batch_settlement_svm_withdraw_delay_mismatch` | `:L1983` | channel record disagrees with `extra.withdrawDelay` |
| `invalid_batch_settlement_svm_withdraw_delay_out_of_range` | `:L1985` | outside `900..=2592000` or below `maxTimeoutSeconds` |
| `invalid_batch_settlement_svm_cumulative_amount_mismatch` | `:L1987` | corrective 402: cumulative does not match the server's watermark |
| `invalid_batch_settlement_svm_cumulative_exceeds_deposit` | `:L1989` | voucher above the confirmed private deposit |
| `invalid_batch_settlement_svm_voucher_expiry` | `:L1991` | `expiresAt != 0` |
| `invalid_batch_settlement_svm_deposit_below_min_deposit` | `:L1997` | server-side minimum deposit policy |
| `invalid_batch_settlement_svm_channel_state` | `:L2000` | confirmed channel record does not match the payload |
| `invalid_batch_settlement_svm_channel_closing` | `:L1979` | channel marked closing, no new vouchers |
| `duplicate_settlement` | `:L2015` | same deposit signature or payload settled twice |

Reused since task 8.1: `invalid_batch_settlement_svm_close_authorization` (`:L1970`), for a `refund` payload whose `closeSignature` is not the buyer's over the close message (the condition the spec gives it, a close authorization that does not verify, exists again once the close is a signed message). Not reused, because their condition does not exist without the payment-channels program or without server mode: `fee_payer_mismatch` (`:L1961`), `receiver_authorizer_mismatch` (`:L1963`), `receiver_binding_unavailable` (`:L1965`), `delegated_unauthenticated` (`:L1967`), `close_amount_unsupported` (`:L1973`), `close_state` (`:L1976`), `setup_transaction` (`:L1993`), `settlement_simulation` (`:L1995`), `refund_transaction` (`:L2002`), `payout_attribution_ambiguous` (`:L2005`), `operation_ceiling_changed` (`:L2011`), and `unsupported_transaction_version` (`:L1321`).

New codes take the `shielded_` prefix (`CLAUDE.md`, Standards and specs): `shielded_binding_rejected` (a private call was refused and is never retried publicly), `shielded_attestation_failed` (the binding could not verify the TEE), both named in the plan for tasks 2.1 and 3.1, and `shielded_verify_required` (task 3.3: `/settle` of a voucher with no valid `/verify` of the same payload within `maxTimeoutSeconds`, the authorization flow of `specs/x402-specification-v2.md:L297` enforced rather than assumed).

A fourth, `shielded_rate_limited` (task 6.3), is the facilitator's HTTP 429: the caller's address or the channel the payload names is over a configurable limit; the body is `{error, code, retryable: true}` and the response carries `Retry-After` in seconds. The spec defines no rate-limit code; the same request is sent again unchanged after the wait (`docs/RECOVERY.md`).

A sixth, `shielded_unauthorized` (task 7.2), is the facilitator's HTTP 401 or 403 on its token-protected routes, `GET /receipts/:channelId` (vendor token) and `/admin/*` (admin token, loopback only). The spec's three endpoints carry no authentication and are unchanged; these routes are Wakeless additions (§4.5). `retryable: false`: the same request with the same token is refused again.

A fifth, `shielded_facilitator_unavailable` (task 4.2), is the vendor middleware's: a `402` with `retryable: true` and an empty `accepts[]` when the facilitator is unreachable, times out or answers 5xx. The spec defines no code for this; the briefing's failure table has it as a transport failure on which the server fails closed.

Error bodies (task 3.3). Every refused facilitator request carries `{error, code, retryable}`, `code` being one of the codes above. A verdict on the payment keeps the spec's shape (`{isValid: false, invalidReason, …}`, `{success: false, errorReason, …}`) with those three fields beside it and status 200; a malformed envelope is 400, an unattested binding 503, a facilitator fault 500 (`specs/transports-v2/http.md`, Error Handling). The core spec defines no error body for the facilitator endpoints beyond the two response shapes; the triple is a Wakeless addition recorded in `docs/DEVIATIONS.md`.

## 2. The `BatchVoucher` signed message

The signed message is exactly (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L402`-`L409`):

```text
0x56 0x01 || channelId || u64(maxClaimableAmount).le || i64(expiresAt).le
```

Byte layout, 50 bytes, from the reference encoder `encodeVoucherMessageBytes` (`typescript/packages/mechanisms/svm/src/payment-channels/voucher.ts:L30`, `:L41`-`L57`), which `encodeBatchVoucherMessage` wraps (`typescript/packages/mechanisms/svm/src/batch-settlement/codec.ts:L19`-`L30`):

| Offset | Length | Content | Encoding |
| ---: | ---: | --- | --- |
| 0 | 2 | magic `VOUCHER_MAGIC` | bytes `0x56`, `0x01` |
| 2 | 32 | `channelId` | base58-decoded, must be exactly 32 bytes |
| 34 | 8 | `maxClaimableAmount` (program `cumulative_amount`) | u64 little-endian |
| 42 | 8 | `expiresAt` (program `expires_at`) | i64 little-endian, fixed `0` |

Properties:

- **Domain.** There is no textual domain prefix; the two magic bytes are the domain separator and the program rejects a voucher without them (`typescript/packages/mechanisms/svm/src/payment-channels/voucher.ts:L25`-`L30`). The magic appears only in the signed bytes, never in wire JSON (`:L27`-`L29`).
- **Signature.** Ed25519 over the raw 50 bytes, by `channelConfig.payerAuthorizer`, carried base58 in `voucher.signature` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L400`). The client signs with `signMessages` on the raw bytes, no hashing (`typescript/packages/mechanisms/svm/src/payment-channels/voucher.ts:L69`-`L79`).
- **Expiry.** `expiresAt` must be `0`; the field stays in the message for program compatibility and the forced-close grace period alone bounds redemption (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L399`, `:L1619`-`L1624`). A nonzero value is `invalid_batch_settlement_svm_voucher_expiry` (`:L1991`).
- **Monotonic.** Each voucher is the new cumulative total for the channel, not a delta (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L398`, Phase 2 `:L1562`-`L1564`).
- **Amount bound.** `maxClaimableAmount` must parse as a u64 (`typescript/packages/mechanisms/svm/src/batch-settlement/codec.ts:L27`); `expiresAt` must be a safe integer (`:L22`-`L24`).

Wakeless v1 keeps these 50 bytes unchanged and verifies them off-chain only; the voucher is never placed on-chain, so the cumulative amount is never public (briefing §3, "Voucher: what stays standard and what cannot"). The one field whose *derivation* changes is `channelId` (section 4.3); its encoding in the message (32 bytes at offset 2) does not change.

For completeness, two other signed messages exist in the scheme and Wakeless v1 does not use either: the server-mode `BatchAuthorization`, domain `x402-batch-authorization-v2` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L423`-`L433`; `typescript/packages/mechanisms/svm/src/batch-settlement/authorization.ts:L26`-`L70`), and the `CloseAuthorization` SHA-256 digest, domain `x402:batch-settlement:svm:close:v1`, which commits to the program id (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L451`-`L469`; `typescript/packages/mechanisms/svm/src/batch-settlement/closeAuthorization.ts:L54`-`L95`).

## 3. Every place the SVM binding names the payment-channels program

These are the places Wakeless must differ. The rule that forces a new scheme id comes first, then the spec text, then the code.

### 3.1 The rule

The canonical program id is a network/SDK constant, not a wire field; for mainnet it is `CHNLxYvVA28MJP9PrFuDXccuoGXAx7jBacfLEkahyGsX` (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L82`-`L87`). Implementations MUST target it for the selected `network` and MUST NOT trust or negotiate a `channelProgram` from `extra` (`:L89`-`L91`). The scheme defines a single method, so there is no `extra.assetTransferMethod` to select another backing (`:L78`-`L80`). A PER-based escrow is a different program, so Wakeless cannot advertise `scheme: "batch-settlement"` on `solana:*` and registers `batch-settlement-shielded` instead (briefing §3, "Scheme identifier").

### 3.2 In the spec

| # | Where | What names the program | Cite |
| --- | --- | --- | --- |
| S1 | §1 Purpose | Scheme is "backed by the payment-channels program, the same program used by SVM `upto`" | `specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L19`-`L24` |
| S2 | §1 role map | `payer`, `authorized_signer`, `payee`, `rent_payer` are channel account fields | `:L25`-`L41` |
| S3 | §2 mapping table | `open`, `settle`, `distribute`, `distribution_hash`, `settled < maxClaimableAmount <= deposit` | `:L67`-`L74` |
| S4 | §3 lifecycle | `open`, `settle`, `distribute`, `settle_and_seal`, sealed `distribute`, `reclaim` | `:L94`-`L111` |
| S5 | §3 binding Memo | Open transaction carries a Memo `x402:batch-settlement:svm:rcvauth:v1:<key>` | `:L122`-`L128` |
| S6 | §4.1 | Program fields derived from the wire: `rent_payer`, `payee`, `authorized_signer`, `grace_period`, `recipients` | `:L276`-`L284` |
| S7 | §4.2 mapping table | Wire name to `Channel.*` and `VoucherArgs.*` program notation | `:L323`-`L343` |
| S8 | §4.2 `channelId` | `find_program_address([...], CANONICAL_PAYMENT_CHANNELS_PROGRAM_ID)` over seeds `"channel"`, `payer`, `feePayer`, `token`, `payerAuthorizer`, `salt`, `openSlot` | `:L363`-`L378` |
| S9 | §4.2 `open` encoding | Required `open` instruction fields | `:L380`-`L391` |
| S10 | §4.2 `CloseAuthorization` | Digest commits to `programId[32]`, "the canonical payment-channels program id for that network" | `:L456`, `:L464`-`L469` |
| S11 | §4.3 `deposit` | `deposit.transaction` is a client-signed `open` or `top_up` | `:L498` |
| S12 | §4.3 `refund` | `transaction` is a payer-signed `request_close` | `:L639` |
| S13 | §4.5 settle table | Wire `type` to program instruction: `open`/`top_up`, `settle`, `distribute`, `settle_and_seal` | `:L790`-`L798` |
| S14 | §4.5 refund, claim, settle, seal | Ed25519 precompile + `settle_and_seal`; precompile + `settle`; `distribute` per channel | `:L878`-`L888`, `:L957`-`L959`, `:L1001`-`L1004`, `:L1044`-`L1058` |
| S15 | Phase 1 | `open` field assignments; sponsor signs as `rent_payer` | `:L1281`-`L1298` |
| S16 | Phase 1 instruction layout | "Exactly one canonical payment-channels `open` or `top_up` instruction" | `:L1402`-`L1403` |
| S17 | Phase 1 canonical `open` | Discriminator `1`, 14 accounts, account 12 `event_authority` and account 13 `self_program` are the program | `:L1447`-`L1466` |
| S18 | Phase 1 canonical `top_up` | Discriminator `3`, 6 accounts | `:L1477`-`L1488` |
| S19 | Phase 1 canonical `request_close` | Discriminator `5`, 2 accounts | `:L1529`-`L1542` |
| S20 | Phase 3 step 2 | "Confirm `channelId` matches the PDA derived from `channelConfig` and the canonical payment-channels program id" | `:L1601`-`L1602` |
| S21 | Phase 3 step 3 | Channel account fields checked against the wire | `:L1603`-`L1610` |
| S22 | Phase 4 | Claim, settle, seal, refund, rent cleanup as program instructions | `:L1687`-`L1707` |
| S23 | Phase 4 capacity table | Per-instruction byte costs | `:L1747`-`L1753` |
| S24 | §6.1 discovery | `getProgramAccounts` against the canonical program, 256-byte account, offsets 88, 120, 152, 216; PDA rederived before accepting | `:L1857`-`L1894` |
| S25 | §8 security | `distribution_hash`, `settle`, `Channel.rent_payer`, `Channel.payee`, `Channel.authorized_signer` | `:L2021`-`L2022`, `:L2058`-`L2066`, `:L2073`-`L2078` |

### 3.3 In the code

The constant is `PAYMENT_CHANNELS_PROGRAM_ID` (`typescript/packages/mechanisms/svm/src/payment-channels/onchain.ts:L55`-`L57`), with the treasury owner baked into the program binary beside it (`:L59`-`L86`). Every batch-settlement file that reaches it:

| # | File | Use | Cite |
| --- | --- | --- | --- |
| C1 | `batch-settlement/codec.ts` | `deriveBatchChannelId` calls `findPaymentChannelPda` with an optional `programId` override | `typescript/packages/mechanisms/svm/src/batch-settlement/codec.ts:L43`-`L57` |
| C2 | `payment-channels/open.ts` | `findPaymentChannelPda` defaults to the constant and hashes the seeds of S8 | `typescript/packages/mechanisms/svm/src/payment-channels/open.ts:L355`-`L373` |
| C3 | `batch-settlement/closeAuthorization.ts` | Close digest commits to the program id, defaulting to the constant | `typescript/packages/mechanisms/svm/src/batch-settlement/closeAuthorization.ts:L18`, `:L37`-`L38`, `:L60`-`L64` |
| C4 | `batch-settlement/receiverBinding.ts` | Finds the `open` by program id and `OPEN_DISCRIMINATOR` when reading the binding Memo | `typescript/packages/mechanisms/svm/src/batch-settlement/receiverBinding.ts:L16`-`L17`, `:L73`-`L76` |
| C5 | `batch-settlement/server/channelManager.ts` | Rejects a channel account whose owner is not the program | `typescript/packages/mechanisms/svm/src/batch-settlement/server/channelManager.ts:L12`, `:L556`-`L557` |
| C6 | `batch-settlement/server/scheme.ts` | `verifyOpenTransaction` and `findPaymentChannelPda` on deposit and on every request | `typescript/packages/mechanisms/svm/src/batch-settlement/server/scheme.ts:L554`, `:L1078` |
| C7 | `batch-settlement/facilitator/scheme.ts` | `buildSettleInstructions` (claim), `verifyTopUpTransaction`, `verifyOpenTransaction`, `findPaymentChannelPda`, `buildDistributeInstruction` (settle) | `typescript/packages/mechanisms/svm/src/batch-settlement/facilitator/scheme.ts:L476`, `:L834`, `:L870`, `:L1279`, `:L1870` |
| C8 | `batch-settlement/facilitator/seal.ts` | Imports the program builders and `verifyRequestCloseTransaction` for refund and seal | `typescript/packages/mechanisms/svm/src/batch-settlement/facilitator/seal.ts:L23`-`L32` |
| C9 | `batch-settlement/client/channel.ts` | `buildOpenPaymentChannelTransaction`, `buildRequestCloseTransaction` | `typescript/packages/mechanisms/svm/src/batch-settlement/client/channel.ts:L11`-`L12` |
| C10 | `batch-settlement/client/builders.ts`, `client/scheme.ts` | `buildTopUpPaymentChannelTransaction`; `getProgramAccounts(programId)` discovery by payer | `typescript/packages/mechanisms/svm/src/batch-settlement/client/builders.ts:L13`; `typescript/packages/mechanisms/svm/src/batch-settlement/client/scheme.ts:L571`-`L573` |
| C11 | `payment-channels/discovery.ts` | `discoverChannels` defaults to the constant and validates owner and PDA | `typescript/packages/mechanisms/svm/src/payment-channels/discovery.ts:L85`-`L90` |
| C12 | `payment-channels/onchain.ts` | `buildSettleAndSealInstructions`, `buildSettleInstructions`, `buildDistributeInstruction`, `buildReclaimInstruction` all default to the constant | `typescript/packages/mechanisms/svm/src/payment-channels/onchain.ts:L188`, `:L275`, `:L338`, `:L415` |
| C13 | `payment-channels/open.ts` | `buildTopUpPaymentChannelTransaction`, `buildOpenPaymentChannelTransaction`, `verifyTopUpTransaction`, `verifyOpenTransaction` default to the constant | `typescript/packages/mechanisms/svm/src/payment-channels/open.ts:L240`, `:L413`, `:L665`, `:L800` |
| C14 | `payment-channels/close.ts` | `buildRequestCloseTransaction`, `verifyRequestCloseTransaction` default to the constant | `typescript/packages/mechanisms/svm/src/payment-channels/close.ts:L88`, `:L202` |
| C15 | `batch-settlement/README.md` | States the canonical program id | `typescript/packages/mechanisms/svm/src/batch-settlement/README.md:L14`, `:L251`-`L258` |

Every builder takes an optional `programId` override (C1, C2, C12 to C14), but the spec forbids negotiating one (section 3.1) and the override would still produce payment-channels instructions. That is why the Wakeless difference is a scheme id and a binding, not a program id parameter.

### 3.4 What Wakeless puts in each place

| Spec place | Wakeless |
| --- | --- |
| S1, S3, S4, S13, S14, S22 (program instructions) | No program. Escrow is a keypair held by the facilitator with a private ephemeral balance in the MagicBlock PER; a deposit, a redemption and a refund are each one private transfer built by the Private Payments API and reached only through `SettlementBinding` (briefing §3). Claim and settle collapse into one private transfer escrow to vendor per channel per period. |
| S2, S6, S7, S21 (channel account fields) | A facilitator-held channel record `{buyer, vendor, mint, salt, deposit, settled, chargedCumulativeAmount, withdrawDelay}`; nothing on-chain names it. |
| S5 (binding Memo) | None. A Memo on any Wakeless signature fails the watcher (`CLAUDE.md`, Privacy rules). |
| S8, S20, S24 (PDA and discovery) | `channelId = base58(sha256(buyer, escrowAddress, mint, salt))`; `clientRefId = decimal(u64 of the first 8 bytes)`. There is no program account to discover; the client keeps local channel state (plan tasks 3.1 and 5.1). |
| S9, S11, S15 to S18 (client-built `open`/`top_up`) | `deposit.transaction` is replaced by `depositSignature`, the signature of the buyer's private transfer to the escrow with `clientRefId`; the facilitator confirms it with `binding.readDeposit` (plan task 4.1). |
| S10, S12, S19 (close) | No `CloseAuthorization` digest and no `request_close` instruction. The `refund` payload carries a buyer-signed close message instead (§4.3, task 8.1); close is a private transfer of `deposit - settled` back to the buyer after the grace period. |
| S23 (capacity) | Not applicable; one transfer per channel per period. |
| S25 (security properties) | Restated for the trust boundary: facilitator, MagicBlock's enclave and NEAR's private shard see inside; the public ledger does not (`CLAUDE.md`, Privacy rules). |

## 4. The `batch-settlement-shielded` accept

### 4.1 Entry

One entry in `accepts[]`. A server may list a plain `batch-settlement` entry beside it for clients without the Wakeless wrapper (briefing §3, x402 mapping table); nothing in this entry may advertise `batch-settlement` for a shielded channel (`CLAUDE.md`, Standards and specs).

```json
{
  "scheme": "batch-settlement-shielded",
  "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
  "amount": "1000",
  "asset": "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU",
  "payTo": "<vendor base58>",
  "maxTimeoutSeconds": 60,
  "extra": {
    "paymentFlow": "authorization",
    "voucherSigner": "client",
    "withdrawDelay": 3600,
    "tokenProgram": "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA",
    "minDeposit": "100000",
    "maxIdleSecs": 604800,
    "escrowAddress": "<escrow base58>",
    "binding": "magicblock",
    "teeValidator": "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
    "privacyFeeBps": 10
  }
}
```

The devnet values above are the spike's (`docs/spike-log.md`): the USDC devnet mint and the TEE validator identity verified in `docs/attestation-devnet.json`. Mainnet values are a human decision after Gate D.

### 4.2 Fields

Top-level fields are the core ones unchanged (`specs/x402-specification-v2.md:L122`-`L130`), with the SVM constraints on `asset` (a concrete mint) and `amount` (per-request atomic units) kept (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L232`-`L233`). `scheme` is the one top-level change.

`extra` keys kept from the SVM scheme, with the same semantics:

| Key | Required | Cite | Note |
| --- | --- | --- | --- |
| `paymentFlow` | no | `specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L242` | When present, must be `"authorization"`. Omitted or explicit, never another flow. |
| `voucherSigner` | no | `:L245` | Always `"client"`. A `"server"` value is rejected with `invalid_batch_settlement_svm_payload_type`; there is no `operator`. |
| `withdrawDelay` | yes | `:L247` | Same range and `>= maxTimeoutSeconds` rule. It bounds the time a buyer waits for a refund of `deposit - settled` after asking to close. |
| `tokenProgram` | yes | `:L248` | The client verifies it against the mint owner, as the spec requires. |
| `minDeposit` | no | `:L252` | Deposit target, `>= amount`. The relationship-terms layer (if Gate T passes) varies it per buyer; the client already honours it. |
| `maxIdleSecs` | no | `:L253` | Copied from `/supported`. The facilitator may close an idle channel at its watermark and refund the rest privately. |
| `channelState`, `voucherState` | no | `:L257`-`L258`, `:L1216`-`L1269` | Corrective 402 only, same shapes. |

The corrective 402 (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L1216`-`L1269`) is answered by the vendor on two `/verify` verdicts: `invalid_batch_settlement_svm_cumulative_amount_mismatch`, as the spec says, and `invalid_batch_settlement_svm_cumulative_exceeds_deposit`, which the spec leaves to the server and the briefing's failure table (row 1) makes corrective so the buyer learns the target. The facilitator, which holds the channel, puts the snapshot in the verdict's `extra` (`channelState` with `chargedCumulativeAmount`; `voucherState` as `{signedMaxClaimable, expiresAt, signature}` once a voucher was accepted), and the vendor copies it onto the shielded entry, as the EVM scheme has a managed `/verify` do (`specs/schemes/batch-settlement/scheme_batch_settlement_evm.md:L422`). Above the deposit the entry's `minDeposit` is the route's target or the shortfall (`maxClaimableAmount - balance`), whichever is larger. The buyer verifies `voucherState.signature` as its own before adopting the watermark, as `:L1259`-`:L1266` require, and may echo the corrective entry as `accepted`: the vendor matches `accepted` on the terms, ignoring `minDeposit`, `channelState` and `voucherState`, and forwards its own entry.

`extra` keys added:

| Key | Type | Required | Meaning |
| --- | --- | --- | --- |
| `escrowAddress` | string, base58 | yes | The escrow keypair's public key. Its USDC balance lives in the PER as a private ephemeral balance; the buyer's deposit is a private transfer to it. One of the `channelId` inputs (4.3). |
| `binding` | string | yes | `"magicblock"` in v1. v2 adds `"rings"` and `"privacycash"`. Tells the client which private-transfer rail to build the deposit on; a client that does not implement the binding skips the entry, as the core spec says of an unknown `paymentFlow` (`specs/x402-specification-v2.md:L291`). |
| `teeValidator` | string, base58 | yes | The TEE validator identity. The client verifies it with `verifyTeeRpcIntegrity` once per session before its first deposit and refuses the entry when attestation fails (plan task 5.1). The facilitator takes it from the binding, which attested at construction. |
| `privacyFeeBps` | number | yes | Facilitator fee in basis points, `10` in v1. The client adds the fee share to `maxClaimableAmount` so the vendor nets `amount`. This is the one place the scheme departs from "any facilitator fee is outside this wire contract" (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L286`-`L287`): the fee has to be in the voucher because the cumulative is the only number that moves. |

`extra` keys dropped, and why each has no meaning without the payment-channels program: `feePayer` (`:L243`, no rent and no sponsor; the buyer's deposit is gasless or fee-paid by the buyer through the Payments API), `receiverAuthorizer` (`:L244`, no cooperative close signature in v1), `operator` (`:L246`), `memo` (`:L249`), `recentBlockhash` and `recentSlot` (`:L250`-`L251`, no client-built transaction), `transactionVersions` (`:L254`), `maxClaimChannels` and `maxSettleChannels` (`:L255`-`L256`, one transfer per channel per period). A Wakeless accept carrying any of them is a server bug, not a client error; the client ignores unknown keys.

### 4.3 The payload variants against this entry

`ChannelConfig` reduces to what the record needs: `buyer` (the voucher signer, replacing both `payer` and `payerAuthorizer`, since client mode makes them the same key), `vendor` (must equal `payTo`), `mint` (must equal `asset`), `salt` (decimal u64), `withdrawDelay` (must equal `extra.withdrawDelay`). `receiver`, `receiverAuthorizer`, `openSlot` and `voucherSigner` are gone; the spec's `openSlot` existed only as a PDA seed (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L356`).

`channelId` replaces the PDA (S8): `base58(sha256(buyer || escrowAddress || mint || u64(salt).le))`, 32 bytes, so it fits the voucher message at offset 2 unchanged. `clientRefId` is the decimal string of the first 8 bytes read as a little-endian u64; it is the encrypted reference field of the binding's private transfers and never a Memo. The derivation is pure and the facilitator recomputes it on every request, which gives `invalid_batch_settlement_svm_channel_id_mismatch` its Wakeless meaning.

`deposit`: `{type: "deposit", channelConfig, depositSignature, deposit: {amount, transaction}, voucher}`. The buyer first makes the private transfer itself: built by the Private Payments API with visibility `private` and `toBalance` `ephemeral`, from the buyer's private balance to `escrowAddress`, with `clientRefId = clientRefOf(channelId)`, signed by the buyer and submitted to the attested TEE RPC (`@wakeless/client` `deposit()`). `depositSignature` is that transfer's signature and `deposit.transaction` the same client-signed transaction in base64 wire format: the enclave returns neither sender, amount nor reference for an ephemeral signature (task 2.1, `docs/DEVIATIONS.md`), so the binding decodes these bytes to check that the buyer signed, that one SPL transfer pays the escrow's token account exactly `deposit.amount`, and that no Memo is present, then that the signature landed with `err: null` and the escrow's private balance grew. The facilitator never co-signs or broadcasts anything. On a match it records the channel with `deposit = amount` (a top-up adds to the existing channel's deposit) and accepts the voucher. A reused `depositSignature` is `duplicate_settlement`; a transfer the binding cannot confirm is `invalid_transaction_state`; a deposit for a channel recorded under another buyer, vendor or mint is `invalid_batch_settlement_svm_channel_state`.

`voucher`: unchanged from the spec (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L545`-`L552`).

`SettlementResponse` for a voucher: `{success: true, transaction: "", network, payer, extra: {commitmentId: "<channelId>:<watermark>", chargedAmount, channelState}}`, which is the spec's voucher-only response (`:L700`-`L725`). For a deposit, `transaction` carries the deposit signature and `amount` the confirmed deposit (`:L1115`-`L1136`). The facilitator-signed off-chain receipt that the briefing names is `SettlementReceipt` (`packages/scheme`, §4.5): it is produced by the redemption worker once per channel period, served by `GET /receipts/:channelId`, and may travel under `extra.receipt` of a later `SettlementResponse`; with `clientRefId` it is the only other place receipt data goes (`CLAUDE.md`, Privacy rules).

### 4.4 `/supported`

```json
{
  "kinds": [
    {
      "x402Version": 2,
      "scheme": "batch-settlement-shielded",
      "network": "solana:EtWTRABZaYq6iMfeYKouRu166VU2xqa1",
      "extra": {
        "escrowAddress": "<escrow base58>",
        "binding": "magicblock",
        "teeValidator": "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo",
        "privacyFeeBps": 10,
        "maxIdleSecs": 604800
      }
    }
  ],
  "extensions": [],
  "signers": { "solana:*": ["<facilitator receipt signer base58>"] }
}
```

Shape per `specs/x402-specification-v2.md:L481`-`L494`. The server copies `escrowAddress`, `binding`, `teeValidator`, `privacyFeeBps` and `maxIdleSecs` into its accept, the way the SVM server copies `feePayer` and the capacities (`specs/schemes/batch-settlement/scheme_batch_settlement_svm.md:L1178`-`L1183`). If the binding failed attestation, `kinds` is empty and `extra.error` is `shielded_attestation_failed` (plan task 4.3). With no kind to hang it on, that `extra` is a top-level field of the response, `{kinds: [], extensions: [], signers: {}, extra: {error}}`; the spec's `SupportedResponse` has no top-level `extra` (`specs/x402-specification-v2.md:L481`-`L494`), so this is a Wakeless addition (`docs/DEVIATIONS.md`, task 3.3). `signers["solana:*"]` is the receipt signer's public key (task 7.2), the key every receipt of §4.5 verifies against; the spec gives `signers` to the facilitator's transaction signers, and Wakeless has none, since no facilitator-signed transaction exists.

### 4.5 Redemption and receipts (task 7.2)

The SVM scheme's claim and settle instructions (S13, S14) collapse into one private transfer escrow → vendor per channel per period, made by the facilitator's redemption worker through `binding.settle` every `REDEEM_INTERVAL` (60 s in the demo, 3600 s in production) or on `POST /admin/redeem`. For an open channel with `accepted > settled`, `owed = accepted − settled` and the vendor receives `amount = owed − ⌊owed × privacyFeeBps / 10000⌋`; the fee stays in the escrow. One transfer per channel per run, the binding choosing split and delay; `settled` moves to the period's cumulative on confirmation. A rail refusal (`shielded_binding_rejected`) is terminal for that period and the channel is not redeemed again by the worker; nothing is retried as a public transfer.

`SettlementReceipt` is `{channelId, period, cumulative, amount, signature, facilitatorSignature}`: the channel id (base58), the period (1-based), the channel's settled watermark after the period (gross, decimal u64), what the vendor received (net, decimal u64), the private transfer's signature (base58, 64 bytes) and the facilitator's Ed25519 signature over the 122-byte message

```
0x52 0x01 || channelId (32) || u64(period).le || u64(cumulative).le || u64(amount).le || signature (64)
```

The magic bytes are the domain separator, distinct from the voucher's `0x56 0x01`, so neither message verifies as the other. `signReceipt` and `verifyReceipt` live in `packages/scheme`; the public key is `/supported` `signers["solana:*"][0]`. The vendor fetches its receipts from `GET /receipts/:channelId` with its bearer token (`FACILITATOR_RECEIPT_TOKENS`) and answers `{channelId, signer, receipts}`; a channel that is not that vendor's is 404 whatever its state. The receipt is the vendor's evidence of payment beside its private-balance delta, since the rail exposes no reference to the recipient (§4.3). It is never logged, never written to chain and never in a Memo.

Supersedes task 3.1's `{channelId, cumulative, period, signature}` shape, in which `signature` was the facilitator's (`docs/DEVIATIONS.md`, 7.2): the worker has the transfer signature, the vendor needs it to match its balance movement, and a receipt that binds the facilitator to one transfer is the stronger document.
