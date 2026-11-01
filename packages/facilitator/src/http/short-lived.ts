import type { SettlementResponse } from "@wakeless/scheme";

export type Clock = () => number;

/**
 * The verified set of the authorization flow: a payload hash enters on a valid
 * `/verify` and lives `maxTimeoutSeconds`; `/settle` for a voucher must find it
 * there. In memory and per process: a facilitator with several processes needs
 * the vendor to reach the same one for verify and settle, or a shared set (a
 * hardening task; `docs/wakeless-plan.md` 7.x).
 */
export class VerifiedSet {
  private readonly expiresAt = new Map<string, number>();

  constructor(private readonly now: Clock = () => Date.now() / 1000) {}

  mark(hash: string, ttlSeconds: number): void {
    this.sweep();
    this.expiresAt.set(hash, this.now() + ttlSeconds);
  }

  has(hash: string): boolean {
    this.sweep();
    return this.expiresAt.has(hash);
  }

  get size(): number {
    this.sweep();
    return this.expiresAt.size;
  }

  private sweep(): void {
    const now = this.now();
    for (const [hash, at] of this.expiresAt) if (at <= now) this.expiresAt.delete(hash);
  }
}

/**
 * Settled results by payload hash, for the idempotent `/settle`: a repeated
 * identical payload gets the stored response with `extra.replayed: true` and
 * moves no watermark. Results outlive the verified set; `ttlSeconds` bounds
 * memory, not correctness (a replay after expiry is refused by the watermark,
 * as `cumulative_amount_mismatch`, never settled twice).
 */
export class SettledResults {
  private readonly results = new Map<string, { response: SettlementResponse; expiresAt: number }>();

  constructor(
    private readonly ttlSeconds: number,
    private readonly now: Clock = () => Date.now() / 1000,
  ) {}

  get(hash: string): SettlementResponse | undefined {
    this.sweep();
    return this.results.get(hash)?.response;
  }

  put(hash: string, response: SettlementResponse): void {
    this.sweep();
    this.results.set(hash, { response, expiresAt: this.now() + this.ttlSeconds });
  }

  private sweep(): void {
    const now = this.now();
    for (const [hash, entry] of this.results) if (entry.expiresAt <= now) this.results.delete(hash);
  }
}
