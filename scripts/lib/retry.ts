export const MAX_RETRIES = 3;

const RATE_LIMIT_MESSAGE = /\b429\b|rate.?limit|too many requests|airdrop limit|faucet has run dry/i;

type ErrorLike = { message?: unknown; cause?: unknown; context?: Record<string, unknown> };

/** Walks the cause chain: kit wraps the HTTP status and the server message in `context`. */
export function isRateLimitError(error: unknown): boolean {
  for (let e = error as ErrorLike | undefined, depth = 0; e && depth < 8; e = e.cause as ErrorLike, depth++) {
    if (e.context?.statusCode === 429) return true;
    if (RATE_LIMIT_MESSAGE.test(String(e.message ?? ""))) return true;
    if (RATE_LIMIT_MESSAGE.test(String(e.context?.__serverMessage ?? ""))) return true;
  }
  return false;
}

/** A cluster whose RPC faucet is shut answers 410. Retrying cannot help. */
export function isFaucetClosedError(error: unknown): boolean {
  return (error as ErrorLike | undefined)?.context?.statusCode === 410;
}

/** Retries only rate limits, up to MAX_RETRIES after the first attempt, doubling the wait. */
export async function withRateLimitRetry<T>(
  attempt: () => Promise<T>,
  sleep: (ms: number) => Promise<void> = (ms) => new Promise((r) => setTimeout(r, ms)),
  baseDelayMs = 2_000,
): Promise<T> {
  for (let retry = 0; ; retry++) {
    try {
      return await attempt();
    } catch (error) {
      if (retry >= MAX_RETRIES || !isRateLimitError(error)) throw error;
      await sleep(baseDelayMs * 2 ** retry);
    }
  }
}
