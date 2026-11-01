import { createHash } from "node:crypto";

/**
 * Synthetic data, plausible and made up, and marked `synthetic: true` in every
 * body. Everything is a function of the seed, the symbol and how many times that
 * symbol was asked for: no wall clock and no randomness, so the same seed gives
 * the same sequence of responses. `asOf` is a logical time, one minute per step.
 */

const EPOCH_MS = Date.UTC(2026, 0, 1);

export const SYMBOL = /^[A-Z0-9]{1,12}$/;

/** Uniform in `[0, 1)`, from 48 bits of a hash of the inputs. */
function uniform(...parts: readonly (string | number)[]): number {
  return createHash("sha256").update(parts.join("|")).digest().readUIntBE(0, 6) / 2 ** 48;
}

function asOf(step: number): string {
  return new Date(EPOCH_MS + step * 60_000).toISOString();
}

/** Counts the requests per symbol: the next one sees the next step. */
function stepper(): (symbol: string) => number {
  const steps = new Map<string, number>();
  return (symbol) => {
    const step = (steps.get(symbol) ?? -1) + 1;
    steps.set(symbol, step);
    return step;
  };
}

export interface PricePoint {
  readonly symbol: string;
  readonly price: number;
  readonly currency: "USD";
  readonly step: number;
  readonly asOf: string;
  readonly synthetic: true;
}

/** A multiplicative random walk per symbol, moving at most 1.5% a step from a start between 1 and 500. */
export function priceFeed(seed: string): (symbol: string) => PricePoint {
  const next = stepper();
  const prices = new Map<string, number>();
  return (symbol) => {
    const step = next(symbol);
    const previous = prices.get(symbol) ?? 1 + uniform(seed, "start", symbol) * 499;
    const price = step === 0 ? previous : previous * (1 + (uniform(seed, "price", symbol, step) - 0.5) * 0.03);
    prices.set(symbol, price);
    return { symbol, price: Number(price.toFixed(4)), currency: "USD", step, asOf: asOf(step), synthetic: true };
  };
}

export interface SentimentPoint {
  readonly symbol: string;
  /** `-1` bearish to `1` bullish. */
  readonly sentiment: number;
  readonly label: "bearish" | "neutral" | "bullish";
  readonly sampleSize: number;
  readonly step: number;
  readonly asOf: string;
  readonly synthetic: true;
}

export function sentimentFeed(seed: string): (symbol: string) => SentimentPoint {
  const next = stepper();
  return (symbol) => {
    const step = next(symbol);
    const sentiment = Number((uniform(seed, "sentiment", symbol, step) * 2 - 1).toFixed(3));
    return {
      symbol,
      sentiment,
      label: sentiment > 0.2 ? "bullish" : sentiment < -0.2 ? "bearish" : "neutral",
      sampleSize: 50 + Math.floor(uniform(seed, "sample", symbol, step) * 950),
      step,
      asOf: asOf(step),
      synthetic: true,
    };
  };
}

const HEADLINES: readonly ((symbol: string) => string)[] = [
  (s) => `${s} liquidity deepens across major venues`,
  (s) => `Developers ship a new release for the ${s} ecosystem`,
  (s) => `Analysts split on the ${s} outlook after a quiet week`,
  (s) => `${s} volumes thin out ahead of the weekend`,
  (s) => `Large holders rotate into ${s}, on-chain trackers say`,
  (s) => `Exchange adds new ${s} pairs for spot traders`,
  (s) => `${s} community votes on a treasury proposal`,
  (s) => `Market makers widen ${s} spreads as volatility returns`,
];

export interface NewsItem {
  readonly id: string;
  readonly headline: string;
  readonly source: "Synthetic Wire";
  readonly publishedAt: string;
}

export interface NewsPage {
  readonly symbol: string;
  readonly items: readonly NewsItem[];
  readonly step: number;
  readonly asOf: string;
  readonly synthetic: true;
}

export function newsFeed(seed: string): (symbol: string) => NewsPage {
  const next = stepper();
  return (symbol) => {
    const step = next(symbol);
    const items = [0, 1, 2].map((slot) => {
      const headline = HEADLINES[Math.floor(uniform(seed, "news", symbol, step, slot) * HEADLINES.length)]!(symbol);
      return {
        id: createHash("sha256").update(`${seed}|${symbol}|${step}|${slot}`).digest("hex").slice(0, 12),
        headline,
        source: "Synthetic Wire" as const,
        publishedAt: asOf(step - slot * 7),
      };
    });
    return { symbol, items, step, asOf: asOf(step), synthetic: true };
  };
}
