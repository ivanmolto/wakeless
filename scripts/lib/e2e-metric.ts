// Task 5.2: the metric of `pnpm e2e`, pure so the failure paths have unit tests.
//
// Two ratios, both bounded by 0.2 per request. The headline is what the public ledger
// shows: signatures `observe` finds on the base layer, or that carry a memo or a
// plaintext recipient. The second is the plan's conservative count, every signature the
// run emitted, which overstates the ledger since these private transfers execute inside
// the rollup. A run that served nothing emits nothing and would score 0.00, so the bounds
// alone are not enough: every request must have been served, on all three vendors.

export const MAX_BASE_LAYER_TX_PER_REQUEST = 0.2;
export const E2E_TITLE = "e2e: base-layer transactions per request below 0.2";

export interface E2eCounts {
  readonly requests: number;
  readonly served: number;
  readonly deposits: number;
  /** Requests paid per vendor, one entry per vendor the run started. */
  readonly servedPerVendor: readonly number[];
  /** Every signature the run emitted, buyer and escrow. */
  readonly signatures: number;
  /** Of those, how many the public ledger shows, or that carry a memo or a plaintext recipient. */
  readonly visibleOnBaseLayer: number;
}

export interface E2eVerdict {
  /** Ledger-visible transactions per request: the headline. */
  readonly perRequest: number;
  /** Every emitted signature per request: the conservative bound. */
  readonly emittedPerRequest: number;
  readonly failures: readonly string[];
}

function ratio(numerator: number, requests: number): number {
  return requests > 0 ? numerator / requests : Number.POSITIVE_INFINITY;
}

export function evaluateE2e(counts: E2eCounts): E2eVerdict {
  const perRequest = ratio(counts.visibleOnBaseLayer, counts.requests);
  const emittedPerRequest = ratio(counts.signatures, counts.requests);
  const failures: string[] = [];
  if (counts.requests <= 0) failures.push("no requests were made");
  if (counts.served !== counts.requests) failures.push(`${counts.served} of ${counts.requests} requests were served`);
  if (counts.servedPerVendor.length === 0 || counts.servedPerVendor.some((n) => n === 0)) failures.push("a vendor was never paid");
  if (counts.deposits === 0) failures.push("no deposit was made");
  if (!(perRequest < MAX_BASE_LAYER_TX_PER_REQUEST)) failures.push(`base-layer transactions per request is not below ${MAX_BASE_LAYER_TX_PER_REQUEST}`);
  if (!(emittedPerRequest < MAX_BASE_LAYER_TX_PER_REQUEST)) failures.push(`signatures emitted per request is not below ${MAX_BASE_LAYER_TX_PER_REQUEST}`);
  return { perRequest, emittedPerRequest, failures };
}

export function formatE2eTable(counts: E2eCounts, verdict: E2eVerdict): string {
  const rows: readonly (readonly [string, string])[] = [
    ["requests", String(counts.requests)],
    ["deposits", String(counts.deposits)],
    ["base-layer transactions (the ledger shows)", String(counts.visibleOnBaseLayer)],
    ["base-layer transactions per request", verdict.perRequest.toFixed(2)],
    ["signatures emitted (inside the rollup)", String(counts.signatures)],
    ["signatures emitted per request", verdict.emittedPerRequest.toFixed(2)],
  ];
  const width = Math.max(...rows.map(([label]) => label.length));
  return rows.map(([label, value]) => `${label.padEnd(width)}  ${value.padStart(6)}`).join("\n");
}
