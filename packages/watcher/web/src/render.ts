// Renders the side-by-side page into a root element. Pure apart from writing the root's
// children: no fetch, no storage. Every address shown is truncated to its first four and
// last four characters; amounts are USDC base units (6 decimals), as in docs/side-by-side.md.
import type { Edge, LeakHeadline, Rail, SideBySide, Trajectory } from "./data.js";

export interface Assets {
  /** Wordmark with near-black ink, for the light theme. */
  readonly wordmarkLight: string;
  /** Wordmark with off-white ink, for the dark theme. */
  readonly wordmarkDark: string;
}

function esc(s: string): string {
  return s.replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" })[c]!);
}

export function short(a: string): string {
  return a.length <= 9 ? a : `${a.slice(0, 4)}…${a.slice(-4)}`;
}

function usdc(base: string): string {
  const padded = base.padStart(7, "0");
  return `${padded.slice(0, -6)}.${padded.slice(-6)}`;
}

function iso(seconds: number | null | undefined): string {
  return seconds === undefined || seconds === null ? "—" : new Date(seconds * 1000).toISOString().replace(".000Z", "Z");
}

function railName(r: Rail): string {
  return r.rail === "public" ? "Public batch-settlement" : "Wakeless";
}

function headline(r: Rail): string {
  return `<div class="numbers">
  <div class="number" data-testid="per-call-${r.rail}">
    <span class="big">${esc(r.transactionsPerCall)}</span>
    <span class="caption">base-layer transactions per call<br />${r.railTransactions} / ${r.calls}</span>
  </div>
  <div class="number" data-testid="vendors-${r.rail}">
    <span class="big">${r.comparison.vendorsRecovered} / ${r.comparison.vendorsActual}</span>
    <span class="caption">vendors recovered / actual<br />spend recovered ${(r.comparison.spendRecoveredBps / 100).toFixed(2)}%</span>
  </div>
</div>`;
}

function observerTable(r: Rail): string {
  const o = r.observer;
  const summary = `<p class="meta">${o.signatures} signatures · ${o.onBaseLayer} on the base layer · ${o.notOnBaseLayer} not on the base layer</p>`;
  if (o.rows.length === 0) return `${summary}<p class="empty">No signatures.</p>`;
  const rows = o.rows
    .map((row, i) => {
      const seen = row.onBaseLayer
        ? [`${row.plaintextAmounts} amounts in clear`, `${row.plaintextRecipients} recipients named`, `${row.memos} memos`].join(" · ")
        : "not on the base layer";
      const checks = row.checksFailed.length === 0 ? "four checks pass" : `fails: ${row.checksFailed.map(esc).join(", ")}`;
      return `<li><span class="row-label">${i + 1}. ${esc(row.label)}</span><span class="row-meta">${seen}</span><span class="row-meta${row.checksFailed.length === 0 ? "" : " fail"}">${checks}</span></li>`;
    })
    .join("");
  return `${summary}<ol class="rows">${rows}</ol>`;
}

function vendorList(t: Trajectory, testid: string): string {
  if (t.firstContactOrder.length === 0) return `<p class="empty" data-testid="${testid}">No vendor.</p>`;
  const items = t.firstContactOrder.map((v) => `<li><code>${esc(short(v))}</code><span class="spend">${usdc(t.spendPerVendor[v] ?? "0")} USDC</span></li>`).join("");
  return `<ol class="vendors" data-testid="${testid}">${items}</ol>`;
}

function edgeList(edges: readonly Edge[]): string {
  if (edges.length === 0) return `<p class="empty" data-testid="edges">Vault edges: none in the window.</p>`;
  const items = edges
    .map((e) => `<li><code>${esc(short(e.from))}</code> → <code>${esc(short(e.to))}</code> <span class="spend">${usdc(e.amount)} USDC</span> <span class="row-meta">${iso(e.blockTime)}, unlinked to any payer</span></li>`)
    .join("");
  return `<p class="meta">Vault edges, readable and unlinked:</p><ul class="edges" data-testid="edges">${items}</ul>`;
}

function rebuiltPanel(r: Rail): string {
  const t = r.rebuilt;
  const payer = t.payer === undefined ? "payer: not recovered" : `payer: <code>${esc(short(t.payer))}</code>`;
  const body =
    r.rail === "wakeless"
      ? `${t.firstContactOrder.length === 0 ? `<p class="empty" data-testid="rebuilt-vendors-${r.rail}">Nothing. No vendor, no spend, no order.</p>` : vendorList(t, `rebuilt-vendors-${r.rail}`)}${edgeList(t.edges)}`
      : `<p class="meta">${payer} · vendors in first-contact order, with spend</p>${vendorList(t, `rebuilt-vendors-${r.rail}`)}`;
  return `<section class="panel" data-testid="rebuilt-${r.rail}"><h3>What an observer rebuilt</h3>${body}</section>`;
}

function chainColumn(r: Rail): string {
  return `<section class="column" data-testid="chain-${r.rail}">
  <h2>What the chain sees</h2>
  <p class="rail">${esc(railName(r))}</p>
  ${headline(r)}
  ${observerTable(r)}
  ${rebuiltPanel(r)}
</section>`;
}

function sum(amounts: readonly string[]): string {
  return amounts.reduce((acc, a) => acc + BigInt(a), 0n).toString();
}

/** What only the owner holds: the whole trajectory, and the gap between it and what the observer rebuilt. */
function ownerBlock(r: Rail): string {
  const t = r.actual;
  const total = sum(Object.values(t.spendPerVendor));
  const rebuilt = sum(Object.values(r.rebuilt.spendPerVendor));
  const gap =
    r.comparison.spendRecoveredBps === 10000
      ? "every vendor and every amount above is also in the observer's panel"
      : r.comparison.spendRecoveredBps === 0
        ? "none of the vendors and none of the spend above is in the observer's panel"
        : `the observer's panel holds ${usdc(rebuilt)} of this`;
  return `<div class="owner-rail" data-testid="owner-${r.rail}">
  <p class="rail">${esc(railName(r))}</p>
  <dl class="facts">
    <dt>payer</dt><dd><code>${esc(short(t.payer ?? "—"))}</code></dd>
    <dt>paid calls</dt><dd>${t.settlementTimes.length}, ${iso(t.settlementTimes[0])} to ${iso(t.settlementTimes.at(-1))}</dd>
    <dt>vendors</dt><dd>${t.firstContactOrder.length}</dd>
    <dt>spend</dt><dd data-testid="owner-total-${r.rail}">${usdc(total)} USDC${r.rail === "wakeless" ? ", fee shares included" : ""}</dd>
  </dl>
  ${vendorList(t, `owner-vendors-${r.rail}`)}
  <p class="meta gap" data-testid="owner-gap-${r.rail}">Against the ledger: ${gap}.</p>
</div>`;
}

function ownerColumn(d: SideBySide): string {
  return `<section class="column owner" data-testid="owner">
  <h2>What the owner sees</h2>
  <p class="meta">The owner's own record of the same workload, held locally: every vendor in the order first paid, the spend, the time of every call. On Wakeless this is the only copy outside the operators.</p>
  ${ownerBlock(d.wakeless)}
  ${ownerBlock(d.publicRail)}
</section>`;
}

function leakStrip(h: LeakHeadline): string {
  const more = [
    h.channels === undefined ? undefined : `${h.channels} channels`,
    h.payers === undefined ? undefined : `${h.payers} payers`,
    h.payTo === undefined ? undefined : `${h.payTo} payTo`,
  ].filter((x): x is string => x !== undefined);
  return `<aside class="strip" data-testid="leak-strip">
  <strong>On mainnet today: ${h.relationships} public relationships</strong>
  <span>${more.length > 0 ? `${more.join(" · ")} · ` : ""}sample: ${h.signaturesScanned} signatures scanned, snapshot ${esc(h.date)} (<code>docs/leak/${esc(h.file)}</code>)</span>
</aside>`;
}

export function renderPage(root: Element, d: SideBySide, leak: LeakHeadline | undefined, assets: Assets): void {
  root.innerHTML = `${leak === undefined ? "" : leakStrip(leak)}
<header class="masthead">
  <picture>
    <source srcset="${esc(assets.wordmarkDark)}" media="(prefers-color-scheme: dark)" />
    <img class="wordmark" src="${esc(assets.wordmarkLight)}" alt="Wakeless" />
  </picture>
  <h1>Side by side: the same agent workload on both rails</h1>
  <p class="meta">Solana devnet, ${esc(d.date)}. ${esc(d.workload)} Amounts in USDC; addresses truncated to four and four.</p>
</header>
<div class="columns">
  ${chainColumn(d.publicRail)}
  ${chainColumn(d.wakeless)}
  ${ownerColumn(d)}
</div>
<section class="difference" data-testid="difference">
  <h2>The difference</h2>
  <p>${esc(d.difference)}</p>
</section>
<footer class="trust" data-testid="trust-boundary">
  <h2>Trust boundary</h2>
  <p>${esc(d.trustBoundary)}</p>
</footer>`;
}
