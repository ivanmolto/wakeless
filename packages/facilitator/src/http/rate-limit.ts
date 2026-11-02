import type { Clock } from "./short-lived.js";

/** `limit` requests per `windowSeconds`, as a fixed window per key. */
export interface RateLimitRule {
  readonly limit: number;
  readonly windowSeconds: number;
}

/** Both limits are configurable; `false` switches one off. */
export interface RateLimits {
  /** Every request, keyed by the caller's address, checked before the body is read. */
  readonly perIp?: RateLimitRule | false;
  /** `/verify` and `/settle`, keyed by the channel id the payload derives, checked once the payload parses. */
  readonly perChannel?: RateLimitRule | false;
}

export const DEFAULT_RATE_LIMITS: { readonly perIp: RateLimitRule; readonly perChannel: RateLimitRule } = {
  perIp: { limit: 300, windowSeconds: 60 },
  perChannel: { limit: 120, windowSeconds: 60 },
};

export type RateVerdict = { readonly allowed: true } | { readonly allowed: false; readonly retryAfterSeconds: number };

/**
 * A fixed-window counter per key, in memory and per process (like the verified
 * set). The window starts at the first request seen for the key and the counter
 * resets when it ends. Keys are swept when their window has passed, so memory is
 * bounded by the number of distinct callers in one window.
 */
export class RateLimiter {
  private readonly windows = new Map<string, { count: number; resetAt: number }>();

  constructor(
    private readonly rule: RateLimitRule,
    private readonly now: Clock,
  ) {
    if (!Number.isInteger(rule.limit) || rule.limit < 1) throw new RangeError("rate limit must be a positive integer");
    if (!Number.isFinite(rule.windowSeconds) || rule.windowSeconds <= 0) throw new RangeError("rate limit window must be positive");
  }

  /** Counts one request for `key` and says whether it is within the limit. */
  hit(key: string): RateVerdict {
    const now = this.now();
    this.sweep(now);
    const window = this.windows.get(key);
    if (window === undefined || window.resetAt <= now) {
      this.windows.set(key, { count: 1, resetAt: now + this.rule.windowSeconds });
      return { allowed: true };
    }
    window.count++;
    if (window.count > this.rule.limit) return { allowed: false, retryAfterSeconds: Math.max(1, Math.ceil(window.resetAt - now)) };
    return { allowed: true };
  }

  get size(): number {
    this.sweep(this.now());
    return this.windows.size;
  }

  private sweep(now: number): void {
    for (const [key, window] of this.windows) if (window.resetAt <= now) this.windows.delete(key);
  }
}

/**
 * `"<limit>/<seconds>"` as `FACILITATOR_RATE_IP` and `FACILITATOR_RATE_CHANNEL`
 * carry it (`"300/60"`), `"off"` for none, unset for the default.
 */
export function parseRateRule(value: string | undefined, fallback: RateLimitRule): RateLimitRule | false {
  if (value === undefined || value.trim() === "") return fallback;
  if (value.trim().toLowerCase() === "off") return false;
  const match = /^\s*(\d+)\s*\/\s*(\d+)\s*$/.exec(value);
  if (match === null) throw new Error(`rate limit must be "<limit>/<seconds>" or "off", got ${JSON.stringify(value)}`);
  const rule = { limit: Number(match[1]), windowSeconds: Number(match[2]) };
  if (rule.limit < 1 || rule.windowSeconds < 1) throw new Error(`rate limit must be at least 1/1, got ${JSON.stringify(value)}`);
  return rule;
}
