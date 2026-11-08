// The landing (variant B, reviewed 8 Nov 2026). Every number and every quoted paragraph
// comes from content/landing.json, which scripts/landing-data.ts reads from the README, the
// side-by-side JSON and the leakage snapshot at build time. Bright is what the observer
// recovered; dim is what it did not, and the page keeps to that rule everywhere. No project
// but Wakeless and its rail's operators is named here; the prior-art table lives in the docs.
import { buttonVariants } from "fumadocs-ui/components/ui/button";
import Link from "next/link";
import data from "@/content/landing.json";
import { GITHUB_URL } from "@/components/home";

const d = data;
const day = (iso: string) => iso.slice(0, 10);
const fmt = (n: number) => n.toLocaleString("en-US");
const pct = (s: string) => `${Number(s).toFixed(0)}%`;

function Eyebrow({ children }: { children: React.ReactNode }) {
  return <div className="mb-3 text-xs uppercase tracking-[.14em] text-fd-muted-foreground">{children}</div>;
}

function H2({ children }: { children: React.ReactNode }) {
  return <h2 className="max-w-[760px] text-3xl font-semibold leading-tight tracking-tight md:text-4xl">{children}</h2>;
}

function Section({ id, children, className = "" }: { id?: string; children: React.ReactNode; className?: string }) {
  return (
    <section id={id} className={`border-b border-fd-border ${className}`}>
      <div className="mx-auto max-w-[1200px] px-6 py-16 md:px-12 md:py-20">{children}</div>
    </section>
  );
}

function Tag({ children, lit = false }: { children: React.ReactNode; lit?: boolean }) {
  return (
    <span className={`inline-block rounded-md border px-2 py-0.5 text-[11px] uppercase tracking-[.08em] ${lit ? "border-fd-foreground text-fd-foreground" : "border-fd-border text-fd-muted-foreground"}`}>
      {children}
    </span>
  );
}

function Chip({ label, value, lit = false }: { label: string; value: string; lit?: boolean }) {
  return (
    <span className={`rounded-md border px-2 py-1 text-xs ${lit ? "border-fd-foreground text-fd-foreground" : "border-fd-border text-fd-muted-foreground"}`}>
      {label}
      <b className="ml-1.5 font-medium text-fd-foreground">{value}</b>
    </span>
  );
}

function Bar({ pct, dim = false }: { pct: number; dim?: boolean }) {
  return (
    <span className={`relative mt-1 block h-1.5 overflow-hidden rounded-full bg-fd-border ${dim ? "opacity-60" : ""}`}>
      <i className="absolute inset-y-0 left-0 rounded-full bg-fd-foreground" style={{ width: `${pct}%` }} />
    </span>
  );
}

function Rank({ n, label, value, pct, dim = false }: { n: number; label: string; value: string; pct: number; dim?: boolean }) {
  return (
    <div className={`grid grid-cols-[16px_1fr_auto] items-center gap-2.5 py-1.5 text-[13px] ${dim ? "text-fd-muted-foreground" : ""}`}>
      <span className="text-fd-muted-foreground">{n}</span>
      <span>
        {label}
        <Bar pct={pct} dim={dim} />
      </span>
      <span className="tabular-nums">{value}</span>
    </div>
  );
}

function Card({ children, lit = false, className = "" }: { children: React.ReactNode; lit?: boolean; className?: string }) {
  return <div className={`flex flex-col rounded-2xl border bg-fd-card p-6 ${lit ? "border-fd-foreground" : "border-fd-border"} ${className}`}>{children}</div>;
}

function Tile({ k, title, value, sub }: { k: string; title: string; value: string; sub: React.ReactNode }) {
  return (
    <div className="rounded-xl border border-fd-border bg-fd-card p-4">
      <div className="text-[10px] uppercase tracking-[.12em] text-fd-muted-foreground">{k}</div>
      <div className="mt-2 text-sm text-fd-muted-foreground">{title}</div>
      <div className="mt-1 text-3xl font-semibold tracking-tighter tabular-nums text-fd-muted-foreground">{value}</div>
      <div className="mt-2.5 grid gap-1 border-t border-fd-border pt-2.5 text-xs text-fd-muted-foreground">{sub}</div>
    </div>
  );
}

const Row = ({ l, r }: { l: string; r: string }) => (
  <span className="flex justify-between">
    <span>{l}</span>
    <i className="not-italic">{r}</i>
  </span>
);

export default function Landing() {
  const sbs = d.sideBySide;
  const pub = sbs.public;
  const wak = sbs.wakeless;
  const t = d.terms;
  const leak = d.leak;
  const run = d.agentRun;
  const knownPrice = Number(t.known.price);
  const unknownPrice = Number(t.unknown.price);
  const pricePct = (p: number) => Math.round((p / Math.max(knownPrice, unknownPrice)) * 100);
  const callsPct = (c: number) => Math.round((c / Math.max(t.known.fundingCalls, t.unknown.fundingCalls)) * 100);
  const recovered = `${wak.vendorsRecovered} / ${wak.vendorsActual}`;

  return (
    <main className="flex-1">
      {/* 1. Hero and the recorded proof */}
      <Section>
        <div className="mb-9 inline-flex flex-wrap items-center gap-2.5 rounded-full border border-fd-border py-1.5 pl-1.5 pr-3.5 text-[13px] text-fd-muted-foreground">
          <b className="rounded-full bg-fd-foreground px-2.5 py-0.5 text-[11px] font-semibold tracking-wide text-fd-background">Devnet alpha</b>
          <span>
            {sbs.calls} paid calls. {sbs.vendors} vendors. {wak.vendorsRecovered === 0 ? "Zero" : wak.vendorsRecovered} vendors recovered from the ledger.
          </span>
        </div>
        <div className="grid items-center gap-12 md:grid-cols-2">
          <div>
            <Eyebrow>Shielded payment channels for agents on x402</Eyebrow>
            <h1 className="text-5xl font-semibold leading-[1.02] tracking-[-.03em] md:text-6xl">Pay your vendors without publishing your plan.</h1>
            <p className="mt-6 max-w-[540px] text-[17px] text-fd-muted-foreground">
              An agent&apos;s paid tool calls reveal its strategy: which vendors it uses, how much it spends, and in what order. Wakeless keeps those relationships off the public ledger with shielded payment channels built around x402.
            </p>
            <div className="mt-8 flex flex-wrap gap-3">
              <Link href="/docs/how-it-works" className={buttonVariants({ variant: "primary" })}>
                Open the recorded run
              </Link>
              <Link href="/#thesis" className={buttonVariants({ variant: "secondary" })}>
                Read the thesis
              </Link>
              <Link href="/docs" className={buttonVariants({ variant: "secondary" })}>
                Docs
              </Link>
            </div>
            <p className="mt-11 max-w-[460px] border-l-2 border-fd-foreground pl-4 text-sm text-fd-muted-foreground">
              Others hide how much an agent paid. Wakeless hides that too, and whom it paid, and in what order.
            </p>
          </div>
          <Card>
            <div className="flex flex-wrap items-center gap-2.5">
              <Tag>Recorded run</Tag>
              <span className="text-xs text-fd-muted-foreground">
                Side by side · Solana devnet · {sbs.date} · {sbs.calls} calls, {sbs.vendors} vendors
              </span>
            </div>
            <div className="mt-6 text-xs uppercase tracking-[.14em] text-fd-muted-foreground">What the observer recovered, from the ledger alone</div>
            <div className="mt-2 flex items-baseline justify-between">
              <div className="text-[28px] font-semibold tracking-tight">Wakeless</div>
              <div className="text-right">
                <div className="text-[11px] uppercase tracking-[.1em] text-fd-muted-foreground">vendors recovered</div>
                <div className="text-[52px] font-semibold leading-none tracking-[-.04em] tabular-nums">
                  {wak.vendorsRecovered}
                  <span className="text-[28px] text-fd-muted-foreground"> / {wak.vendorsActual}</span>
                </div>
              </div>
            </div>
            <Bar pct={(wak.vendorsRecovered / wak.vendorsActual) * 100} />
            <p className="mt-4 text-xs text-fd-muted-foreground">
              <code>reconstruct()</code> was handed the run&apos;s signatures and nothing else: no payer, no vendor, no spend, no settlement time. The public <code>batch-settlement</code> rail, same workload: {pub.vendorsRecovered} of {pub.vendorsActual} vendors, {pct(pub.spendRecoveredPercent)} of spend, first-contact order.
            </p>
            <div className="mt-4 flex flex-wrap gap-2">
              <Chip label="Base-layer tx per call" value={wak.perCall} lit />
              <Chip label="Spend recovered" value={pct(wak.spendRecoveredPercent)} lit />
              <Chip label="First-contact order" value={wak.orderRecovered ? "yes" : "no"} lit />
              <Chip label="No vendor address" value="pass" />
              <Chip label="No vendor amount" value="pass" />
              <Chip label="No Memo" value="pass" />
              <Chip label="No fee to vendor" value="pass" />
            </div>
            <div className="mt-5 flex justify-between text-xs text-fd-muted-foreground">
              <Link href="/docs/how-it-works" className="border-b border-fd-foreground text-fd-foreground">
                Open the run
              </Link>
              <span>Bright is what the observer recovered. Dim is what it did not.</span>
            </div>
          </Card>
        </div>
      </Section>

      {/* 2. Recorded runs */}
      <Section id="runs">
        <Eyebrow>Recorded runs</Eyebrow>
        <H2>Three runs, already read back from devnet.</H2>
        <p className="mt-5 max-w-[540px] text-[17px] text-fd-muted-foreground">
          Every row below was read from the ledger with <code>getTransaction</code>, or from the TEE RPC for a signature the base layer does not know. Nothing comes from a client, vendor or facilitator log.
        </p>
        <div className="mt-10 grid gap-4 md:grid-cols-3">
          <Card lit>
            <h3 className="text-[19px] font-semibold tracking-tight">Side by side</h3>
            <div className="mt-1 text-xs text-fd-muted-foreground">
              {sbs.calls} paid calls · {sbs.vendors} vendors · both rails · {sbs.date}
            </div>
            <p className="mt-3.5 text-sm text-fd-muted-foreground">
              The same workload through the stock x402 <code>batch-settlement</code> examples and through Wakeless, then each rail&apos;s redemption. The public rail ran unmodified.
            </p>
            <div className="mt-4">
              <div className="mb-2 text-[11px] uppercase tracking-[.1em] text-fd-muted-foreground">What the observer recovered</div>
              <Rank n={1} label="Public rail · vendors" value={`${pub.vendorsRecovered} / ${pub.vendorsActual}`} pct={(pub.vendorsRecovered / pub.vendorsActual) * 100} />
              <Rank n={2} label="Public rail · spend" value={pct(pub.spendRecoveredPercent)} pct={Number(pub.spendRecoveredPercent)} />
              <Rank n={3} label="Wakeless · vendors" value={recovered} pct={(wak.vendorsRecovered / wak.vendorsActual) * 100} dim />
              <Rank n={4} label="Wakeless · spend" value={pct(wak.spendRecoveredPercent)} pct={Number(wak.spendRecoveredPercent)} dim />
            </div>
            <div className="mt-auto flex justify-between pt-5 text-[13px] font-semibold">
              <Link href="/docs/how-it-works">Open run</Link>
              <Tag lit>shown above</Tag>
            </div>
          </Card>
          <Card>
            <h3 className="text-[19px] font-semibold tracking-tight">An agent at work</h3>
            <div className="mt-1 text-xs text-fd-muted-foreground">Claude Code · MCP server · {run.paidRequests} paid requests</div>
            <p className="mt-3.5 text-sm text-fd-muted-foreground">
              A fresh <code>claude -p</code> session, asked for a short market view on three symbols, paid three vendors through <code>@wakeless/client</code> under the owner&apos;s caps.
            </p>
            <div className="mt-4">
              <div className="mb-2 text-[11px] uppercase tracking-[.1em] text-fd-muted-foreground">On the base layer</div>
              <Rank n={1} label="Paid requests" value={String(run.paidRequests)} pct={100} />
              <Rank n={2} label="Private deposits" value={String(run.deposits)} pct={(run.deposits / run.paidRequests) * 100} />
              <Rank n={3} label="Base-layer transactions" value={String(run.baseLayerTransactions)} pct={(run.baseLayerTransactions / run.paidRequests) * 100} dim />
              <Rank n={4} label="Vendors named" value="0" pct={0} dim />
            </div>
            <div className="mt-auto pt-5 text-[13px] font-semibold">
              <a href={`${GITHUB_URL}/blob/main/${run.source}`}>Open run</a>
            </div>
          </Card>
          <Card>
            <h3 className="text-[19px] font-semibold tracking-tight">Two buyers, one route</h3>
            <div className="mt-1 text-xs text-fd-muted-foreground">Relationship terms · vendor 1 · {t.date}</div>
            <p className="mt-3.5 text-sm text-fd-muted-foreground">
              A buyer with {t.known.cleanPeriods} clean periods and a buyer vendor 1 has never seen ask for the same route. Two sets of terms, both signed by the vendor; the ledger sees neither.
            </p>
            <div className="mt-4">
              <div className="mb-2 text-[11px] uppercase tracking-[.1em] text-fd-muted-foreground">Quoted</div>
              <Rank n={1} label="Known buyer · price" value={t.known.price} pct={pricePct(knownPrice)} />
              <Rank n={2} label="Unknown buyer · price" value={t.unknown.price} pct={pricePct(unknownPrice)} />
              <Rank n={3} label="Known · funding requirement" value={`${t.known.fundingCalls} calls`} pct={callsPct(t.known.fundingCalls)} />
              <Rank n={4} label="Unknown · funding requirement" value={`${t.unknown.fundingCalls} calls`} pct={callsPct(t.unknown.fundingCalls)} />
            </div>
            <div className="mt-auto pt-5 text-[13px] font-semibold">
              <Link href="/docs/relationship-terms">Open run</Link>
            </div>
          </Card>
        </div>
      </Section>

      {/* 3. How it works */}
      <Section>
        <Eyebrow>How it works</Eyebrow>
        <H2>Three steps from a 402 to a vendor paid, with nothing on the base layer in the recorded run.</H2>
        <div className="mt-10 grid gap-8 border-t border-fd-foreground pt-8 md:grid-cols-3">
          {[
            ["01", "One private deposit opens a channel", "The buyer's first call to a vendor moves USDC from its private balance into the facilitator's escrow inside the rollup. The deposit payload carries the client-signed transfer, so the facilitator verifies buyer and amount."],
            ["02", "Every call after is a voucher", "The standard 50-byte cumulative voucher, signed by the client, verified off chain. The vendor answers 200. Nothing touches any chain."],
            ["03", "Redemption is a private transfer", "The facilitator pays each vendor what it is owed, one private transfer per channel inside the rollup, and signs a receipt. A transfer that cannot be made privately fails and is never retried in public."],
          ].map(([n, h, p]) => (
            <div key={n}>
              <div className="text-3xl font-semibold tracking-tighter">{n}</div>
              <h3 className="mt-2 text-[17px] font-semibold">{h}</h3>
              <p className="mt-2 text-sm text-fd-muted-foreground">{p}</p>
            </div>
          ))}
        </div>
      </Section>

      {/* 4. The calls are the plan */}
      <Section id="thesis">
        <Eyebrow>Why hide the trajectory</Eyebrow>
        <H2>The calls are the plan.</H2>
        <p className="mt-5 max-w-[640px] text-[17px] text-fd-muted-foreground">{d.trajectory.lead.replace(/^The calls are the plan\.\s*/, "").replace(/:$/, ".")}</p>
        <div className="mt-10 grid gap-4 sm:grid-cols-2 md:grid-cols-3">
          {d.trajectory.verticals.map((v, i) => (
            <Card key={v.title}>
              <div className="text-xs text-fd-muted-foreground">{String(i + 1).padStart(2, "0")}</div>
              <h3 className="mt-2 text-[17px] font-semibold tracking-tight">{v.title}</h3>
              <p className="mt-1.5 text-sm text-fd-muted-foreground">{v.consequence.charAt(0).toUpperCase() + v.consequence.slice(1)}</p>
            </Card>
          ))}
        </div>
        <p className="mt-6 text-sm text-fd-muted-foreground">
          The rest of the argument, the seller&apos;s side of it, is on the{" "}
          <Link href="/docs/how-it-works" className="underline">
            thesis page
          </Link>
          .
        </p>
      </Section>

      {/* 5. What the ledger already knows */}
      <Section>
        <div className="flex flex-wrap items-start justify-between gap-3">
          <div>
            <Eyebrow>What the ledger already knows</Eyebrow>
            <H2>
              On the public <code className="text-[.85em]">batch-settlement</code> rail, one payer&apos;s whole vendor set is readable today.
            </H2>
          </div>
          <Tag>Snapshot {leak.date}</Tag>
        </div>
        <div className="mt-10 grid gap-4 md:grid-cols-[1.1fr_2fr]">
          <div className="rounded-2xl border border-fd-foreground bg-fd-accent p-6">
            <div className="text-xs uppercase tracking-[.14em] text-fd-muted-foreground">What the observer recovered</div>
            <div className="mt-3 text-[96px] font-semibold leading-none tracking-[-.05em] tabular-nums">{leak.trajectory.vendors}</div>
            <div className="mt-2 text-lg font-medium">vendors, in first-contact order</div>
            <p className="mt-3 text-sm text-fd-muted-foreground">
              Payer <code>{leak.trajectory.payer}</code>, rebuilt by <code>reconstruct()</code> from its {leak.trajectory.channels} channels&apos; signatures and nothing else: every vendor, the spend on each, and {leak.trajectory.settlements} settlement times from {day(leak.trajectory.first)} to {day(leak.trajectory.last)}.
            </p>
          </div>
          <div className="grid gap-3 sm:grid-cols-2">
            <Tile k="Channels" title="Named on chain" value={fmt(leak.channels)} sub={<Row l="in USDC with a readable settlement" r={fmt(leak.channelsWithSettlement)} />} />
            <Tile k="Payers" title="Distinct" value={fmt(leak.payers)} sub={<><Row l="channels per payer, median" r={String(leak.medianChannelsPerPayer)} /><Row l="max" r={String(leak.maxChannelsPerPayer)} /></>} />
            <Tile k="Vendors" title="Distinct payTo" value={fmt(leak.payTo)} sub={<Row l="largest, distinct payers" r={fmt(leak.largestPayToPayers)} />} />
            <Tile k="Relationships" title="Public (payer, payTo) pairs" value={fmt(leak.relationships)} sub={<Row l="payers with two or more vendors" r={String(leak.payersWithTwoOrMorePayTo)} />} />
          </div>
        </div>
        <p className="mt-4 text-xs text-fd-muted-foreground">
          Mainnet payment-channels program, read-only, {fmt(leak.signaturesScanned)} signatures, {day(leak.oldest)} to {day(leak.newest)}. Addresses truncated; aggregates, not a directory. The numbers are the structure of the leak at this size, not a market.{" "}
          <Link href="/docs/ledger" className="underline">
            See the full index
          </Link>
        </p>
      </Section>

      {/* 6. Public vs Wakeless */}
      <Section>
        <Eyebrow>What stays observable</Eyebrow>
        <H2>A Wakeless channel hides the relationship, not the edges of the pool.</H2>
        <div className="mt-10 grid gap-4 md:grid-cols-2">
          <Card>
            <h3 className="text-[19px] font-semibold">A public channel shows</h3>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm text-fd-muted-foreground">
              <li>
                Payer and payTo, on <code>open</code>
              </li>
              <li>
                The cumulative amount, on <code>settle</code>
              </li>
              <li>
                The recipient, on <code>distribute</code>
              </li>
              <li>The depositor, so the owner</li>
            </ul>
          </Card>
          <Card lit>
            <h3 className="text-[19px] font-semibold">A Wakeless channel shows</h3>
            <ul className="mt-3 list-disc space-y-2 pl-5 text-sm">
              <li>A vault deposit: the buyer, an amount in</li>
              <li>A vault withdrawal: a vendor, an amount out</li>
              <li>Nothing that joins the two</li>
              <li>With Aurora confidential funding, not the origin wallet either</li>
            </ul>
          </Card>
        </div>
      </Section>

      {/* 7. Trust boundary */}
      <Section>
        <Eyebrow>Trust boundary</Eyebrow>
        <p className="max-w-[900px] text-xl font-medium leading-snug tracking-tight md:text-2xl">{d.trust}</p>
        <p className="mt-4 max-w-[760px] text-sm text-fd-muted-foreground">
          Devnet alpha, not independently audited. The facilitator holds the escrow key in v1. {`${wak.vendorsRecovered === 0 ? "Zero" : wak.vendorsRecovered} vendors recovered`} is the observer&apos;s result in the recorded run; with few buyers behind one escrow, the vault&apos;s edges can be correlated.
        </p>
        <div className="mt-6 flex flex-wrap gap-3">
          <Link href="/docs/trust-boundary" className={buttonVariants({ variant: "primary" })}>
            What each party sees
          </Link>
          <Link href="/docs/trust-boundary#limitations" className={buttonVariants({ variant: "secondary" })}>
            Limitations
          </Link>
        </div>
      </Section>

      {/* 8. Closing */}
      <Section className="border-b-0">
        <Eyebrow>The bigger picture</Eyebrow>
        <H2>An open payment rail should not make every agent&apos;s strategy public.</H2>
        <p className="mt-5 max-w-[640px] text-[17px] text-fd-muted-foreground">
          When every paid call is observable, the supply chain of the whole agent economy is readable by competitors, adversaries and anyone watching. Buyers lose their plan; sellers lose the private history that sets their terms.
        </p>
        <div className="mt-8 flex flex-wrap gap-3">
          <Link href="/#runs" className={buttonVariants({ variant: "primary" })}>
            Explore the recorded runs
          </Link>
          <a href={GITHUB_URL} className={buttonVariants({ variant: "secondary" })}>
            View source
          </a>
        </div>
      </Section>

      <footer className="border-t border-fd-border">
        <div className="mx-auto flex max-w-[1200px] flex-wrap items-center justify-between gap-4 px-6 py-7 text-[13px] text-fd-muted-foreground md:px-12">
          <span className="font-semibold text-fd-foreground">wakeless</span>
          <span>
            <Link href="/docs">Docs</Link> · <a href={GITHUB_URL}>GitHub</a> · <Link href="/#thesis">Thesis</Link>
          </span>
          <span>Shielded payment channels for x402. Devnet alpha · MIT</span>
        </div>
      </footer>
    </main>
  );
}
