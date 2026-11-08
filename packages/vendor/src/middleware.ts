import { isDeepStrictEqual } from "node:util";
import {
  DEVNET_CAIP2,
  SCHEME_ERROR_CODES,
  SCHEME_ID,
  U64_MAX,
  WITHDRAW_DELAY_MAX,
  WITHDRAW_DELAY_MIN,
  X402_VERSION,
  decodeBase58Exact,
  parseU64,
  publicKeyOf,
  type PaymentRequired,
  type PaymentRequirements,
} from "@wakeless/scheme";
import type { Context, MiddlewareHandler } from "hono";
import { decodePaymentSignature } from "./decode.js";
import { FacilitatorClient, Refusal, UNAVAILABLE, parseCorrective, type Supported } from "./facilitator.js";
import type { TermsOptions } from "./terms/index.js";
import { quoteFor, signTermsReceipt, type TermsReceipt } from "./terms/receipt.js";

export const PAYMENT_REQUIRED_HEADER = "PAYMENT-REQUIRED";
export const PAYMENT_SIGNATURE_HEADER = "PAYMENT-SIGNATURE";
export const PAYMENT_RESPONSE_HEADER = "PAYMENT-RESPONSE";

/** Devnet USDC and the SPL token program (`docs/SCHEME.md` §4.1). */
export const DEVNET_USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
export const TOKEN_PROGRAM = "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA";

export const DEFAULT_MAX_TIMEOUT_SECONDS = 60;
export const DEFAULT_WITHDRAW_DELAY = 3600;
/** Long enough for a deposit, which `/settle` confirms against the TEE RPC. */
export const DEFAULT_FACILITATOR_TIMEOUT_MS = 15_000;
/** `extra.minDeposit` when none is set, as a multiple of the route's price (`docs/SCHEME.md` §4.1). */
export const DEFAULT_MIN_DEPOSIT_MULTIPLE = 100n;

export interface X402ShieldedOptions {
  readonly facilitatorUrl: string;
  /** The vendor's address, base58. */
  readonly payTo: string;
  /**
   * Price per request in atomic units, by route: `{"/price/:symbol": "1000"}`.
   * `:name` matches one path segment and `*` the rest of the path. A path that
   * matches no key is not this middleware's business and passes through free.
   */
  readonly amountPerRoute: Readonly<Record<string, string>>;
  readonly maxTimeoutSeconds?: number;
  /**
   * Also offer a plain `batch-settlement` entry. Its `feePayer` and
   * `receiverAuthorizer` must come from the facilitator's `/supported`, so the
   * entry appears only when the facilitator advertises that kind.
   */
  readonly alsoAcceptPublic?: boolean;
  readonly asset?: string;
  readonly tokenProgram?: string;
  readonly withdrawDelay?: number;
  /** Deposit target for every route, at least each route's price. Default: 100 times the route's price. */
  readonly minDeposit?: string;
  readonly facilitatorTimeoutMs?: number;
  /**
   * The relationship-terms layer (task 12.1T), present only when `RELATIONSHIP_TERMS=true`
   * (`termsIfEnabled`). Absent, the middleware is exactly what it was without the layer.
   * With it, `amountPerRoute` is each route's standard price; the entry a buyer gets
   * carries its own price, `extra.minDeposit` and a vendor-signed `extra.termsReceipt`.
   */
  readonly terms?: TermsOptions;
}

/** A plain `batch-settlement` entry: the same top-level fields under the standard scheme id. */
export interface PublicRequirements extends Omit<PaymentRequirements, "scheme" | "extra"> {
  readonly scheme: "batch-settlement";
  readonly extra: Readonly<Record<string, unknown>>;
}

export type Accept = PaymentRequirements | PublicRequirements;

/** `PaymentRequired` with the entries this middleware can list. */
export interface VendorPaymentRequired extends Omit<PaymentRequired, "accepts"> {
  readonly accepts: readonly Accept[];
}

interface Route {
  readonly pattern: RegExp;
  readonly amount: string;
  readonly minDeposit: string;
}

function encode(value: unknown): string {
  return Buffer.from(JSON.stringify(value)).toString("base64");
}

/**
 * `extra` keys that are not matched: `minDeposit` is a target the corrective 402
 * raises, `channelState` and `voucherState` travel on a corrective 402 only, and
 * `termsReceipt` is the signed account of `amount` and `minDeposit`, which are matched
 * themselves. A buyer echoing a corrective entry as `accepted` has still accepted this
 * route's terms, so they are left out of the match.
 */
const NOT_MATCHED: readonly string[] = ["minDeposit", "channelState", "voucherState", "termsReceipt"];

function matchable(entry: unknown, alsoDrop: readonly string[] = []): unknown {
  if (typeof entry !== "object" || entry === null || Array.isArray(entry)) return entry;
  const { extra, ...rest } = entry as Record<string, unknown>;
  if (typeof extra !== "object" || extra === null || Array.isArray(extra)) return entry;
  const kept = Object.fromEntries(Object.entries(extra).filter(([key]) => !NOT_MATCHED.includes(key)));
  const top = Object.fromEntries(Object.entries(rest).filter(([key]) => !alsoDrop.includes(key)));
  return { ...top, extra: kept };
}

/** The entry as the facilitator gets it: the terms receipt is the buyer's and the vendor's, never the facilitator's. */
function forFacilitator(entry: Accept): Accept {
  if (!("termsReceipt" in entry.extra)) return entry;
  const { termsReceipt: _terms, ...extra } = entry.extra as Record<string, unknown>;
  void _terms;
  return { ...entry, extra } as Accept;
}

/** `payload.channelConfig.buyer` when it is an address; the facilitator checks the rest. */
function buyerOf(payload: Readonly<Record<string, unknown>>): string | undefined {
  const config = payload.channelConfig;
  if (typeof config !== "object" || config === null) return undefined;
  const buyer = (config as Record<string, unknown>).buyer;
  return decodeBase58Exact(buyer, 32) === null ? undefined : (buyer as string);
}

/** `payload.voucher.channelId` when it is a channel id. */
function channelIdOf(payload: Readonly<Record<string, unknown>>): string | undefined {
  const voucher = payload.voucher;
  if (typeof voucher !== "object" || voucher === null) return undefined;
  const channelId = (voucher as Record<string, unknown>).channelId;
  return decodeBase58Exact(channelId, 32) === null ? undefined : (channelId as string);
}

/** The two `/verify` verdicts that make the next 402 corrective (briefing §3, rows 1 and 2). */
const CORRECTIVE_CODES: ReadonlySet<string> = new Set([SCHEME_ERROR_CODES.cumulativeAmountMismatch, SCHEME_ERROR_CODES.cumulativeExceedsDeposit]);

/** `payload.voucher.maxClaimableAmount` as the buyer sent it, when it is a u64. */
function cumulativeOf(payload: Readonly<Record<string, unknown>>): bigint | undefined {
  const voucher = payload.voucher;
  if (typeof voucher !== "object" || voucher === null) return undefined;
  const parsed = parseU64((voucher as Record<string, unknown>).maxClaimableAmount, "maxClaimableAmount", SCHEME_ERROR_CODES.invalidPayload);
  return parsed.ok ? parsed.value : undefined;
}

function compile(path: string): RegExp {
  const source = path
    .split("/")
    .map((segment) => (segment === "*" ? ".*" : segment.startsWith(":") ? "[^/]+" : segment.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")))
    .join("/");
  return new RegExp(`^${source}$`);
}

function compileRoutes(options: X402ShieldedOptions, maxTimeoutSeconds: number, withdrawDelay: number): readonly Route[] {
  if (decodeBase58Exact(options.payTo, 32) === null) throw new Error("x402Shielded: payTo must be a 32-byte base58 address");
  if (!Number.isSafeInteger(maxTimeoutSeconds) || maxTimeoutSeconds <= 0) throw new Error("x402Shielded: maxTimeoutSeconds must be a positive integer");
  if (!Number.isSafeInteger(withdrawDelay) || withdrawDelay < WITHDRAW_DELAY_MIN || withdrawDelay > WITHDRAW_DELAY_MAX || withdrawDelay < maxTimeoutSeconds) {
    throw new Error(`x402Shielded: withdrawDelay must be ${WITHDRAW_DELAY_MIN}..=${WITHDRAW_DELAY_MAX} and at least maxTimeoutSeconds`);
  }
  const code = SCHEME_ERROR_CODES.invalidPaymentRequirements;
  const fixedMin = options.minDeposit === undefined ? undefined : parseU64(options.minDeposit, "minDeposit", code);
  if (fixedMin !== undefined && !fixedMin.ok) throw new Error(`x402Shielded: ${fixedMin.message}`);

  const entries = Object.entries(options.amountPerRoute);
  if (entries.length === 0) throw new Error("x402Shielded: amountPerRoute names no route");
  return entries.map(([path, amount]) => {
    const parsed = parseU64(amount, `amountPerRoute[${path}]`, code);
    if (!parsed.ok) throw new Error(`x402Shielded: ${parsed.message}`);
    if (parsed.value === 0n) throw new Error(`x402Shielded: amountPerRoute[${path}] must be positive`);
    if (fixedMin !== undefined && fixedMin.ok && fixedMin.value < parsed.value) throw new Error(`x402Shielded: minDeposit is below the price of ${path}`);
    const scaled = parsed.value * DEFAULT_MIN_DEPOSIT_MULTIPLE;
    return { pattern: compile(path), amount, minDeposit: options.minDeposit ?? (scaled > U64_MAX ? amount : scaled.toString()) };
  });
}

/**
 * The seller side of `batch-settlement-shielded` for Hono. The protocol-default
 * authorization flow: `/verify`, then the resource, then `/settle`, and the
 * resource leaves only once settled. Anything else is a 402, so a facilitator
 * that cannot be reached never costs the vendor an unpaid response.
 */
export function x402Shielded(options: X402ShieldedOptions): MiddlewareHandler {
  const maxTimeoutSeconds = options.maxTimeoutSeconds ?? DEFAULT_MAX_TIMEOUT_SECONDS;
  const withdrawDelay = options.withdrawDelay ?? DEFAULT_WITHDRAW_DELAY;
  const asset = options.asset ?? DEVNET_USDC;
  const tokenProgram = options.tokenProgram ?? TOKEN_PROGRAM;
  const routes = compileRoutes(options, maxTimeoutSeconds, withdrawDelay);
  const facilitator = new FacilitatorClient(options.facilitatorUrl.replace(/\/+$/, ""), options.facilitatorTimeoutMs ?? DEFAULT_FACILITATOR_TIMEOUT_MS);
  const terms = options.terms;
  if (terms !== undefined && publicKeyOf(terms.signer) !== options.payTo) throw new Error("x402Shielded: terms.signer must be the payTo key");

  /**
   * This buyer's terms for the route (briefing §3c): price, funding requirement and the
   * signed receipt. `null` is an unknown buyer, who gets the standard terms. Only with the
   * layer on; without it the route's own amount and target stand.
   */
  function quote(route: Route, buyer: string | null): { amount: string; minDeposit: string; termsReceipt?: TermsReceipt } {
    if (terms === undefined) return { amount: route.amount, minDeposit: route.minDeposit };
    const history = buyer === null ? undefined : terms.history.get(buyer);
    const quoted = quoteFor(BigInt(route.amount), buyer, history);
    return { amount: quoted.terms.price.toString(), minDeposit: quoted.terms.minDeposit.toString(), termsReceipt: signTermsReceipt(terms.signer, quoted.unsigned) };
  }

  function acceptsFor(route: Route, supported: Supported, buyer: string | null = null): readonly Accept[] {
    const quoted = quote(route, buyer);
    const common = { network: DEVNET_CAIP2, amount: quoted.amount, asset, payTo: options.payTo, maxTimeoutSeconds };
    const shielded: PaymentRequirements = {
      scheme: SCHEME_ID,
      ...common,
      extra: {
        paymentFlow: "authorization",
        voucherSigner: "client",
        withdrawDelay,
        tokenProgram,
        minDeposit: quoted.minDeposit,
        ...supported.shielded,
        ...(quoted.termsReceipt === undefined ? {} : { termsReceipt: quoted.termsReceipt }),
      } as PaymentRequirements["extra"],
    };
    if (options.alsoAcceptPublic !== true || supported.public === undefined) return [shielded];
    // The plain entry stays at the route's standard price: terms are a shielded channel's.
    return [shielded, { scheme: "batch-settlement", ...common, amount: route.amount, extra: { ...supported.public, withdrawDelay, tokenProgram } }];
  }

  /**
   * The corrective 402's entries (`docs/SCHEME.md` §4.2): the shielded entry the buyer
   * paid against carries the channel as the facilitator holds it and the buyer's last
   * accepted voucher, so the buyer resynchronises its cumulative; above the deposit it
   * also carries the deposit target that makes the refused voucher fit: the route's
   * `minDeposit` or the shortfall, whichever is larger. Nothing here reaches the ledger.
   */
  function correctiveAccepts(accepts: readonly Accept[], paid: Accept, code: string, verdictExtra: unknown, payload: Readonly<Record<string, unknown>>): readonly Accept[] {
    if (paid.scheme !== SCHEME_ID) return accepts;
    const corrective = parseCorrective(verdictExtra);
    // The entry's own target: the route's, or this buyer's funding requirement with the layer on.
    const target = paid.extra.minDeposit ?? paid.amount;
    let minDeposit = target;
    if (code === SCHEME_ERROR_CODES.cumulativeExceedsDeposit && corrective !== undefined) {
      const cumulative = cumulativeOf(payload);
      const shortfall = cumulative === undefined ? 0n : cumulative - BigInt(corrective.channelState.balance);
      if (shortfall > BigInt(target)) minDeposit = shortfall.toString();
    }
    const extra: PaymentRequirements["extra"] = {
      ...paid.extra,
      minDeposit,
      ...(corrective === undefined ? {} : { channelState: corrective.channelState, ...(corrective.voucherState === undefined ? {} : { voucherState: corrective.voucherState }) }),
    };
    return accepts.map((entry) => (entry === paid ? { ...paid, extra } : entry));
  }

  /** A 402. `accepts` is empty when the facilitator cannot be reached, so no client deposits into a channel it cannot use. */
  function paymentRequired(c: Context, accepts: readonly Accept[], refusal?: Refusal, settlement?: unknown): Response {
    const required: VendorPaymentRequired = {
      x402Version: X402_VERSION,
      error: refusal?.code ?? `${PAYMENT_SIGNATURE_HEADER} header is required`,
      resource: { url: c.req.url },
      accepts,
    };
    const body = refusal === undefined ? { error: required.error } : { error: refusal.message, code: refusal.code, retryable: refusal.retryable };
    return new Response(JSON.stringify(body), {
      status: 402,
      headers: {
        "content-type": "application/json",
        "cache-control": "private, no-store",
        [PAYMENT_REQUIRED_HEADER]: encode(required),
        ...(settlement === undefined ? {} : { [PAYMENT_RESPONSE_HEADER]: encode(settlement) }),
      },
    });
  }

  return async (c, next) => {
    const route = routes.find(({ pattern }) => pattern.test(c.req.path));
    if (route === undefined) return next();

    const header = c.req.header(PAYMENT_SIGNATURE_HEADER);
    const decoded = header === undefined ? undefined : decodePaymentSignature(header);
    if (decoded !== undefined && !decoded.ok) {
      return c.json({ error: decoded.message, code: decoded.code, retryable: false }, 400, { "cache-control": "private, no-store" });
    }

    const supported = await facilitator.supported();
    if (supported instanceof Refusal) return paymentRequired(c, [], supported);
    if (decoded === undefined) return paymentRequired(c, acceptsFor(route, supported));

    // The buyer is known from its payment (`channelConfig.buyer`); with the layer on, the
    // entries offered are this buyer's. The buyer's copy is never what gets verified: price
    // and payTo are this route's own, and the entry forwarded as `accepted` is the route's.
    const buyer = terms === undefined ? null : (buyerOf(decoded.value.payload) ?? null);
    const channelId = channelIdOf(decoded.value.payload);
    if (terms !== undefined && buyer !== null && channelId !== undefined) terms.history.seen(buyer, channelId);
    const accepts = acceptsFor(route, supported, buyer);
    const offered = matchable(decoded.value.accepted);
    const accepted = accepts.find((entry) => isDeepStrictEqual(matchable(entry), offered));
    if (accepted === undefined) {
      // The same entry at another price is a buyer that paid against the standard terms and has its own.
      const termsOnly = terms !== undefined && accepts.some((entry) => isDeepStrictEqual(matchable(entry, ["amount"]), matchable(decoded.value.accepted, ["amount"])));
      return termsOnly
        ? paymentRequired(c, accepts, new Refusal(SCHEME_ERROR_CODES.shieldedTermsQuoted, "this buyer's terms differ from the entry it paid against; pay against the entry offered", true))
        : paymentRequired(c, accepts, new Refusal(SCHEME_ERROR_CODES.invalidPaymentRequirements, "accepted is not an entry this route offers", false));
    }
    // A seller takes a payment: a deposit or a voucher. A close request (`refund`) goes to the
    // facilitator from the buyer directly and pays for nothing; here it is refused before any call.
    const payloadType = decoded.value.payload.type;
    if (payloadType !== "deposit" && payloadType !== "voucher") {
      return paymentRequired(c, accepts, new Refusal(SCHEME_ERROR_CODES.payloadType, "payload.type must be deposit or voucher", false));
    }
    const forwarded = forFacilitator(accepted);
    const request = { x402Version: X402_VERSION, paymentPayload: { ...decoded.value, accepted: forwarded }, paymentRequirements: forwarded };

    const verdict = await facilitator.post("/verify", request);
    if (verdict instanceof Refusal) return paymentRequired(c, verdict.code === UNAVAILABLE.code ? [] : accepts, verdict);
    if (verdict.isValid !== true) {
      const code = typeof verdict.invalidReason === "string" ? verdict.invalidReason : SCHEME_ERROR_CODES.unexpectedVerifyError;
      const refusal = new Refusal(code, typeof verdict.invalidMessage === "string" ? verdict.invalidMessage : "the voucher was not accepted", verdict.retryable === true);
      if (terms !== undefined && buyer !== null && channelId !== undefined && code === SCHEME_ERROR_CODES.cumulativeExceedsDeposit) terms.history.corrective(buyer, channelId);
      const entries = CORRECTIVE_CODES.has(code) ? correctiveAccepts(accepts, accepted, code, verdict.extra, decoded.value.payload) : accepts;
      return paymentRequired(c, entries, refusal);
    }

    await next();
    // A failed handler delivered nothing, so nothing is charged.
    if (c.res.status >= 400) return;

    const settlement = await facilitator.post("/settle", request);
    if (settlement instanceof Refusal || settlement.success !== true) {
      const refusal =
        settlement instanceof Refusal
          ? settlement
          : new Refusal(
              typeof settlement.errorReason === "string" ? settlement.errorReason : SCHEME_ERROR_CODES.unexpectedSettleError,
              typeof settlement.errorMessage === "string" ? settlement.errorMessage : "the payment did not settle",
              settlement.retryable === true,
            );
      c.res = undefined;
      c.res = paymentRequired(c, refusal.code === UNAVAILABLE.code ? [] : accepts, refusal, settlement instanceof Refusal ? undefined : settlement);
      return;
    }
    c.header(PAYMENT_RESPONSE_HEADER, encode(settlement));
    c.header("cache-control", "private, no-store");
  };
}
