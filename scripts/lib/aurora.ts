// Task 2.2: what Aurora's quote and status endpoints answer for a confidential
// Solana destination. Quotes are always dry; nothing here moves funds.
import { randomBytes } from "node:crypto";
import { generateKeypairJson, publicKeyFromKeypairJson } from "./keypairs.js";

export const AURORA_API = "https://intents-api.aurora.dev";
export const REDACTED = "[redacted]";

function randomEvmAddress(): string {
  return `0x${randomBytes(20).toString("hex")}`;
}

// No key is held for either placeholder. Dry quotes create no swap to refund.
// Random, not a burn address: Aurora answers 400 "refundTo is not valid" to 0x…dEaD.
const PLACEHOLDER_BASE_REFUND = randomEvmAddress();
const PLACEHOLDER_NEAR_REFUND = "0".repeat(64);

const USDC_AMOUNT = 5n;
const DEADLINE_MS = 20 * 60 * 1000;

export const ORIGINS = [
  { name: "Base", blockchain: "base", refundTo: PLACEHOLDER_BASE_REFUND },
  { name: "NEAR", blockchain: "near", refundTo: PLACEHOLDER_NEAR_REFUND },
] as const;
const DESTINATION_BLOCKCHAIN = "sol";

export type AuroraToken = {
  assetId: string;
  decimals: number;
  blockchain: string;
  symbol: string;
  contractAddress?: string;
};

type ApiResponse = { status: number; body: unknown };

export type DryRunQuote = {
  origin: string;
  token: AuroraToken;
  request: ReturnType<typeof buildQuoteRequest>;
  response: ApiResponse;
};

/** The only fields kept from a `dry: false` quote; the rest of the response is dropped unread. */
export const LIVE_QUOTE_FIELDS = ["depositAddress", "depositMemo", "deadline", "timeWhenInactive"] as const;

export type LiveQuote = {
  origin: string;
  status: number;
  fields: Record<(typeof LIVE_QUOTE_FIELDS)[number], unknown>;
};

export type DryRunResult = {
  ranAt: string;
  destination: AuroraToken;
  quotes: DryRunQuote[];
  liveQuote?: LiveQuote;
  statusProbes: (ApiResponse & { depositAddress: string })[];
};

export type DryRunOptions = {
  /** One `dry: false` quote from NEAR, to see the deposit address and expiry. Nothing is sent to it. */
  liveQuote?: boolean;
};

export type DryRunDeps = {
  apiKey: string;
  fetch: typeof globalThis.fetch;
  now: () => Date;
};

export function redactKey(text: string, apiKey: string): string {
  return text.split(apiKey).join(REDACTED);
}

/** `quoteRequest.referral` names the Studio account behind the key. Redacted wherever it appears. */
export function redactReferral(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(redactReferral);
  if (value && typeof value === "object") {
    return Object.fromEntries(
      Object.entries(value).map(([k, v]) => [k, k === "referral" ? REDACTED : redactReferral(v)]),
    );
  }
  return value;
}

/** Keeps well-formed entries only; a body with no token list is an error. */
export function parseTokens(body: unknown): AuroraToken[] {
  const tokens = (body as { tokens?: unknown } | null)?.tokens;
  if (!Array.isArray(tokens)) throw new Error("Aurora tokens response has no tokens array");
  return tokens.filter(
    (t): t is AuroraToken =>
      typeof t?.assetId === "string" &&
      typeof t?.blockchain === "string" &&
      typeof t?.symbol === "string" &&
      Number.isInteger(t?.decimals) &&
      t.decimals >= 0,
  );
}

/** Asset ids come from the list, never built by hand. Zero or several matches stop the run. */
export function findUsdc(tokens: AuroraToken[], blockchain: string): AuroraToken {
  const matches = tokens.filter((t) => t.blockchain === blockchain && t.symbol === "USDC");
  if (matches.length !== 1) {
    const ids = matches.map((t) => t.assetId).join(", ") || "none";
    throw new Error(`Expected one USDC on ${blockchain}, found: ${ids}`);
  }
  return matches[0]!;
}

export function buildQuoteRequest(params: {
  origin: AuroraToken;
  destination: AuroraToken;
  recipient: string;
  refundTo: string;
  now: Date;
}) {
  return {
    dry: true as const,
    confidentiality: "advanced",
    swapType: "EXACT_INPUT",
    originAsset: params.origin.assetId,
    destinationAsset: params.destination.assetId,
    amount: (USDC_AMOUNT * 10n ** BigInt(params.origin.decimals)).toString(),
    depositType: "ORIGIN_CHAIN",
    recipient: params.recipient,
    recipientType: "DESTINATION_CHAIN",
    refundTo: params.refundTo,
    refundType: "ORIGIN_CHAIN",
    slippageTolerance: 100,
    deadline: new Date(params.now.getTime() + DEADLINE_MS).toISOString(),
  };
}

/** The secret half is discarded: nothing is ever sent to this address. */
function freshSolanaAddress(): string {
  return publicKeyFromKeypairJson(generateKeypairJson());
}

async function call(deps: DryRunDeps, path: string, init?: RequestInit): Promise<ApiResponse> {
  const url = `${AURORA_API}/api/${path.replace("{API_KEY}", encodeURIComponent(deps.apiKey))}`;
  let response: Response;
  let text: string;
  try {
    response = await deps.fetch(url, init);
    text = await response.text();
  } catch (error) {
    // eslint-disable-next-line preserve-caught-error -- the cause can hold the URL, and so the key.
    throw new Error(redactKey(`Aurora request failed: ${String(error)}`, deps.apiKey));
  }
  // Error bodies echo the request path, which holds the key.
  const safe = redactKey(text, deps.apiKey);
  try {
    return { status: response.status, body: redactReferral(JSON.parse(safe)) };
  } catch {
    return { status: response.status, body: safe };
  }
}

function describeFailure(what: string, response: ApiResponse): Error {
  return new Error(`${what} answered ${response.status}: ${JSON.stringify(response.body)}`);
}

function postQuote(deps: DryRunDeps, request: object): Promise<ApiResponse> {
  return call(deps, "quote/{API_KEY}", {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify(request),
  });
}

export async function runDryRun(deps: DryRunDeps, options: DryRunOptions = {}): Promise<DryRunResult> {
  const listed = await call(deps, "tokens/{API_KEY}");
  if (listed.status !== 200) throw describeFailure("Aurora tokens", listed);
  const tokens = parseTokens(listed.body);
  const destination = findUsdc(tokens, DESTINATION_BLOCKCHAIN);

  const quotes: DryRunQuote[] = [];
  for (const { name, blockchain, refundTo } of ORIGINS) {
    const token = findUsdc(tokens, blockchain);
    const request = buildQuoteRequest({
      origin: token,
      destination,
      recipient: freshSolanaAddress(),
      refundTo,
      now: deps.now(),
    });
    const response = await postQuote(deps, request);
    // 200 and 400 answer the question. 404, 429 and 500 say nothing about the route.
    if (response.status !== 200 && response.status !== 400) {
      throw describeFailure(`Aurora quote from ${name}`, response);
    }
    quotes.push({ origin: name, token, request, response });
  }

  let liveQuote: LiveQuote | undefined;
  if (options.liveQuote) {
    const near = quotes.find((q) => q.origin === "NEAR")!;
    const response = await postQuote(deps, { ...near.request, recipient: freshSolanaAddress(), dry: false });
    if (response.status !== 200) throw describeFailure("Aurora live quote from NEAR", response);
    const quote = (response.body as { quote?: Record<string, unknown> }).quote ?? {};
    const fields = Object.fromEntries(LIVE_QUOTE_FIELDS.map((f) => [f, quote[f]])) as LiveQuote["fields"];
    liveQuote = { origin: near.origin, status: response.status, fields };
  }

  const unknownAddresses = [randomEvmAddress(), freshSolanaAddress()];
  const statusProbes = [];
  for (const depositAddress of unknownAddresses) {
    const query = new URLSearchParams({ depositAddress });
    const response = await call(deps, `status/{API_KEY}?${query}`);
    statusProbes.push({ depositAddress, ...response });
  }

  return { ranAt: deps.now().toISOString(), destination, quotes, liveQuote, statusProbes };
}

/** Smallest units to a decimal string, no float. */
export function formatUnits(units: bigint, decimals: number): string {
  const s = units.toString().padStart(decimals + 1, "0");
  return decimals === 0 ? s : `${s.slice(0, -decimals)}.${s.slice(-decimals)}`;
}

function percentOf(part: bigint, whole: bigint): string {
  return `${(Number((part * 10_000n) / whole) / 100).toFixed(2)}%`;
}

function costLine(quote: DryRunQuote, destination: AuroraToken): string | undefined {
  if (quote.response.status !== 200) return undefined;
  // Amounts are decimal strings in smallest units; a 200 without them yields no cost line.
  const units = (field: string, fallback?: string) => {
    const raw = quoteField(quote, field) ?? fallback;
    return typeof raw === "string" && /^\d+$/.test(raw) ? BigInt(raw) : undefined;
  };
  const amountIn = units("amountIn");
  const amountOut = units("amountOut");
  const fee = units("withdrawFee", "0");
  if (amountIn === undefined || amountIn === 0n || amountOut === undefined || fee === undefined) return undefined;
  const spread = amountIn - amountOut;
  const usdc = (n: bigint) => `${formatUnits(n, destination.decimals)} USDC`;
  return `- **${quote.origin}:** ${usdc(amountIn)} in, ${usdc(amountOut)} out. \`withdrawFee\` ${usdc(fee)} (${percentOf(fee, amountIn)} of the input); total spread ${usdc(spread)} (${percentOf(spread, amountIn)}).`;
}

function fenced(value: unknown): string {
  const text = typeof value === "string" ? value : JSON.stringify(value, null, 2);
  return `\`\`\`json\n${text}\n\`\`\``;
}

function quoteField(quote: DryRunQuote, field: string): unknown {
  return (quote.response.body as { quote?: Record<string, unknown> } | null)?.quote?.[field];
}

function shown(value: unknown): string {
  return value === undefined || value === null ? "absent" : `\`${String(value)}\``;
}

function acceptanceLine(quote: DryRunQuote): string {
  if (quote.response.status === 200) {
    const out = String(quoteField(quote, "amountOutFormatted"));
    const min = String(quoteField(quote, "minAmountOut"));
    const fee = String(quoteField(quote, "withdrawFee"));
    return `- **${quote.origin}: yes.** 200 with \`confidentiality: "advanced"\`; 5 USDC in, ${out} USDC out, \`minAmountOut\` ${min} and \`withdrawFee\` ${fee} (smallest units).`;
  }
  // A 400 can object to any field, so it does not by itself say the route is refused.
  const message = (quote.response.body as { message?: unknown } | null)?.message;
  return `- **${quote.origin}: not established.** The request was rejected with 400: ${String(message ?? JSON.stringify(quote.response.body))}`;
}

export function renderDoc(result: DryRunResult): string {
  const q2 = result.quotes.map((quote) => {
    const fields = LIVE_QUOTE_FIELDS.map((f) => `\`quote.${f}\` ${shown(quoteField(quote, f))}`).join(", ");
    return `- **${quote.origin}** (${quote.response.status}): ${fields}.`;
  });
  const live = result.liveQuote
    ? `One \`dry: false\` quote from ${result.liveQuote.origin} (\`--live-quote\`) answered ${result.liveQuote.status}. Only these four fields were kept; nothing was sent to the address and the quote lapses at its deadline:

${LIVE_QUOTE_FIELDS.map((f) => `- \`quote.${f}\` ${shown(result.liveQuote!.fields[f])}`).join("\n")}`
    : "Run `pnpm exec tsx scripts/aurora-dry-run.ts --live-quote` for one real quote that shows them.";
  const costs = result.quotes.map((q) => costLine(q, result.destination)).filter((l) => l !== undefined);
  const q3 = result.statusProbes.map(
    (probe) => `\`${probe.depositAddress}\` answered HTTP ${probe.status} with this body:\n\n${fenced(probe.body)}`,
  );
  const responses = result.quotes.map(
    (quote) => `### Quote response: USDC on ${quote.origin}

Asset \`${quote.token.assetId}\`, from \`GET /api/tokens/${REDACTED}\`. Status ${quote.response.status}.

Request:

${fenced(quote.request)}

Response:

${fenced(quote.response.body)}`,
  );

  return `# Aurora dry-run

Task 2.2. Generated by \`scripts/aurora-dry-run.ts\` on ${result.ranAt}. Every quote is \`dry: true\`, no funds were sent, and the API key is redacted. Destination asset \`${result.destination.assetId}\`, from the supported-tokens endpoint. Each recipient is a fresh Solana address whose secret was discarded; each \`refundTo\` is a placeholder (a random Base address for Base, a NEAR implicit account for NEAR, since a Base address cannot be a NEAR refund). Aurora rejects \`0x000000000000000000000000000000000000dEaD\` as \`refundTo\` with 400 "refundTo is not valid" in both public and advanced mode, which is why the Base placeholder is random.

The privacy claim is against the public ledger. Confidential mode hides the funding origin and route from it; the Solana arrival is public. Three operators see inside in v1: the facilitator (vouchers), MagicBlock's enclave (private transfers), NEAR's private shard (funding origin and route).

## 1. Is Solana USDC accepted as a confidential destination from each origin?

${result.quotes.map(acceptanceLine).join("\n")}

## 2. What does the quote return for the deposit address and expiry?

${q2.join("\n")}

Aurora's API reference says \`dry: true\` omits \`depositAddress\`, \`timeWhenInactive\` and \`deadline\`, so a dry quote cannot show a deposit address's format or its real expiry. The \`deadline\` this run sent is echoed in \`quoteRequest.deadline\` below.

${live}

## 3. What does the status endpoint return for an unknown deposit address?

\`GET /api/status/${REDACTED}?depositAddress=...\`, one address in each format, neither ever issued by a quote.

${q3.join("\n\n")}

## Costs observed

From the 200 responses above, at 5 USDC in. Fees are read in the destination asset's units (both assets have ${result.destination.decimals} decimals here). Two quotes on one day; how the fee scales with amount is not known from this run.

${costs.length ? costs.join("\n") : "- No quote answered 200, so no cost is observed."}

## Responses

${responses.join("\n\n")}
`;
}
