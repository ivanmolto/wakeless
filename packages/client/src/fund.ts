// `wakeless fund` (task 8.3): funds a buyer address on Solana from USDC on another
// chain through Aurora Intents in confidential mode, so the Solana ledger cannot
// link the channel to the operator's origin wallet. One quote (`confidentiality:
// "advanced"`), the deposit address printed for the operator to pay, then the
// status endpoint polled to a terminal state. No SDK, no Solana RPC, no keypair:
// the only key material this module touches is the recipient's public address.
//
// This is one of the two code paths that may run on mainnet (CLAUDE.md, Networks
// and funds). It refuses unless FUNDING=aurora, MAINNET_ENABLED=true and the
// confirmation given on the command line equals DEMO_CONFIRM in .env, and it caps
// the amount at FUND_MAX_USDC (default 5). The API key goes into request URLs and
// nowhere else: every line printed or thrown is scrubbed of it.
import type { FundingSource, LocalChannelStore } from "./store.js";

export const AURORA_API = "https://intents-api.aurora.dev";
export const DEFAULT_FUND_MAX_USDC = 5;
/** `deadline` sent with the quote: the refund begins if the swap is not done by then. */
export const QUOTE_DEADLINE_MS = 20 * 60 * 1000;
/** Polling stops this long after that deadline. */
export const POLL_GRACE_MS = 5 * 60 * 1000;
export const POLL_MIN_MS = 5_000;
export const POLL_MAX_MS = 30_000;
/** The channel deposit follows the arrival after a uniform delay in this window, so timing alone does not pair them. */
export const DEPOSIT_DELAY_MIN_MS = 2 * 60 * 1000;
export const DEPOSIT_DELAY_MAX_MS = 10 * 60 * 1000;
const DESTINATION_BLOCKCHAIN = "sol";
const REDACTED = "[redacted]";

export const FUND_ERROR_CODES = {
  /** A flag is missing or wrong: `FUNDING`, `MAINNET_ENABLED`, `DEMO_CONFIRM`, `AURORA_API_KEY`. The message says which. */
  refused: "shielded_fund_refused",
  /** The amount is not a positive number of USDC at or under `FUND_MAX_USDC`. */
  amount: "shielded_fund_amount",
  /** The origin chain, the recipient or the refund address is missing or has no USDC on Aurora's list. */
  input: "shielded_fund_input",
  /** Aurora answered something the module cannot use (the tokens list, the quote). */
  api: "shielded_fund_api",
} as const;

export class FundRefusedError extends Error {
  constructor(
    readonly code: string,
    message: string,
  ) {
    super(`${code}: ${message}`);
    this.name = "FundRefusedError";
  }
}

/** Chain names the operator may type, mapped to Aurora's `blockchain` ids. Any other value is passed through as an id. */
export const CHAIN_ALIASES: Readonly<Record<string, string>> = {
  base: "base",
  near: "near",
  arbitrum: "arb",
  arb: "arb",
  ethereum: "eth",
  eth: "eth",
  solana: "sol",
  sol: "sol",
};

export interface AuroraToken {
  readonly assetId: string;
  readonly decimals: number;
  readonly blockchain: string;
  readonly symbol: string;
}

export type FundStatus = "PENDING_DEPOSIT" | "KNOWN_DEPOSIT_TX" | "INCOMPLETE_DEPOSIT" | "PROCESSING" | "SUCCESS" | "REFUNDED" | "FAILED";
const TERMINAL: ReadonlySet<string> = new Set(["SUCCESS", "REFUNDED", "FAILED"]);
const STATUSES: ReadonlySet<string> = new Set(["PENDING_DEPOSIT", "KNOWN_DEPOSIT_TX", "INCOMPLETE_DEPOSIT", "PROCESSING", ...TERMINAL]);

export interface FundInput {
  /** The origin chain: a name from `CHAIN_ALIASES` or an Aurora `blockchain` id. */
  readonly from: string;
  /** USDC, decimal string as typed (`"2"`, `"2.5"`). Whole USDC by default; a fraction is warned about. */
  readonly amount: string;
  /** The Solana address that receives the USDC: a fresh buyer address. */
  readonly recipient: string;
  /** The operator's origin-chain wallet, where a refund goes. */
  readonly refundTo: string;
  /** The value typed for `--confirm`; must equal `DEMO_CONFIRM` in `.env`. */
  readonly confirm: string | undefined;
  /** Skip the randomised delay before the channel deposit (tests, and runs where the deposit is made by hand later). */
  readonly noWait?: boolean;
}

export interface FundDeps {
  /** `process.env` or a test's copy. Read: `FUNDING`, `MAINNET_ENABLED`, `DEMO_CONFIRM`, `AURORA_API_KEY`, `FUND_MAX_USDC`, `AURORA_API`. */
  readonly env: Readonly<Record<string, string | undefined>>;
  readonly fetch: typeof globalThis.fetch;
  /** The owner's channel file; the funding is appended to its trajectory on SUCCESS. */
  readonly store: Pick<LocalChannelStore, "appendTrajectory">;
  /** What the operator sees, one line at a time. Never the API key, never a full signature. */
  readonly print: (line: string) => void;
  /** Runs after the delay on SUCCESS: the channel deposit, or what stands for it in this process. */
  readonly deposit?: (funding: FundingSource) => void | Promise<void>;
  readonly now?: () => Date;
  readonly sleep?: (ms: number) => Promise<void>;
  /** Uniform in [0, 1); the deposit delay. */
  readonly random?: () => number;
}

export interface FundOutcome {
  readonly status: FundStatus | "TIMEOUT";
  /** 0 on SUCCESS and REFUNDED, 1 on FAILED and when polling stopped at the deadline plus five minutes. */
  readonly exitCode: 0 | 1;
  readonly depositAddress: string;
  readonly funding?: FundingSource;
  /** ISO 8601: when the channel deposit was scheduled for (SUCCESS only). */
  readonly depositAfter?: string;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function defaultSleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export function redactKey(text: string, apiKey: string): string {
  return apiKey.length === 0 ? text : text.split(apiKey).join(REDACTED);
}

/** `first8…last8`: enough to find a signature in the channel file, never the whole string in a line. */
export function shortSignature(signature: string): string {
  return signature.length <= 20 ? signature : `${signature.slice(0, 8)}…${signature.slice(-8)}`;
}

/** The three flags, checked before anything is sent. The message names every flag the operator has to set. */
export function assertFundingFlags(env: FundDeps["env"], confirm: string | undefined): string {
  const problems: string[] = [];
  if (env.FUNDING !== "aurora") problems.push("FUNDING is not `aurora` (the funding module is off by default)");
  if (env.MAINNET_ENABLED !== "true") problems.push("MAINNET_ENABLED is not `true` (this module runs on mainnet only; Aurora has no devnet)");
  if (!env.DEMO_CONFIRM) problems.push("DEMO_CONFIRM is empty in .env (a human sets it for the day)");
  else if (confirm !== env.DEMO_CONFIRM) problems.push("--confirm does not equal DEMO_CONFIRM in .env");
  if (!env.AURORA_API_KEY) problems.push("AURORA_API_KEY is not set (a key from https://studio.aurora.dev)");
  if (problems.length > 0) {
    throw new FundRefusedError(
      FUND_ERROR_CODES.refused,
      `refusing to fund: ${problems.join("; ")}. Mainnet is a human decision: set FUNDING=aurora, MAINNET_ENABLED=true and DEMO_CONFIRM in .env for today, then pass --confirm <that value>. Nothing was sent.`,
    );
  }
  return env.AURORA_API_KEY as string;
}

/** `FUND_MAX_USDC` as a number; unset is the default, anything unreadable is refused rather than read as unlimited. */
export function fundMaxUsdc(env: FundDeps["env"]): number {
  const raw = env.FUND_MAX_USDC;
  if (raw === undefined || raw === "") return DEFAULT_FUND_MAX_USDC;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) throw new FundRefusedError(FUND_ERROR_CODES.amount, "FUND_MAX_USDC is not a positive number");
  return n;
}

export interface ParsedAmount {
  /** Smallest units of a token with `decimals`. */
  readonly units: bigint;
  readonly usdc: string;
  readonly whole: boolean;
}

/** A decimal USDC string to smallest units, no float. Refused above the cap or at zero. */
export function parseUsdc(amount: string, decimals: number, maxUsdc: number): ParsedAmount {
  const m = /^(\d+)(?:\.(\d+))?$/.exec(amount.trim());
  if (m === null) throw new FundRefusedError(FUND_ERROR_CODES.amount, "--amount must be a decimal number of USDC, such as 2 or 2.5");
  const whole = m[1]!;
  const fraction = (m[2] ?? "").replace(/0+$/, "");
  if (fraction.length > decimals) throw new FundRefusedError(FUND_ERROR_CODES.amount, `--amount has more than ${decimals} decimals`);
  const units = BigInt(whole) * 10n ** BigInt(decimals) + BigInt((fraction + "0".repeat(decimals)).slice(0, decimals) || "0");
  if (units === 0n) throw new FundRefusedError(FUND_ERROR_CODES.amount, "--amount must be positive");
  // Compare in units so 5.000001 is over a cap of 5.
  const capUnits = BigInt(Math.round(maxUsdc * 10 ** decimals));
  if (units > capUnits) throw new FundRefusedError(FUND_ERROR_CODES.amount, `--amount ${amount} USDC is above FUND_MAX_USDC (${maxUsdc}); the cap is in code and in .env, not a default to raise lightly`);
  return { units, usdc: fraction.length === 0 ? whole : `${whole}.${fraction}`, whole: fraction.length === 0 };
}

/** Keeps well-formed entries only; a body with no token list is an error. */
export function parseTokens(body: unknown): AuroraToken[] {
  const tokens = isObject(body) ? body.tokens : undefined;
  if (!Array.isArray(tokens)) throw new FundRefusedError(FUND_ERROR_CODES.api, "Aurora's tokens response has no tokens array");
  return tokens.filter(
    (t): t is AuroraToken => isObject(t) && typeof t.assetId === "string" && typeof t.blockchain === "string" && typeof t.symbol === "string" && Number.isInteger(t.decimals) && (t.decimals as number) >= 0,
  );
}

/** Asset ids come from the list, never built by hand. Zero or several matches stop the run. */
export function findUsdc(tokens: readonly AuroraToken[], blockchain: string): AuroraToken {
  const matches = tokens.filter((t) => t.blockchain === blockchain && t.symbol === "USDC");
  if (matches.length !== 1) {
    const ids = matches.map((t) => t.assetId).join(", ") || "none";
    throw new FundRefusedError(FUND_ERROR_CODES.input, `expected one USDC on ${blockchain} in Aurora's supported tokens, found: ${ids}`);
  }
  return matches[0]!;
}

export function blockchainOf(from: string): string {
  const key = from.trim().toLowerCase();
  if (key === "") throw new FundRefusedError(FUND_ERROR_CODES.input, "--from names the origin chain (base, near, arbitrum, ethereum, or an Aurora blockchain id)");
  return CHAIN_ALIASES[key] ?? key;
}

/** The confidential quote, as the briefing §3b lists it: a public swap's request with `confidentiality: "advanced"`. */
export function buildQuoteRequest(params: { origin: AuroraToken; destination: AuroraToken; units: bigint; recipient: string; refundTo: string; now: Date }) {
  return {
    dry: false as const,
    confidentiality: "advanced" as const,
    swapType: "EXACT_INPUT" as const,
    originAsset: params.origin.assetId,
    destinationAsset: params.destination.assetId,
    amount: params.units.toString(),
    depositType: "ORIGIN_CHAIN" as const,
    recipient: params.recipient,
    recipientType: "DESTINATION_CHAIN" as const,
    refundTo: params.refundTo,
    refundType: "ORIGIN_CHAIN" as const,
    slippageTolerance: 100,
    deadline: new Date(params.now.getTime() + QUOTE_DEADLINE_MS).toISOString(),
  };
}

export interface QuoteFields {
  readonly depositAddress: string;
  readonly depositMemo?: string;
  /** When the deposit address goes inactive, as Aurora states it; absent when the quote does not say. */
  readonly deadline?: string;
  readonly amountOut?: string;
  readonly amountOutFormatted?: string;
}

export function parseQuote(body: unknown): QuoteFields {
  const quote = isObject(body) && isObject(body.quote) ? body.quote : undefined;
  if (quote === undefined || typeof quote.depositAddress !== "string" || quote.depositAddress === "") {
    throw new FundRefusedError(FUND_ERROR_CODES.api, "Aurora's quote carries no depositAddress (a dry quote, or a shape this module does not read)");
  }
  const str = (k: string) => (typeof quote[k] === "string" ? (quote[k] as string) : undefined);
  return {
    depositAddress: quote.depositAddress,
    ...(str("depositMemo") === undefined ? {} : { depositMemo: str("depositMemo") }),
    ...(str("deadline") === undefined ? {} : { deadline: str("deadline") }),
    ...(str("amountOut") === undefined ? {} : { amountOut: str("amountOut") }),
    ...(str("amountOutFormatted") === undefined ? {} : { amountOutFormatted: str("amountOutFormatted") }),
  };
}

export interface StatusFields {
  readonly status: FundStatus;
  readonly amountOut?: string;
  readonly amountOutFormatted?: string;
  readonly destinationTxHashes: readonly string[];
  readonly originTxHashes: readonly string[];
  readonly refundedAmountFormatted?: string;
  readonly refundReason?: string;
  /** Any message the API put beside a terminal state. */
  readonly message?: string;
}

/** The status body as the 1Click reference shapes it: `status` and `swapDetails`. Unknown statuses are kept polling, not read as success. */
export function parseStatus(body: unknown): StatusFields | undefined {
  if (!isObject(body) || typeof body.status !== "string" || !STATUSES.has(body.status)) return undefined;
  const details = isObject(body.swapDetails) ? body.swapDetails : {};
  const hashes = (value: unknown): string[] =>
    Array.isArray(value) ? value.map((v) => (isObject(v) && typeof v.hash === "string" ? v.hash : typeof v === "string" ? v : undefined)).filter((h): h is string => h !== undefined) : [];
  const str = (k: string, from: Record<string, unknown> = details) => (typeof from[k] === "string" ? (from[k] as string) : undefined);
  const message = str("message", body) ?? str("error", body) ?? str("message");
  return {
    status: body.status as FundStatus,
    ...(str("amountOut") === undefined ? {} : { amountOut: str("amountOut") }),
    ...(str("amountOutFormatted") === undefined ? {} : { amountOutFormatted: str("amountOutFormatted") }),
    destinationTxHashes: hashes(details.destinationChainTxHashes),
    originTxHashes: hashes(details.originChainTxHashes),
    ...(str("refundedAmountFormatted") === undefined ? {} : { refundedAmountFormatted: str("refundedAmountFormatted") }),
    ...(str("refundReason") === undefined ? {} : { refundReason: str("refundReason") }),
    ...(message === undefined ? {} : { message }),
  };
}

interface ApiResponse {
  readonly status: number;
  readonly body: unknown;
}

/** One Aurora call. The key is in the path, so a failure's text and a body that echoes the path are scrubbed before they can reach a line. */
async function call(deps: FundDeps, apiKey: string, base: string, path: string, init?: RequestInit): Promise<ApiResponse> {
  const url = `${base}/api/${path.replace("{API_KEY}", encodeURIComponent(apiKey))}`;
  let response: Response;
  let text: string;
  try {
    response = await deps.fetch(url, init);
    text = await response.text();
  } catch (error) {
    // No `cause`: it can hold the URL, and so the key.
    throw new FundRefusedError(FUND_ERROR_CODES.api, redactKey(`Aurora request failed: ${String(error)}`, apiKey));
  }
  const safe = redactKey(text, apiKey);
  try {
    return { status: response.status, body: JSON.parse(safe) };
  } catch {
    return { status: response.status, body: safe };
  }
}

function describe(response: ApiResponse): string {
  const body = typeof response.body === "string" ? response.body : JSON.stringify(response.body);
  return `HTTP ${response.status}: ${body.slice(0, 300)}`;
}

/** The arrival amount is what SUCCESS reports, else what the quote promised; smallest units, decimal string. */
function arrivalAmount(status: StatusFields, quote: QuoteFields): string {
  return status.amountOut ?? quote.amountOut ?? "0";
}

export async function fund(input: FundInput, deps: FundDeps): Promise<FundOutcome> {
  const now = deps.now ?? (() => new Date());
  const sleep = deps.sleep ?? defaultSleep;
  const random = deps.random ?? Math.random;
  const apiKey = assertFundingFlags(deps.env, input.confirm);
  const print = (line: string) => deps.print(redactKey(line, apiKey));
  const base = (deps.env.AURORA_API ?? AURORA_API).replace(/\/$/, "");

  const blockchain = blockchainOf(input.from);
  if (input.recipient.trim() === "") throw new FundRefusedError(FUND_ERROR_CODES.input, "the recipient (--to, or the public key of MAINNET_BUYER_KEYPAIR) is missing");
  if (input.refundTo.trim() === "") throw new FundRefusedError(FUND_ERROR_CODES.input, "--refund-to names the operator's wallet on the origin chain; a refund has to go somewhere");
  const maxUsdc = fundMaxUsdc(deps.env);
  // A first parse at six decimals so a bad amount is refused before any request; parsed again with the origin's decimals below.
  parseUsdc(input.amount, 6, maxUsdc);

  const listed = await call(deps, apiKey, base, "tokens/{API_KEY}");
  if (listed.status !== 200) throw new FundRefusedError(FUND_ERROR_CODES.api, `Aurora's supported-tokens endpoint answered ${describe(listed)}`);
  const tokens = parseTokens(listed.body);
  const origin = findUsdc(tokens, blockchain);
  const destination = findUsdc(tokens, DESTINATION_BLOCKCHAIN);
  const amount = parseUsdc(input.amount, origin.decimals, maxUsdc);
  if (!amount.whole) print(`warning: ${amount.usdc} USDC is not a whole number; a round amount is harder to pair with the channel deposit (docs/FUNDING.md)`);

  const request = buildQuoteRequest({ origin, destination, units: amount.units, recipient: input.recipient, refundTo: input.refundTo, now: now() });
  const refundDeadline = new Date(request.deadline);
  const quoted = await call(deps, apiKey, base, "quote/{API_KEY}", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(request) });
  if (quoted.status !== 200) throw new FundRefusedError(FUND_ERROR_CODES.api, `Aurora's quote answered ${describe(quoted)}`);
  const quote = parseQuote(quoted.body);

  print(`confidential quote: ${amount.usdc} USDC on ${blockchain} to ${input.recipient} on Solana${quote.amountOutFormatted === undefined ? "" : `, ${quote.amountOutFormatted} USDC after Aurora's fees`}`);
  print(`send exactly ${amount.usdc} USDC on ${blockchain} to the deposit address: ${quote.depositAddress}`);
  if (quote.depositMemo !== undefined) print(`with the deposit memo: ${quote.depositMemo}`);
  print(`refund deadline (sent with the quote): ${request.deadline}; refunds go to ${input.refundTo}`);
  if (quote.deadline !== undefined) print(`deposit address active until: ${quote.deadline}`);
  print(`polling Aurora's status until SUCCESS, FAILED or REFUNDED, at most until ${new Date(refundDeadline.getTime() + POLL_GRACE_MS).toISOString()}`);

  const stopAt = refundDeadline.getTime() + POLL_GRACE_MS;
  let delay = POLL_MIN_MS;
  let last: string | undefined;
  for (;;) {
    const polled = await call(deps, apiKey, base, `status/{API_KEY}?${new URLSearchParams({ depositAddress: quote.depositAddress, ...(quote.depositMemo === undefined ? {} : { depositMemo: quote.depositMemo }) })}`);
    const status = polled.status === 200 ? parseStatus(polled.body) : undefined;
    if (polled.status >= 400 && polled.status < 500 && polled.status !== 429 && polled.status !== 404) {
      print(`FAILED: Aurora's status endpoint refused the query, ${describe(polled)}`);
      return { status: "FAILED", exitCode: 1, depositAddress: quote.depositAddress };
    }
    if (status !== undefined && status.status !== last) {
      print(`status: ${status.status}`);
      last = status.status;
    }
    if (status !== undefined && TERMINAL.has(status.status)) return finish(status, quote, amount, blockchain, input, deps, print, now, sleep, random);
    if (now().getTime() >= stopAt) {
      print(`stopped polling: the refund deadline passed five minutes ago and the swap is ${last ?? "not reported"}; the deposit address is ${quote.depositAddress}, check it with Aurora before sending again`);
      return { status: "TIMEOUT", exitCode: 1, depositAddress: quote.depositAddress };
    }
    await sleep(Math.min(delay, Math.max(0, stopAt - now().getTime())));
    delay = Math.min(delay * 2, POLL_MAX_MS);
  }
}

async function finish(
  status: StatusFields,
  quote: QuoteFields,
  amount: ParsedAmount,
  blockchain: string,
  input: FundInput,
  deps: FundDeps,
  print: (line: string) => void,
  now: () => Date,
  sleep: (ms: number) => Promise<void>,
  random: () => number,
): Promise<FundOutcome> {
  if (status.status === "FAILED") {
    print(`FAILED: ${status.message ?? status.refundReason ?? "Aurora gave no reason"}; nothing arrived on Solana. A refund, if any, goes to ${input.refundTo}`);
    return { status: "FAILED", exitCode: 1, depositAddress: quote.depositAddress };
  }
  if (status.status === "REFUNDED") {
    const why = status.refundReason === undefined ? "" : ` (${status.refundReason})`;
    const how = status.refundedAmountFormatted === undefined ? "" : ` ${status.refundedAmountFormatted} USDC`;
    print(`REFUNDED:${how} returned to ${input.refundTo} on ${blockchain}${why}; nothing arrived on Solana${status.originTxHashes.length === 0 ? "" : `, ${status.originTxHashes.length} origin-chain transaction(s) reported`}`);
    return { status: "REFUNDED", exitCode: 0, depositAddress: quote.depositAddress };
  }
  const signature = status.destinationTxHashes[0];
  if (signature === undefined) {
    print("SUCCESS reported without a destination transaction; nothing recorded. Ask Aurora for the Solana arrival before depositing");
    return { status: "FAILED", exitCode: 1, depositAddress: quote.depositAddress };
  }
  const arrived = arrivalAmount(status, quote);
  const funding: FundingSource = { originChain: blockchain, amount: arrived, solanaArrivalSignature: signature };
  const at = now();
  deps.store.appendTrajectory({ vendor: "aurora", route: "fund", amount: arrived, cumulative: "0", timestamp: at.toISOString(), fundingSource: funding });
  print(`SUCCESS: ${status.amountOutFormatted ?? quote.amountOutFormatted ?? amount.usdc} USDC arrived at ${input.recipient}, Solana transaction ${shortSignature(signature)} (in full in the channel file's trajectory)`);

  const delayMs = input.noWait ? 0 : Math.floor(DEPOSIT_DELAY_MIN_MS + random() * (DEPOSIT_DELAY_MAX_MS - DEPOSIT_DELAY_MIN_MS));
  const depositAfter = new Date(at.getTime() + delayMs).toISOString();
  print(input.noWait ? "channel deposit: now (--no-wait)" : `channel deposit scheduled for ${depositAfter}, a randomised ${Math.round(delayMs / 1000)} s after the arrival`);
  if (delayMs > 0) await sleep(delayMs);
  if (deps.deposit !== undefined) await deps.deposit(funding);
  return { status: "SUCCESS", exitCode: 0, depositAddress: quote.depositAddress, funding, depositAfter };
}
