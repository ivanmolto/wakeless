import { Hono, type Context } from "hono";
import {
  SCHEME_ERROR_CODES,
  SCHEME_ID,
  X402_VERSION,
  isSchemeErrorCode,
  type ChannelState,
  type SchemeErrorCode,
  type SettlementResponse,
  type SupportedResponse,
  type VerifyResponse,
} from "@wakeless/scheme";
import { KeyedMutex } from "../stores/keyed-mutex.js";
import type { ChannelRecord, Stores } from "../stores/types.js";
import type { BindingState } from "./binding-state.js";
import type { DepositHandler } from "./deposit-handler.js";
import { HttpError, Rejection, errorBody, isRetryable, type ErrorBody } from "./errors.js";
import { parsePayload, parseRequest, type FacilitatorRequest } from "./request.js";
import { SettledResults, VerifiedSet, type Clock } from "./short-lived.js";
import { applyVoucher, checkDeposit, checkVoucher } from "./validate.js";

export const DEFAULT_PRIVACY_FEE_BPS = 10;
/** Seven days, as `docs/SCHEME.md` §4.4 advertises. */
export const DEFAULT_MAX_IDLE_SECS = 604_800;
/** How long a settled result answers replays. */
export const DEFAULT_SETTLED_TTL_SECS = 86_400;

export interface FacilitatorOptions {
  readonly binding: BindingState;
  readonly stores: Stores;
  readonly privacyFeeBps?: number;
  readonly maxIdleSecs?: number;
  /** `signers["solana:*"]`: the facilitator's receipt signer, once there is one. */
  readonly receiptSigners?: readonly string[];
  readonly deposits?: DepositHandler;
  /** Unix seconds. Tests inject it. */
  readonly now?: Clock;
  readonly settledTtlSeconds?: number;
  /** One line per request: method, path, status, code, payload hash. Never a payload field. */
  readonly log?: (line: string) => void;
}

type VerifyVerdict = VerifyResponse & Partial<ErrorBody>;
type SettleVerdict = SettlementResponse & Partial<ErrorBody>;

/**
 * The facilitator's HTTP surface: `GET /supported`, `POST /verify`, `POST /settle`
 * (`specs/x402-specification-v2.md` §7). `/verify` reads and never writes payment
 * state; `/settle` of a voucher moves the channel's watermark atomically through
 * the store, requires a `/verify` of the same payload within `maxTimeoutSeconds`
 * (the authorization flow), and answers a repeated identical payload with the
 * stored result and `extra.replayed: true`.
 *
 * Status codes (`specs/transports-v2/http.md`): a verdict on a payment is 200
 * with the spec's own shape (`isValid: false` / `success: false`) plus
 * `{error, code, retryable}` beside it; a malformed envelope is 400 with
 * `{error, code, retryable}` alone; a facilitator fault is 500.
 */
export function createFacilitatorApp(options: FacilitatorOptions): Hono {
  const now = options.now ?? (() => Math.floor(Date.now() / 1000));
  const log = options.log ?? (() => undefined);
  const verified = new VerifiedSet(now);
  const settled = new SettledResults(options.settledTtlSeconds ?? DEFAULT_SETTLED_TTL_SECS, now);
  const settling = new KeyedMutex();
  const { stores } = options;

  const app = new Hono();

  app.get("/supported", (c) => {
    const { binding } = options;
    if (binding.status !== "ready") {
      const body: SupportedResponse & { extra: { error: SchemeErrorCode } } = {
        kinds: [],
        extensions: [],
        signers: {},
        extra: { error: SCHEME_ERROR_CODES.shieldedAttestationFailed },
      };
      log(`GET /supported 200 ${SCHEME_ERROR_CODES.shieldedAttestationFailed}`);
      return c.json(body, 200);
    }
    const body: SupportedResponse = {
      kinds: [
        {
          x402Version: X402_VERSION,
          scheme: SCHEME_ID,
          network: binding.binding.network(),
          extra: {
            escrowAddress: binding.binding.escrowAddress(),
            binding: binding.binding.id,
            teeValidator: binding.teeValidator,
            privacyFeeBps: options.privacyFeeBps ?? DEFAULT_PRIVACY_FEE_BPS,
            maxIdleSecs: options.maxIdleSecs ?? DEFAULT_MAX_IDLE_SECS,
          },
        },
      ],
      extensions: [],
      signers: { "solana:*": [...(options.receiptSigners ?? [])] },
    };
    log("GET /supported 200");
    return c.json(body, 200);
  });

  /** The envelope, or a 400/503 as `HttpError`. */
  async function readRequest(c: Context): Promise<{ request: FacilitatorRequest; network: string }> {
    const { binding } = options;
    if (binding.status !== "ready") {
      throw new HttpError(503, SCHEME_ERROR_CODES.shieldedAttestationFailed, "the binding failed TEE attestation; this facilitator settles nothing");
    }
    let body: unknown;
    try {
      body = await c.req.json();
    } catch {
      throw new HttpError(400, SCHEME_ERROR_CODES.invalidPayload, "request body must be JSON");
    }
    const network = binding.binding.network();
    return { request: parseRequest(body, { network, escrowAddress: binding.binding.escrowAddress() }), network };
  }

  app.post("/verify", async (c) => {
    const { request } = await readRequest(c);
    const { paymentRequirements: requirements, hash } = request;
    const invalid = (rejection: Rejection): Response => {
      // A corrective verdict carries the channel as stored and the buyer's own last voucher,
      // for the seller to copy onto the corrective 402 (`docs/SCHEME.md` §4.2).
      const { corrective } = rejection;
      const body: VerifyVerdict = {
        isValid: false,
        invalidReason: rejection.code,
        invalidMessage: rejection.message,
        ...(rejection.payer !== undefined ? { payer: rejection.payer } : {}),
        ...(corrective === undefined ? {} : { extra: { ...corrective.channelState, ...(corrective.voucherState === undefined ? {} : { voucherState: corrective.voucherState }) } }),
        ...errorBody(rejection.code, rejection.message),
      };
      log(`POST /verify 200 ${rejection.code} ${hash}`);
      return c.json(body, 200);
    };

    const payload = parsePayload(request.paymentPayload.payload, requirements);
    if (payload instanceof Rejection) return invalid(payload);

    if (payload.type === "voucher") {
      const verdict = await checkVoucher(payload, requirements, stores.channels, now());
      if (verdict instanceof Rejection) return invalid(verdict);
      verified.mark(hash, requirements.maxTimeoutSeconds);
      const body: VerifyResponse = { isValid: true, payer: verdict.buyer, extra: stateOf(verdict.before) };
      log(`POST /verify 200 valid ${hash}`);
      return c.json(body, 200);
    }

    const verdict = await checkDeposit(payload, requirements, stores.channels);
    if (verdict instanceof Rejection) return invalid(verdict);
    verified.mark(hash, requirements.maxTimeoutSeconds);
    const body: VerifyResponse = {
      isValid: true,
      payer: verdict.buyer,
      extra: verdict.existing ? stateOf(verdict.existing) : { channelId: verdict.channelId, balance: "0", totalClaimed: "0", withdrawRequestedAt: null },
    };
    log(`POST /verify 200 valid ${hash}`);
    return c.json(body, 200);
  });

  app.post("/settle", async (c) => {
    const { request, network } = await readRequest(c);
    const { paymentRequirements: requirements, hash } = request;
    const failed = (rejection: Rejection): Response => {
      const body: SettleVerdict = {
        success: false,
        errorReason: rejection.code,
        errorMessage: rejection.message,
        ...(rejection.payer !== undefined ? { payer: rejection.payer } : {}),
        transaction: rejection.transaction ?? "",
        network,
        ...errorBody(rejection.code, rejection.message),
      };
      log(`POST /settle 200 ${rejection.code} ${hash}`);
      return c.json(body, 200);
    };

    // One settle per payload at a time, so two identical requests in flight settle once.
    return settling.run(hash, async () => {
      const stored = settled.get(hash);
      if (stored !== undefined) {
        log(`POST /settle 200 replayed ${hash}`);
        const replayed: SettlementResponse = stored.extra ? { ...stored, extra: { ...stored.extra, replayed: true } } : stored;
        return c.json(replayed, 200);
      }

      const payload = parsePayload(request.paymentPayload.payload, requirements);
      if (payload instanceof Rejection) return failed(payload);

      if (payload.type === "voucher") {
        const identity = await checkVoucher(payload, requirements, stores.channels, now());
        if (identity instanceof Rejection) return failed(identity);
        if (!verified.has(hash)) {
          return failed(new Rejection(SCHEME_ERROR_CODES.shieldedVerifyRequired, "no valid /verify of this payload within maxTimeoutSeconds", identity.buyer));
        }

        // The watermark moves inside the store's atomic update; the same checks run on the record as stored.
        let before: ChannelRecord | undefined;
        let after: ChannelRecord;
        try {
          after = await stores.channels.update(identity.channelId, (current) => {
            before = current;
            const next = applyVoucher(current, payload.channelConfig, payload.voucher, requirements, now());
            if (next instanceof Rejection) throw next;
            return next;
          });
        } catch (error) {
          if (error instanceof Rejection) return failed(error);
          throw error;
        }
        const response: SettlementResponse = {
          success: true,
          transaction: "",
          network,
          payer: identity.buyer,
          extra: {
            commitmentId: `${identity.channelId}:${after.accepted.toString()}`,
            chargedAmount: (after.accepted - (before?.accepted ?? 0n)).toString(),
            channelState: { ...stateOf(after), chargedCumulativeAmount: after.accepted.toString() },
          },
        };
        settled.put(hash, response);
        log(`POST /settle 200 settled ${hash} ${identity.channelId}`);
        return c.json(response, 200);
      }

      if (options.deposits === undefined) {
        throw new HttpError(500, SCHEME_ERROR_CODES.unexpectedSettleError, "this facilitator has no deposit handler");
      }
      const verdict = await checkDeposit(payload, requirements, stores.channels);
      if (verdict instanceof Rejection) return failed(verdict);
      let response: SettlementResponse;
      try {
        response = await options.deposits.settle({ payload, requirements, channelId: verdict.channelId, clientRef: verdict.clientRef });
      } catch (error) {
        // The handler's own verdicts come back as they are; a binding refusal
        // (`shielded_binding_rejected`) becomes one with the code and nothing of the message.
        if (error instanceof Rejection) return failed(error);
        const code = codeOf(error);
        if (code !== undefined) return failed(new Rejection(code, "the deposit was not confirmed", verdict.buyer));
        throw error;
      }
      if (response.success) settled.put(hash, response);
      log(`POST /settle 200 ${response.success ? "settled" : response.errorReason ?? "failed"} ${hash} ${verdict.channelId}`);
      return c.json(response, 200);
    });
  });

  app.notFound((c) => {
    log(`${c.req.method} ${c.req.path} 404`);
    return c.json(errorBody(SCHEME_ERROR_CODES.invalidPayload, `no route ${c.req.method} ${c.req.path}`), 404);
  });

  app.onError((error, c) => {
    if (error instanceof HttpError) {
      log(`${c.req.method} ${c.req.path} ${error.status} ${error.code}`);
      return c.json(error.body(), error.status);
    }
    // The message may hold anything; only its class is logged, and nothing of it is sent.
    const code = c.req.path === "/settle" ? SCHEME_ERROR_CODES.unexpectedSettleError : SCHEME_ERROR_CODES.unexpectedVerifyError;
    log(`${c.req.method} ${c.req.path} 500 ${code} ${error instanceof Error ? error.name : "Error"}`);
    return c.json({ error: "internal error", code, retryable: isRetryable(code) }, 500);
  });

  return app;
}

function stateOf(record: ChannelRecord): ChannelState {
  return {
    channelId: record.channelId,
    balance: record.deposit.toString(),
    totalClaimed: record.settled.toString(),
    withdrawRequestedAt: null,
  };
}

/** A scheme error code carried by a thrown error (`SchemeError`, `BindingError`), if any. */
function codeOf(error: unknown): SchemeErrorCode | undefined {
  if (typeof error !== "object" || error === null) return undefined;
  const code = (error as { code?: unknown }).code;
  return isSchemeErrorCode(code) ? code : undefined;
}
