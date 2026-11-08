// The landing page's numbers and paragraphs, read from the documents that hold them
// (README.md, docs/side-by-side.json, the leakage snapshot docs/LEAKAGE.md names) at build
// time. The landing writes no number of its own; `test/landing.test.ts` checks each one
// against its source. A pattern that stops matching fails the build.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { toString } from "mdast-util-to-string";
import { ROOT, codeContaining, intro, paragraphStartingWith, readTree, section } from "./markdown.js";
import { leakageSnapshotDate } from "./pages.js";

export interface LandingData {
  /** README intro: the first sentence, and the status line. */
  tagline: string;
  status: string;
  /** README "Why hide the relationship": the problem paragraph, the "calls are the plan" paragraph and its list, and the baseline paragraph. */
  problem: string;
  trajectory: { lead: string; verticals: { title: string; consequence: string }[] };
  whyHide: string;
  /** README "Trust boundary": the opening paragraph. */
  trust: string;
  sideBySide: {
    date: string;
    calls: number;
    vendors: number;
    public: RailSummary;
    wakeless: RailSummary;
  };
  agentRun: { paidRequests: number; deposits: number; baseLayerTransactions: number; source: string };
  terms: {
    date: string;
    known: { buyer: string; cleanPeriods: number; capitalBps: number; price: string; fundingCalls: number; minDeposit: string };
    unknown: { buyer: string; price: string; fundingCalls: number; minDeposit: string };
  };
  leak: {
    date: string;
    signaturesScanned: number;
    oldest: string;
    newest: string;
    channels: number;
    payers: number;
    payTo: number;
    relationships: number;
    payersWithTwoOrMorePayTo: number;
    channelsWithSettlement: number;
    medianChannelsPerPayer: number;
    maxChannelsPerPayer: number;
    largestPayToPayers: number;
    trajectory: { payer: string; vendors: number; channels: number; settlements: number; first: string; last: string };
  };
}

export interface RailSummary {
  transactions: number;
  perCall: string;
  vendorsRecovered: number;
  vendorsActual: number;
  spendRecoveredPercent: string;
  orderRecovered: boolean;
}

function must(re: RegExp, text: string, what: string): RegExpExecArray {
  const m = re.exec(text);
  if (!m) throw new Error(`landing data: ${what} not found`);
  return m;
}

function rail(raw: Record<string, unknown>): RailSummary {
  const c = raw["comparison"] as Record<string, unknown>;
  return {
    transactions: Number(raw["railTransactions"]),
    perCall: String(raw["transactionsPerCall"]),
    vendorsRecovered: Number(c["vendorsRecovered"]),
    vendorsActual: Number(c["vendorsActual"]),
    spendRecoveredPercent: (Number(c["spendRecoveredBps"]) / 100).toFixed(2),
    orderRecovered: Boolean(c["orderRecovered"]),
  };
}

export function buildLandingData(): LandingData {
  const readmeText = readFileSync(join(ROOT, "README.md"), "utf8");
  const readme = readTree("README.md");
  const lead = intro(readme);
  const first = lead.find((n) => n.type === "paragraph");
  if (!first) throw new Error("README has no intro paragraph");
  const firstText = toString(first);
  const tagline = firstText.slice(0, firstText.indexOf(". ") + 1);
  const status = toString(paragraphStartingWith(lead, "Status:"));

  const whySection = section(readme, "Why hide the relationship", false);
  const why = whySection.filter((n) => n.type === "paragraph");
  const problem = why.find((p) => toString(p).startsWith("x402 lets agents pay"));
  const callsLead = why.find((p) => toString(p).startsWith("The calls are the plan."));
  const baseline = why.find((p) => toString(p).startsWith("Hidden amounts are the baseline"));
  if (!problem || !callsLead || !baseline) throw new Error("README: 'Why hide the relationship' is missing one of its three paragraphs");
  const list = whySection.find((n) => n.type === "list");
  if (!list || list.type !== "list") throw new Error("README: 'Why hide the relationship' has no list of verticals");
  const verticals = list.children.map((li) => {
    const text = toString(li);
    const i = text.indexOf(": ");
    if (i < 0) throw new Error(`README vertical without a colon: ${text}`);
    return { title: text.slice(0, i), consequence: text.slice(i + 2) };
  });
  if (verticals.length !== 6) throw new Error(`README: six verticals expected, ${verticals.length} found`);
  // The paragraph's last sentence introduces the numbered list ("…in v1:"); the landing shows the sentences before it.
  const trust = toString(section(readme, "Trust boundary", false).find((n) => n.type === "paragraph")!).replace(/\s*[^.]*:$/, "");

  const sbs = JSON.parse(readFileSync(join(ROOT, "docs/side-by-side.json"), "utf8")) as Record<string, unknown>;
  const pub = sbs["public"] as Record<string, unknown>;
  const wak = sbs["wakeless"] as Record<string, unknown>;
  const vendors = Number(must(/across (\w+) vendors/, String(sbs["workload"]), "side-by-side vendor count")[1]!.replace("three", "3"));

  const run = must(/made (\d+) paid requests with (\d+) deposits and (\d+) base-layer transactions/, readmeText, "agent run numbers");
  const runSource = must(/\[`(docs\/runs\/run-\d+\.md)`\]/, readmeText, "agent run document")[1]!;

  const termsSection = section(readme, "Relationship terms (experimental)", false);
  const cards = toString(codeContaining(termsSection, "WAKELESS TERMS"));
  const buyers = [...cards.matchAll(/buyer (\S+)/g)].map((m) => m[1]!);
  if (buyers.length !== 2) throw new Error("landing data: two term cards expected");
  const capital = must(/Relationship capital\s+(\d+) clean periods\s+(\d+) bps/, cards, "relationship capital line");
  const knownPrice = must(/^\s*PRICE\s+([\d.]+) USDC/m, cards, "known buyer price")[1]!;
  const unknownPrice = must(/bps\s+\S+\s+PRICE\s+([\d.]+) USDC/, cards, "unknown buyer price")[1]!;
  const funding = [...cards.matchAll(/FUNDING REQUIREMENT\s+(\d+) calls\s+([\d.]+) USDC/g)];
  if (funding.length !== 2) throw new Error("landing data: two funding requirement lines expected");
  // The right card's funding line comes first (it sits one row higher); the left card's second.
  const [unknownFunding, knownFunding] = funding as [RegExpExecArray, RegExpExecArray];
  const termsDate = must(/`pnpm terms:demo` \(devnet, ([^)]+)\)/, readmeText, "terms demo date")[1]!;

  const leakDate = leakageSnapshotDate();
  const snap = JSON.parse(readFileSync(join(ROOT, `docs/leak/snapshot-${leakDate}.json`), "utf8")) as Record<string, unknown>;
  const headline = snap["headline"] as Record<string, number>;
  const sample = snap["sample"] as Record<string, unknown>;
  const settled = snap["settled"] as Record<string, unknown>;
  const perPayer = snap["channelsPerPayer"] as Record<string, unknown>;
  const degree = snap["payToDegree"] as unknown[];
  const traj = snap["sampleTrajectory"] as Record<string, unknown>;
  const times = traj["settlementTimes"] as number[];
  const iso = (s: number) => new Date(s * 1000).toISOString();
  const top = (degree[0] ?? {}) as Record<string, unknown>;

  return {
    tagline,
    status,
    problem: toString(problem),
    trajectory: { lead: toString(callsLead), verticals },
    whyHide: toString(baseline),
    trust,
    sideBySide: { date: String(sbs["date"]), calls: Number(pub["calls"]), vendors, public: rail(pub), wakeless: rail(wak) },
    agentRun: { paidRequests: Number(run[1]), deposits: Number(run[2]), baseLayerTransactions: Number(run[3]), source: runSource },
    terms: {
      date: termsDate,
      known: { buyer: buyers[0]!, cleanPeriods: Number(capital[1]), capitalBps: Number(capital[2]), price: knownPrice, fundingCalls: Number(knownFunding[1]), minDeposit: knownFunding[2]! },
      unknown: { buyer: buyers[1]!, price: unknownPrice, fundingCalls: Number(unknownFunding[1]), minDeposit: unknownFunding[2]! },
    },
    leak: {
      date: leakDate,
      signaturesScanned: headline["signaturesScanned"]!,
      oldest: String(sample["oldest"]),
      newest: String(sample["newest"]),
      channels: headline["channels"]!,
      payers: headline["payers"]!,
      payTo: headline["payTo"]!,
      relationships: headline["relationships"]!,
      payersWithTwoOrMorePayTo: headline["payersWithTwoOrMorePayTo"]!,
      channelsWithSettlement: Number(settled["channelsWithSettlement"] ?? settled["count"] ?? 0),
      medianChannelsPerPayer: Number(perPayer["median"]),
      maxChannelsPerPayer: Number(perPayer["max"]),
      largestPayToPayers: Number(top["payers"] ?? top["distinctPayers"] ?? 0),
      trajectory: {
        payer: String(traj["payer"]),
        vendors: (traj["vendors"] as unknown[]).length,
        channels: Number(traj["channels"]),
        settlements: times.length,
        first: iso(Math.min(...times)),
        last: iso(Math.max(...times)),
      },
    },
  };
}
