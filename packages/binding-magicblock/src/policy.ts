// Settlement timing and splitting: pure functions, tested on their own. The spike found that
// the ephemeral → ephemeral route executes at once whatever these say (docs/DEVIATIONS.md,
// task 1.2); the binding sends them anyway so the queued route, when it applies, is shaped.

export const USDC_BASE_UNITS = 1_000_000n;

/** Default window: 30 s to 5 min. */
export const DEFAULT_DELAY_WINDOW_MS = { min: 30_000, max: 300_000 } as const;

export interface DelayWindowMs {
  readonly min: number;
  readonly max: number;
}

export function assertDelayWindow(window: DelayWindowMs): void {
  if (!Number.isInteger(window.min) || !Number.isInteger(window.max) || window.min < 0 || window.max < window.min) {
    throw new RangeError("settlement delay window must be integers with 0 <= min <= max");
  }
}

/**
 * Two points drawn uniformly inside the window, ordered. `random` returns [0, 1).
 * Both bounds stay inside the window, so the enclave's own draw does too.
 */
export function pickDelay(window: DelayWindowMs, random: () => number = Math.random): { minDelayMs: number; maxDelayMs: number } {
  assertDelayWindow(window);
  const span = window.max - window.min;
  const draw = () => window.min + Math.floor(clamp01(random()) * (span + 1));
  const a = draw();
  const b = draw();
  return a <= b ? { minDelayMs: a, maxDelayMs: b } : { minDelayMs: b, maxDelayMs: a };
}

function clamp01(x: number): number {
  if (!Number.isFinite(x) || x < 0) return 0;
  if (x >= 1) return 1 - Number.EPSILON;
  return x;
}

/** 1 under 2 USDC; one part per whole USDC above, capped at 5. */
export function splitFor(amount: bigint): number {
  if (amount <= 0n) throw new RangeError("amount must be positive");
  if (amount < 2n * USDC_BASE_UNITS) return 1;
  const wholeUnits = amount / USDC_BASE_UNITS;
  return Number(wholeUnits > 5n ? 5n : wholeUnits);
}
