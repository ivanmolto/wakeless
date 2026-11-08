// The terminal receipt card of briefing §3c. The vendor's own terminal and the buyer's:
// it carries the buyer's address shortened and amounts in the asset's units, which never
// go in a log.
import { shortId } from "./history.js";
import { LABELS, type TermsReceipt } from "./receipt.js";

export interface CardOptions {
  /** `GET /price/:symbol`. */
  readonly route: string;
  /** The buyer the quote is for, base58; `null` for a quote to an unknown buyer. */
  readonly buyer: string | null;
  /** How the signing vendor is named on the card, e.g. `vendor1`. */
  readonly signedBy: string;
  /** Decimals of the asset (6 for USDC) and its symbol. */
  readonly decimals?: number;
  readonly symbol?: string;
}

const WIDTH = 65;

export function formatUnits(value: bigint | string, decimals = 6): string {
  const n = BigInt(value);
  const sign = n < 0n ? "-" : "";
  const abs = n < 0n ? -n : n;
  const whole = abs / 10n ** BigInt(decimals);
  const frac = (abs % 10n ** BigInt(decimals)).toString().padStart(decimals, "0");
  return `${sign}${whole}.${frac}`;
}

function row(left: string, right: string): string {
  const pad = Math.max(1, WIDTH - left.length - right.length);
  return `  ${left}${" ".repeat(pad)}${right}`;
}

/** The card as a list of lines, so two can be printed side by side. */
export function termsCardLines(receipt: TermsReceipt, options: CardOptions): string[] {
  const decimals = options.decimals ?? 6;
  const symbol = options.symbol ?? "USDC";
  const money = (v: bigint | string) => `${formatUnits(v, decimals)} ${symbol}`;
  const lines: string[] = [];
  lines.push(row(`WAKELESS TERMS · ${options.route}`, `buyer ${options.buyer === null ? "unknown" : shortId(options.buyer)}`));
  lines.push(`  ${"─".repeat(WIDTH)}`);
  lines.push(row(LABELS.standardPrice.toUpperCase(), money(receipt.standardPrice)));
  for (const a of receipt.adjustments) {
    const label = a.label === LABELS.relationshipCapital ? "Relationship capital" : "Risk premium";
    const bps = `${Math.abs(a.bps)} bps`;
    const amount = `${a.amount.startsWith("-") ? "−" : "+"}${formatUnits(a.amount.replace(/^-/, ""), decimals)}`;
    const evidence = a.evidence.length > 24 ? `${a.evidence.slice(0, 23)}…` : a.evidence;
    lines.push(row(`  ${label.padEnd(22)} ${evidence.padEnd(24)} ${bps.padStart(9)}`, amount));
  }
  lines.push(row("PRICE", money(receipt.price)));
  lines.push(row(`${LABELS.fundingRequirement.toUpperCase()}    ${receipt.fundingCalls} calls`, money(receipt.minDeposit)));
  lines.push(row(`POLICY  ${receipt.policy}        inputs ${receipt.inputsDigest.slice(0, 6)}…`, `signed: ${options.signedBy}`));
  lines.push(row("ON THE LEDGER", "nothing"));
  lines.push(`  ${"─".repeat(WIDTH)}`);
  return lines;
}

export function renderTermsCard(receipt: TermsReceipt, options: CardOptions): string {
  return termsCardLines(receipt, options).join("\n");
}

/** Two cards (or any two blocks of lines) beside each other. */
export function sideBySide(left: readonly string[], right: readonly string[], gap = 4): string {
  const width = Math.max(...left.map((l) => l.length));
  const rows = Math.max(left.length, right.length);
  const out: string[] = [];
  for (let i = 0; i < rows; i++) out.push(`${(left[i] ?? "").padEnd(width)}${" ".repeat(gap)}${right[i] ?? ""}`.trimEnd());
  return out.join("\n");
}
