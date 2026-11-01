import { DEVNET_CAIP2, SCHEME_ERROR_CODES, SCHEME_ID, X402_VERSION, decodeBase58Exact, type BindingId } from "@wakeless/scheme";

/** The `/supported` fields a shielded accept copies (`docs/SCHEME.md` §4.4). */
export interface ShieldedKind {
  readonly escrowAddress: string;
  readonly binding: BindingId;
  readonly teeValidator: string;
  readonly privacyFeeBps: number;
  readonly maxIdleSecs?: number;
}

/** What a plain `batch-settlement` accept must copy from `/supported`. */
export interface PublicKind extends Readonly<Record<string, unknown>> {
  readonly feePayer: string;
  readonly receiverAuthorizer: string;
}

export interface Supported {
  readonly shielded: ShieldedKind;
  /** Only when the facilitator advertises the plain scheme on the same network. */
  readonly public?: PublicKind;
}

/**
 * A refusal the seller can name to the buyer. A class, not a shape: a facilitator's
 * 200 verdict also carries `code` and `retryable`, and must not read as one of these.
 */
export class Refusal {
  constructor(
    readonly code: string,
    readonly message: string,
    readonly retryable: boolean,
  ) {}
}

export const UNAVAILABLE = new Refusal(SCHEME_ERROR_CODES.facilitatorUnavailable, "the facilitator is unreachable or did not answer in time", true);

const ATTESTATION_FAILED = new Refusal(SCHEME_ERROR_CODES.shieldedAttestationFailed, "the facilitator's binding failed TEE attestation", false);

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function isAddress(value: unknown): value is string {
  return decodeBase58Exact(value, 32) !== null;
}

function isCount(value: unknown): value is number {
  return typeof value === "number" && Number.isSafeInteger(value) && value >= 0;
}

function isKindOn(kind: unknown, scheme: string): kind is { extra: Record<string, unknown> } {
  return isObject(kind) && kind.x402Version === X402_VERSION && kind.scheme === scheme && kind.network === DEVNET_CAIP2 && isObject(kind.extra);
}

/**
 * The body of `GET /supported`, or why it offers nothing payable. Only devnet
 * kinds count: a facilitator advertising mainnet is refused like one that does
 * not answer (`CLAUDE.md`, Networks and funds). Never throws.
 */
export function parseSupported(body: unknown): Supported | Refusal {
  if (!isObject(body) || !Array.isArray(body.kinds)) return UNAVAILABLE;
  const shielded = body.kinds.find((kind: unknown) => isKindOn(kind, SCHEME_ID)) as { extra: Record<string, unknown> } | undefined;
  if (shielded === undefined) {
    return isObject(body.extra) && body.extra.error === SCHEME_ERROR_CODES.shieldedAttestationFailed ? ATTESTATION_FAILED : UNAVAILABLE;
  }
  const { escrowAddress, binding, teeValidator, privacyFeeBps, maxIdleSecs } = shielded.extra;
  if (!isAddress(escrowAddress) || binding !== "magicblock" || !isAddress(teeValidator) || !isCount(privacyFeeBps)) return UNAVAILABLE;
  if (maxIdleSecs !== undefined && !isCount(maxIdleSecs)) return UNAVAILABLE;

  const plain = body.kinds.find((kind: unknown) => isKindOn(kind, "batch-settlement")) as { extra: Record<string, unknown> } | undefined;
  const hasPublic = plain !== undefined && isAddress(plain.extra.feePayer) && isAddress(plain.extra.receiverAuthorizer);
  return {
    shielded: { escrowAddress, binding, teeValidator, privacyFeeBps, ...(maxIdleSecs !== undefined ? { maxIdleSecs } : {}) },
    ...(hasPublic ? { public: plain.extra as PublicKind } : {}),
  };
}

/**
 * How long `/supported` is reused. Only an answer is kept; a failure is asked
 * again on the next request. Short, so a facilitator that went away stops being
 * advertised within one deposit's confirmation time.
 */
export const SUPPORTED_TTL_MS = 5_000;

/** The facilitator's three endpoints as a seller calls them. Every failure comes back as a value. */
export class FacilitatorClient {
  private cached: { readonly value: Supported; readonly until: number } | undefined;

  constructor(
    private readonly baseUrl: string,
    private readonly timeoutMs: number,
  ) {}

  async supported(): Promise<Supported | Refusal> {
    if (this.cached !== undefined && Date.now() < this.cached.until) return this.cached.value;
    const reply = await this.call("/supported");
    if (reply instanceof Refusal) return reply;
    const parsed = parseSupported(reply);
    if (!(parsed instanceof Refusal)) this.cached = { value: parsed, until: Date.now() + SUPPORTED_TTL_MS };
    return parsed;
  }

  /** A `/verify` or `/settle` answer: a 200's body as it came, or the refusal. */
  post(path: "/verify" | "/settle", body: unknown): Promise<Record<string, unknown> | Refusal> {
    return this.call(path, body);
  }

  private async call(path: string, body?: unknown): Promise<Record<string, unknown> | Refusal> {
    try {
      const response = await fetch(`${this.baseUrl}${path}`, {
        signal: AbortSignal.timeout(this.timeoutMs),
        redirect: "error",
        ...(body === undefined ? {} : { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) }),
      });
      const parsed: unknown = await response.json();
      if (!isObject(parsed)) return UNAVAILABLE;
      if (response.status === 200) return parsed;
      if (response.status === 503 && parsed.code === SCHEME_ERROR_CODES.shieldedAttestationFailed) return ATTESTATION_FAILED;
      if (response.status === 400 && typeof parsed.code === "string") {
        return new Refusal(parsed.code, typeof parsed.error === "string" ? parsed.error : "the facilitator refused the request", parsed.retryable === true);
      }
      return UNAVAILABLE;
    } catch {
      return UNAVAILABLE;
    }
  }
}
