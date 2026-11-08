// The vendor-signed terms receipt (briefing §3c): the buyer keeps it, so a vendor cannot
// later claim it quoted differently. It travels in exactly one place, `extra.termsReceipt`
// of the 402's shielded entry, and is never forwarded to the facilitator or logged.
import { createHash } from "node:crypto";
import { signMessage, verifyMessage, type VoucherKeypair } from "@wakeless/scheme";
import { activeIncidents, capitalBpsOf, shortId, type BuyerHistory } from "./history.js";
import { POLICY_ID, PREMIUM_BPS, terms, type Incident, type Terms } from "./policy.js";

/** The locked vocabulary (`docs/VOCABULARY.md`): these four labels and no others. */
export const LABELS = {
  standardPrice: "standard price",
  riskPremium: "risk premium",
  relationshipCapital: "relationship capital",
  fundingRequirement: "funding requirement",
} as const;

export interface Adjustment {
  readonly label: typeof LABELS.riskPremium | typeof LABELS.relationshipCapital;
  /** Signed basis points on the standard price: a premium is positive, capital negative. */
  readonly bps: number;
  /** The signed amount the adjustment moves the price by, atomic units, decimal string. */
  readonly amount: string;
  readonly evidence: string;
}

export interface UnsignedTermsReceipt {
  /** Atomic units, decimal u64 string. */
  readonly standardPrice: string;
  readonly adjustments: readonly Adjustment[];
  readonly price: string;
  readonly minDeposit: string;
  readonly fundingCalls: number;
  readonly policy: typeof POLICY_ID;
  /** `0x` + sha256 (hex) of the canonical inputs: buyer, standard price, clean periods, incidents, policy. Reproducible by the buyer. */
  readonly inputsDigest: string;
}

export interface TermsReceipt extends UnsignedTermsReceipt {
  /** Base58 Ed25519 by the vendor's `payTo` key over the 34-byte terms message. */
  readonly vendorSignature: string;
}

/** Domain separator: `T`, version 1. Distinct from the voucher (`0x56 0x01`) and the receipt (`0x52 0x01`). */
export const TERMS_MAGIC: readonly [number, number] = [0x54, 0x01];

/** JSON with keys sorted at every level, so the same receipt always hashes the same. */
export function canonicalJson(value: unknown): string {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(",")}]`;
  if (typeof value === "object" && value !== null) {
    return `{${Object.keys(value as Record<string, unknown>)
      .sort()
      .map((key) => `${JSON.stringify(key)}:${canonicalJson((value as Record<string, unknown>)[key])}`)
      .join(",")}}`;
  }
  return JSON.stringify(value);
}

function sha256(text: string): Buffer {
  return createHash("sha256").update(text, "utf8").digest();
}

/** The inputs the policy ran on, digested. The buyer is `null` for a quote to an unknown buyer. */
export function inputsDigestOf(input: { buyer: string | null; standardPrice: bigint; cleanPeriods: number; incidents: readonly Incident[] }): string {
  const canonical = canonicalJson({
    buyer: input.buyer,
    standardPrice: input.standardPrice.toString(),
    cleanPeriods: input.cleanPeriods,
    incidents: input.incidents.map((i) => ({ kind: i.kind, evidence: i.evidence, at: i.at })),
    policy: POLICY_ID,
  });
  return `0x${sha256(canonical).toString("hex")}`;
}

/** The 34 bytes a terms receipt signs: magic, then sha256 of the canonical unsigned receipt. */
export function termsMessage(unsigned: UnsignedTermsReceipt): Uint8Array {
  const out = new Uint8Array(34);
  out[0] = TERMS_MAGIC[0];
  out[1] = TERMS_MAGIC[1];
  out.set(sha256(canonicalJson(unsigned)), 2);
  return out;
}

export interface Quote {
  readonly terms: Terms;
  readonly unsigned: UnsignedTermsReceipt;
}

/** The terms and the unsigned receipt for a buyer from the vendor's history of it. An unknown buyer gets the standard terms. */
export function quoteFor(standardPrice: bigint, buyer: string | null, history: BuyerHistory | undefined): Quote {
  const incidents = activeIncidents(history);
  const capitalBps = capitalBpsOf(history);
  const cleanPeriods = history?.cleanPeriods ?? 0;
  const t = terms(standardPrice, incidents, capitalBps);
  const adjustments: Adjustment[] = [];
  if (capitalBps > 0) {
    const amount = (standardPrice * BigInt(capitalBps)) / 10000n;
    adjustments.push({ label: LABELS.relationshipCapital, bps: -capitalBps, amount: `-${amount}`, evidence: `${cleanPeriods} clean period${cleanPeriods === 1 ? "" : "s"}` });
  }
  for (const incident of incidents) {
    const bps = PREMIUM_BPS[incident.kind];
    adjustments.push({ label: LABELS.riskPremium, bps, amount: ((standardPrice * BigInt(bps)) / 10000n).toString(), evidence: `${incident.kind}: ${incident.evidence}` });
  }
  const unsigned: UnsignedTermsReceipt = {
    standardPrice: standardPrice.toString(),
    adjustments,
    price: t.price.toString(),
    minDeposit: t.minDeposit.toString(),
    fundingCalls: t.fundingCalls,
    policy: POLICY_ID,
    inputsDigest: inputsDigestOf({ buyer, standardPrice, cleanPeriods, incidents }),
  };
  return { terms: t, unsigned };
}

export function signTermsReceipt(signer: VoucherKeypair, unsigned: UnsignedTermsReceipt): TermsReceipt {
  return { ...unsigned, vendorSignature: signMessage(signer, termsMessage(unsigned)) };
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

const U64 = /^(0|[1-9][0-9]{0,19})$/;
const SIGNED_U64 = /^-?(0|[1-9][0-9]{0,19})$/;

/** A terms receipt from untrusted JSON: shape only. `verifyTermsReceipt` checks the signature. */
export function parseTermsReceipt(input: unknown): TermsReceipt | undefined {
  if (!isRecord(input)) return undefined;
  const { standardPrice, adjustments, price, minDeposit, fundingCalls, policy, inputsDigest, vendorSignature } = input;
  if (typeof standardPrice !== "string" || !U64.test(standardPrice) || typeof price !== "string" || !U64.test(price) || typeof minDeposit !== "string" || !U64.test(minDeposit)) return undefined;
  if (typeof fundingCalls !== "number" || !Number.isSafeInteger(fundingCalls) || fundingCalls < 1 || policy !== POLICY_ID) return undefined;
  if (typeof inputsDigest !== "string" || !/^0x[0-9a-f]{64}$/.test(inputsDigest) || typeof vendorSignature !== "string") return undefined;
  if (!Array.isArray(adjustments)) return undefined;
  const parsed: Adjustment[] = [];
  for (const a of adjustments) {
    if (!isRecord(a) || (a.label !== LABELS.riskPremium && a.label !== LABELS.relationshipCapital)) return undefined;
    if (typeof a.bps !== "number" || !Number.isSafeInteger(a.bps) || typeof a.amount !== "string" || !SIGNED_U64.test(a.amount) || typeof a.evidence !== "string") return undefined;
    parsed.push({ label: a.label, bps: a.bps, amount: a.amount, evidence: a.evidence });
  }
  return { standardPrice, adjustments: parsed, price, minDeposit, fundingCalls, policy: POLICY_ID, inputsDigest, vendorSignature };
}

/** Whether `receipt` carries the vendor's signature over its own fields. Never throws. */
export function verifyTermsReceipt(vendor: string | Uint8Array, receipt: TermsReceipt): boolean {
  const parsed = parseTermsReceipt(receipt);
  if (parsed === undefined) return false;
  const { vendorSignature, ...unsigned } = parsed;
  return verifyMessage(vendor, termsMessage(unsigned), vendorSignature);
}

/** The buyer named on the receipt's evidence lines and the card: never in full. */
export { shortId };
