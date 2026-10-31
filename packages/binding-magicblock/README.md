# @wakeless/binding-magicblock

Status: devnet alpha, unaudited

`SettlementBinding` over MagicBlock's Private Payments API and the devnet Private Ephemeral Rollup (PER), with exactly the calls `scripts/spike-magicblock.ts` proved on 31 Oct 2026. The escrow is a keypair whose private USDC balance lives inside the rollup; every transfer the binding makes is a private, ephemeral-to-ephemeral transfer built by the API, signed locally and submitted to the attested TEE RPC.

```ts
import { createKeyPairFromBytes } from "@solana/kit";
import { DEVNET_CAIP2 } from "@wakeless/binding";
import { MagicBlockBinding } from "@wakeless/binding-magicblock";

const binding = await MagicBlockBinding.create({
  network: DEVNET_CAIP2,
  baseRpcUrl: process.env.SOLANA_RPC_URL!,          // Helius devnet
  teeRpcUrl: "https://devnet-tee.magicblock.app",
  paymentsApiUrl: "https://payments.magicblock.app",
  mint: usdcMint,
  escrow: await createKeyPairFromBytes(bytes),
  attestationReportPath: "docs/attestation-devnet.json",
});
```

## What construction does

1. Refuses anything but devnet: the CAIP-2 id, the base RPC hostname, the TEE host (`devnet-tee.magicblock.app` over https). Mainnet is a human decision after Gate D.
2. Verifies TEE attestation with the kit's `verifyTeeRpcIntegrity`. On failure it throws `shielded_attestation_failed` and nothing else runs. The report (`binding.attestation`) names the validator identity, the verifier package and version, the collateral URL and the time; `attestationReportPath` writes it, verified or not.
3. Asserts the base RPC's genesis hash is the cluster the CAIP-2 id names.
4. Logs the escrow in twice: at the TEE RPC (`getAuthToken`, needed to submit and read inside the rollup) and at the Payments API (`/v1/spl/challenge` + `/v1/spl/login`, needed for private reads and builds); the two tokens differ. Uses `cluster: "devnet-private"`, which routes to the TEE validator; plain `devnet` is the public validator.
5. Reads the escrow's token account and opening private balance.

## Calls

| Method | API and rollup calls | Notes |
| --- | --- | --- |
| `readDeposit(sig, ref)` | TEE `getTransaction`; `GET /v1/spl/private-balance` | The enclave returns only existence and success for an ephemeral signature (no accounts, no amounts, no `clientRefId`), so the buyer and the amount are verified from the client-signed transaction in `ref.transaction`: the signature must match `sig`, the buyer must have signed, an SPL transfer must pay the escrow's token account the exact amount, and no Memo instruction may be present. Then the transfer must have landed with `err: null`, and the escrow's private balance must have grown by at least the amount since the last attribution. Each signature is credited once. The `clientRefId` itself cannot be checked against the chain; it is the facilitator's bookkeeping |
| `settle(to, amount, ref)` | `POST /v1/spl/transfer` (private, ephemeral → ephemeral, `clientRefId` = period); TEE `sendTransaction`, `getTransaction` | `minDelayMs`/`maxDelayMs` are two points drawn inside the configured window (default 30 s to 5 min); `split` is 1 under 2 USDC, one per whole USDC above, capped at 5. On the ephemeral → ephemeral route these shape nothing today (the transfer executes at once); they are sent so the queued route, when it applies, is shaped. Returns the `Receipt` |
| `refund(to, amount, ref)` | Same private transfer, no shaping | Deposit minus settled, back to the buyer's private balance |
| `privateBalance()` | `GET /v1/spl/private-balance` | Base units as `bigint` |
| `observe(sig)` | Base RPC `getTransaction` (`jsonParsed`) | Program ids, signers, plaintext token amounts and recipients, Memo text, system transfers. A signature that executed inside the rollup is not on the base layer: `onBaseLayer: false`, all lists empty |

The binding never sets the API's `memo` field; the contract test asserts it on every request and decodes every submitted transaction. Receipt data goes in `clientRefId` and in the off-chain `Receipt`.

## Failures

| What happened | Thrown | Retry |
| --- | --- | --- |
| `verifyTeeRpcIntegrity` fails or returns false | `BindingError` `shielded_attestation_failed` | no; the binding does not exist |
| API answers `UNSUPPORTED_TRANSFER_ROUTE`, HTTP 403, or a screening/rejection code | `BindingError` `shielded_binding_rejected` (`apiCode` carries the API's code) | never, and never as a public transfer |
| TEE RPC refuses `sendTransaction` (ingress screening) | `BindingError` `shielded_binding_rejected` (`apiCode: "TEE_INGRESS"`) | never |
| Builder answers `sendTo: "base"` or an ephemeral endpoint other than the attested TEE | `BindingError` `shielded_binding_rejected` (`SEND_TO_BASE`, `UNATTESTED_ENDPOINT`) before anything is signed | never |
| Transfer submitted but not readable in time | `UnconfirmedTransferError` with the signature | the caller keeps the amount owed and looks again; maps to `settlement_pending` |
| Transfer landed with an error inside the rollup | `Error` naming the signature | the amount stays owed |
| Any other API error | `ApiError` with status, code and message | caller's decision |
| A response that does not match the recorded shape | `MalformedResponseError` | no |

Error messages never carry tokens, keys or the base RPC URL (it holds the API key). Amounts appear in no message.

## Trust boundary

The privacy claim is against the public ledger. Three operators see inside: the facilitator (vouchers, this escrow's key), MagicBlock's enclave (private transfers, Intel TDX attestation, ingress screening by policy) and, for channels funded through Aurora Confidential Intents, NEAR's private shard (origin and route). MagicBlock's own documentation says private transfers reduce linkability, not observability: vault deposits and withdrawals are base-layer transactions, and a recipient's first private payment needs a delegated token account it creates with a deposit of its own.

## Testing

`pnpm test` runs the contract test over a fake transport that answers like the API and the TEE did on devnet (recorded in `docs/spike-log.md`) and fuzzes every parser of external input with fast-check. `pnpm test:devnet` constructs the real binding against the devnet TEE and reads the escrow's private balance; it needs `.env`.
