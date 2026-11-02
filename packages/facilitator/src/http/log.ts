import { pino, type DestinationStream, type Logger, type LoggerOptions } from "pino";

/**
 * The facilitator's structured log (pino, one JSON object per line). Events carry
 * the method, path, status, scheme error code, payload hash and sometimes a channel
 * id or an operation id; never a payload field, a signature, a bearer token, a key
 * or an amount for a channel (`CLAUDE.md`, Secrets).
 *
 * Two guards sit under that rule. `redact` censors the field names a signature,
 * token or amount would travel under if an object were ever logged whole. The
 * destination wrapper scrubs every written line of 87- and 88-character base58
 * strings (Ed25519 signatures) and bearer tokens, and counts what it scrubbed in
 * a `log_redacted` event, so a test can assert the count is zero: the scrub is a
 * last resort, not a licence.
 */
export type FacilitatorLogger = Logger;

export interface LoggerOptionsIn {
  readonly level?: string;
  /** Where lines go. Default: stdout. Tests pass a capturing stream. */
  readonly destination?: DestinationStream;
  readonly base?: Record<string, unknown>;
}

/** Field names censored wherever they appear, at any depth. */
export const REDACTED_PATHS: readonly string[] = [
  "signature",
  "*.signature",
  "*.*.signature",
  "depositSignature",
  "*.depositSignature",
  "token",
  "*.token",
  "authorization",
  "*.authorization",
  "secretKey",
  "*.secretKey",
  "privateKey",
  "*.privateKey",
  "amount",
  "*.amount",
  "maxClaimableAmount",
  "*.maxClaimableAmount",
  "deposit",
  "*.deposit",
  "balance",
  "*.balance",
  "accepted",
  "*.accepted",
  "settled",
  "*.settled",
  "chargedAmount",
  "*.chargedAmount",
  "chargedCumulativeAmount",
  "*.chargedCumulativeAmount",
];

const BASE58_SIGNATURE = /[1-9A-HJ-NP-Za-km-z]{87,88}/g;
const BEARER = /bearer\s+[A-Za-z0-9._~+/=-]+/gi;

/**
 * Wraps a destination so every line is scrubbed of signatures and bearer tokens
 * before it is written. Returns the stream and a counter of scrubbed matches.
 */
export function scrubbingDestination(inner: DestinationStream): { stream: DestinationStream; scrubbed: () => number } {
  let count = 0;
  const stream: DestinationStream = {
    write(line: string): void {
      let out = line.replace(BASE58_SIGNATURE, () => {
        count++;
        return "[redacted]";
      });
      out = out.replace(BEARER, () => {
        count++;
        return "[redacted]";
      });
      inner.write(out);
    },
  };
  return { stream, scrubbed: () => count };
}

/** A line-callback adapter, for callers that pass `log: (line) => …`. Each JSON line is handed over without its newline. */
export function lineDestination(onLine: (line: string) => void): DestinationStream {
  return {
    write(chunk: string): void {
      for (const line of chunk.split("\n")) if (line.length > 0) onLine(line);
    },
  };
}

export function createFacilitatorLogger(options: LoggerOptionsIn = {}): FacilitatorLogger {
  const inner = options.destination ?? pino.destination({ sync: true });
  const { stream, scrubbed } = scrubbingDestination(inner);
  const settings: LoggerOptions = {
    level: options.level ?? "info",
    base: { service: "wakeless-facilitator", ...(options.base ?? {}) },
    redact: { paths: [...REDACTED_PATHS], censor: "[redacted]" },
    hooks: {
      logMethod(args, method) {
        const before = scrubbed();
        method.apply(this, args);
        const after = scrubbed();
        // The scrub fired: say so, once, on a line that itself carries nothing to scrub.
        if (after > before) method.apply(this, [{ event: "log_redacted", count: after - before }, "a log line carried a signature or a token and was scrubbed"]);
      },
    },
  };
  return pino(settings, stream);
}
