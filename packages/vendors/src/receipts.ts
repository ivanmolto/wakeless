import type { PayeeBinding } from "@wakeless/binding";
import { decodeBase58Exact, parseSettlementReceipt, verifyReceipt, type SettlementReceipt } from "@wakeless/scheme";

/**
 * Task 7.3: a vendor's receipt reader. Logged in to the rail with its own key (a
 * `PayeeBinding`), the vendor reads its private balance and whatever reference ids the
 * rail exposes, fetches the facilitator's receipts for each of its channels under its own
 * receipt token, verifies the facilitator's signature on each against the signer
 * `/supported` advertises, asks the rail whether each private transfer landed, and
 * cross-checks the lot against `GET /admin/channels`. Every disagreement is a mismatch.
 *
 * The report is the vendor's own, on its own terminal: it carries amounts and transfer
 * signatures, which never go in a log. Transfer signatures are printed shortened; tokens
 * and keys are never printed, and `formatReport` scrubs both out of anything it writes.
 */

export class ReceiptReaderError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ReceiptReaderError";
  }
}

/** One channel as `GET /admin/channels` lists it, parsed. */
export interface AdminChannelView {
  readonly channelId: string;
  readonly vendor: string;
  readonly state: string;
  readonly accepted: bigint;
  readonly settled: bigint;
  readonly settle: { readonly confirmed: number; readonly pending: number; readonly failed: number; readonly rejected: number; readonly lastPeriod: number | null };
}

/** `GET /receipts/:channelId`, with each receipt still untrusted. */
export interface ReceiptsView {
  readonly channelId: string;
  readonly signer: string;
  readonly receipts: readonly unknown[];
}

export type TransferStatus = "landed" | "failed" | "not_found" | "unchecked";

export interface ReceiptRow {
  readonly channelId: string;
  readonly period: number;
  readonly cumulative: bigint;
  /** What the vendor received for the period, net of the facilitator's fee. */
  readonly amount: bigint;
  /** The private transfer escrow → vendor. */
  readonly transferSignature: string;
  /** The facilitator's signature verifies against an advertised signer. */
  readonly verified: boolean;
  /** What the rail answers for the transfer signature under the vendor's own login. */
  readonly transfer: TransferStatus;
}

export type MismatchCode =
  | "receipts_unavailable"
  | "receipt_malformed"
  | "signer_unadvertised"
  | "unverified"
  | "channel_id"
  | "vendor"
  | "receipt_count"
  | "period_sequence"
  | "amount_exceeds_period"
  | "cumulative_settled"
  | "duplicate_transfer"
  | "transfer_not_landed";

export interface Mismatch {
  readonly channelId: string;
  readonly code: MismatchCode;
  readonly detail: string;
}

export interface VendorReceiptReport {
  readonly vendor: string;
  readonly balance: bigint;
  readonly referenceIds: readonly string[];
  readonly signers: readonly string[];
  readonly channels: readonly AdminChannelView[];
  readonly rows: readonly ReceiptRow[];
  readonly mismatches: readonly Mismatch[];
}

// ---------------------------------------------------------------------------- parsers

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function u64(value: unknown, what: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]{0,19})$/.test(value) || BigInt(value) > (1n << 64n) - 1n) {
    throw new ReceiptReaderError(`${what} is not a decimal u64`);
  }
  return BigInt(value);
}

function count(value: unknown, what: string): number {
  if (typeof value !== "number" || !Number.isSafeInteger(value) || value < 0) throw new ReceiptReaderError(`${what} is not a count`);
  return value;
}

function address(value: unknown, what: string): string {
  if (decodeBase58Exact(value, 32) === null) throw new ReceiptReaderError(`${what} is not a 32-byte base58 value`);
  return value as string;
}

/** `GET /admin/channels` from untrusted JSON. Throws `ReceiptReaderError` on any other shape. */
export function parseAdminChannels(json: unknown): AdminChannelView[] {
  if (!isRecord(json) || !Array.isArray(json.channels)) throw new ReceiptReaderError("/admin/channels: channels is not an array");
  return json.channels.map((entry: unknown, i) => {
    const what = `/admin/channels entry ${i + 1}`;
    if (!isRecord(entry) || !isRecord(entry.settle)) throw new ReceiptReaderError(`${what} is not a channel`);
    if (typeof entry.state !== "string") throw new ReceiptReaderError(`${what}: state is not a string`);
    const { lastPeriod } = entry.settle;
    if (lastPeriod !== null && (typeof lastPeriod !== "number" || !Number.isSafeInteger(lastPeriod) || lastPeriod < 1)) {
      throw new ReceiptReaderError(`${what}: settle.lastPeriod is neither null nor a period`);
    }
    return {
      channelId: address(entry.channelId, `${what}: channelId`),
      vendor: address(entry.vendor, `${what}: vendor`),
      state: entry.state,
      accepted: u64(entry.accepted, `${what}: accepted`),
      settled: u64(entry.settled, `${what}: settled`),
      settle: {
        confirmed: count(entry.settle.confirmed, `${what}: settle.confirmed`),
        pending: count(entry.settle.pending, `${what}: settle.pending`),
        failed: count(entry.settle.failed, `${what}: settle.failed`),
        rejected: count(entry.settle.rejected, `${what}: settle.rejected`),
        lastPeriod,
      },
    };
  });
}

/** `GET /receipts/:channelId` from untrusted JSON. Each receipt is parsed later, one by one. */
export function parseReceiptsResponse(json: unknown): ReceiptsView {
  if (!isRecord(json) || !Array.isArray(json.receipts)) throw new ReceiptReaderError("/receipts: receipts is not an array");
  return { channelId: address(json.channelId, "/receipts: channelId"), signer: address(json.signer, "/receipts: signer"), receipts: json.receipts };
}

/** `signers["solana:*"]` from `GET /supported`. */
export function parseAdvertisedSigners(json: unknown): string[] {
  const signers = isRecord(json) && isRecord(json.signers) ? json.signers["solana:*"] : undefined;
  if (!Array.isArray(signers)) throw new ReceiptReaderError('/supported: signers["solana:*"] is not an array');
  return signers.map((s, i) => address(s, `/supported signer ${i + 1}`));
}

// ---------------------------------------------------------------------------- checks

/** A receipt verifies when its signature checks out against one of the signers `/supported` advertises. */
export function verifyAgainst(signers: readonly string[], receipt: SettlementReceipt): boolean {
  return signers.some((signer) => verifyReceipt(signer, receipt));
}

/**
 * The pure part: one channel's receipts against the facilitator's account of it.
 * `receipts` is undefined when the facilitator would not serve them. Rows carry
 * `transfer: "unchecked"`; the reader fills that in from the rail.
 */
export function crossCheckChannel(
  channel: AdminChannelView,
  receipts: ReceiptsView | undefined,
  signers: readonly string[],
  vendor: string,
): { rows: ReceiptRow[]; mismatches: Mismatch[] } {
  const { channelId } = channel;
  const mismatches: Mismatch[] = [];
  const flag = (code: MismatchCode, detail: string) => mismatches.push({ channelId, code, detail });

  if (channel.vendor !== vendor) flag("vendor", "/admin/channels names another vendor for this channel");
  if (receipts === undefined) {
    flag("receipts_unavailable", "the facilitator lists the channel but would not serve its receipts to this vendor");
    return { rows: [], mismatches };
  }
  if (receipts.channelId !== channelId) flag("channel_id", "the receipts response names another channel");
  if (!signers.includes(receipts.signer)) flag("signer_unadvertised", "the receipts response names a signer /supported does not advertise");

  const parsed: SettlementReceipt[] = [];
  receipts.receipts.forEach((raw, i) => {
    const result = parseSettlementReceipt(raw);
    if (result.ok) parsed.push(result.value);
    else flag("receipt_malformed", `receipt ${i + 1}: ${result.message}`);
  });
  parsed.sort((a, b) => a.period - b.period);

  const rows: ReceiptRow[] = [];
  const transfers = new Set<string>();
  let previous = 0n;
  parsed.forEach((receipt, i) => {
    const cumulative = BigInt(receipt.cumulative);
    const amount = BigInt(receipt.amount);
    const verified = verifyAgainst(signers, receipt);
    if (!verified) flag("unverified", `period ${receipt.period}: the facilitator signature does not verify against an advertised signer`);
    if (receipt.channelId !== channelId) flag("channel_id", `period ${receipt.period}: the receipt names another channel`);
    if (receipt.period !== i + 1) flag("period_sequence", `receipt ${i + 1} is for period ${receipt.period}`);
    if (cumulative < previous || amount > cumulative - previous) flag("amount_exceeds_period", `period ${receipt.period}: received more than the period's increase in cumulative`);
    if (transfers.has(receipt.signature)) flag("duplicate_transfer", `period ${receipt.period}: the transfer signature is already on an earlier receipt`);
    transfers.add(receipt.signature);
    previous = cumulative;
    rows.push({ channelId, period: receipt.period, cumulative, amount, transferSignature: receipt.signature, verified, transfer: "unchecked" });
  });

  if (parsed.length !== channel.settle.confirmed) {
    flag("receipt_count", `${parsed.length} receipt(s) against ${channel.settle.confirmed} confirmed settle operation(s)`);
  }
  const lastCumulative = parsed.length === 0 ? 0n : BigInt(parsed.at(-1)!.cumulative);
  if (lastCumulative !== channel.settled) flag("cumulative_settled", "the last receipt's cumulative differs from the channel's settled");
  return { rows, mismatches };
}

// ---------------------------------------------------------------------------- reader

export interface ReceiptReaderDeps {
  /** The vendor's own login on the rail. */
  readonly payee: PayeeBinding;
  /** Where the facilitator answers; `/admin/*` answers loopback only. */
  readonly facilitatorUrl: string;
  /** `FACILITATOR_ADMIN_TOKEN`, for `GET /admin/channels`. Never printed. */
  readonly adminToken: string;
  /** This vendor's entry from `FACILITATOR_RECEIPT_TOKENS`, for `GET /receipts/:channelId`. Never printed. */
  readonly receiptToken: string;
  readonly fetch?: typeof fetch;
}

async function getJson(doFetch: typeof fetch, url: string, token: string | undefined, what: string): Promise<{ status: number; json: unknown }> {
  const res = await doFetch(url, { headers: token === undefined ? {} : { authorization: `Bearer ${token}` } });
  let json: unknown = null;
  try {
    json = await res.json();
  } catch {
    // An unreadable body is reported by status alone.
  }
  if (res.status >= 500 || res.status === 401 || res.status === 403) {
    const code = isRecord(json) && typeof json.code === "string" ? ` ${json.code}` : "";
    throw new ReceiptReaderError(`${what} → HTTP ${res.status}${code}`);
  }
  return { status: res.status, json };
}

export async function readVendorReceipts(deps: ReceiptReaderDeps): Promise<VendorReceiptReport> {
  const doFetch = deps.fetch ?? fetch;
  const base = deps.facilitatorUrl.replace(/\/$/, "");
  const vendor = deps.payee.address();
  const { balance, referenceIds } = await deps.payee.privateBalance();

  const supported = await getJson(doFetch, `${base}/supported`, undefined, "GET /supported");
  const signers = parseAdvertisedSigners(supported.json);
  const listed = await getJson(doFetch, `${base}/admin/channels?vendor=${vendor}`, deps.adminToken, "GET /admin/channels");
  if (listed.status !== 200) throw new ReceiptReaderError(`GET /admin/channels → HTTP ${listed.status}`);
  const channels = parseAdminChannels(listed.json);

  const rows: ReceiptRow[] = [];
  const mismatches: Mismatch[] = [];
  for (const channel of channels) {
    const got = await getJson(doFetch, `${base}/receipts/${channel.channelId}`, deps.receiptToken, "GET /receipts/:channelId");
    const receipts = got.status === 200 ? parseReceiptsResponse(got.json) : undefined;
    const checked = crossCheckChannel(channel, receipts, signers, vendor);
    mismatches.push(...checked.mismatches);
    for (const row of checked.rows) {
      let transfer: TransferStatus;
      try {
        transfer = await deps.payee.transferStatus(row.transferSignature as Parameters<PayeeBinding["transferStatus"]>[0]);
      } catch {
        transfer = "unchecked";
      }
      if (transfer !== "landed") mismatches.push({ channelId: row.channelId, code: "transfer_not_landed", detail: `period ${row.period}: the rail answers ${transfer} for the transfer under the vendor's login` });
      rows.push({ ...row, transfer });
    }
  }
  return { vendor, balance, referenceIds, signers, channels, rows, mismatches };
}

// ---------------------------------------------------------------------------- output

/** `abcdefgh…stuvwxyz`: enough to find a transfer, never a whole signature. */
export function shorten(value: string, keep = 8): string {
  return value.length <= keep * 2 + 1 ? value : `${value.slice(0, keep)}…${value.slice(-keep)}`;
}

/** 64-byte base58 values (signatures, secret keys) are 86 to 88 characters. */
const LONG_BASE58 = /[1-9A-HJ-NP-Za-km-z]{80,}/g;

/**
 * Replaces every secret given, and any long base58 run, so neither can reach the terminal.
 * `keep` names the transfer signatures the caller asked to see in full; nothing else is spared.
 */
export function scrub(text: string, secrets: readonly string[], keep?: ReadonlySet<string>): string {
  let out = text;
  for (const secret of secrets) if (secret.length >= 8) out = out.split(secret).join("[redacted]");
  return out.replace(LONG_BASE58, (run) => (keep?.has(run) ? run : shorten(run)));
}

function table(header: readonly string[], body: readonly (readonly string[])[]): string[] {
  const widths = header.map((h, i) => Math.max(h.length, ...body.map((r) => r[i]!.length)));
  return [header, ...body].map((r) => r.map((cell, i) => cell.padEnd(widths[i]!)).join("  ").trimEnd());
}

export interface FormatOptions {
  /**
   * Print each transfer signature in full, for looking it up on the TEE RPC. Off by
   * default: the report then holds no 88-character base58 string. Tokens and keys are
   * scrubbed either way.
   */
  readonly fullSignatures?: boolean;
}

/** What the rail can and cannot say; printed on every report so `verified: yes` is not read as more than it is. */
export const EVIDENCE_NOTE = "rail confirms only that each transfer exists and succeeded; amount, period and cumulative are the facilitator's signed claim";

/** The report as the terminal shows it; `secrets` are scrubbed from every line. */
export function formatReport(report: VendorReceiptReport, label: string, secrets: readonly string[], options: FormatOptions = {}): string {
  const lines: string[] = [];
  lines.push(`${label} ${report.vendor}`);
  lines.push(`private balance ${report.balance} base units · reference ids exposed by the rail: ${report.referenceIds.length === 0 ? "none" : report.referenceIds.join(", ")}`);
  lines.push(`facilitator receipt signer(s) advertised: ${report.signers.length === 0 ? "none" : report.signers.join(", ")}`);
  lines.push(EVIDENCE_NOTE);
  lines.push("");
  const byChannel = new Map(report.channels.map((c) => [c.channelId, c]));
  const transfer = (sig: string) => (options.fullSignatures ? sig : shorten(sig));
  lines.push(
    ...table(
      ["channel", "period", "cumulative", "received", "transfer", "rail", "verified"],
      report.rows.map((r) => [r.channelId, String(r.period), r.cumulative.toString(), r.amount.toString(), transfer(r.transferSignature), r.transfer, r.verified ? "yes" : "NO"]),
    ),
  );
  lines.push("");
  for (const c of byChannel.values()) {
    const s = c.settle;
    lines.push(`channel ${c.channelId} ${c.state} · accepted ${c.accepted} · settled ${c.settled} · owed ${c.accepted - c.settled} · settle ops confirmed ${s.confirmed} pending ${s.pending} failed ${s.failed} rejected ${s.rejected}`);
  }
  const verified = report.rows.filter((r) => r.verified).length;
  lines.push(`channels ${report.channels.length} · receipts ${report.rows.length} · verified ${verified}/${report.rows.length} · received ${report.rows.reduce((sum, r) => sum + r.amount, 0n)} base units · mismatches ${report.mismatches.length}`);
  for (const m of report.mismatches) lines.push(`MISMATCH ${m.code} ${m.channelId}: ${m.detail}`);
  const keep = options.fullSignatures ? new Set(report.rows.map((r) => r.transferSignature)) : undefined;
  return lines.map((line) => scrub(line, secrets, keep)).join("\n");
}

/** Clean: every receipt verifies, every transfer landed, and nothing disagrees with the facilitator. */
export function isClean(report: VendorReceiptReport): boolean {
  return report.mismatches.length === 0 && report.rows.every((r) => r.verified && r.transfer === "landed");
}

/**
 * This vendor's token from `FACILITATOR_RECEIPT_TOKENS` (`<vendor base58>=<token>`, comma
 * separated). Errors never quote a token.
 */
export function receiptTokenFor(vendor: string, text: string | undefined): string {
  for (const entry of (text ?? "").split(",")) {
    const eq = entry.indexOf("=");
    if (eq !== -1 && entry.slice(0, eq).trim() === vendor) {
      const token = entry.slice(eq + 1).trim();
      if (token.length >= 16) return token;
    }
  }
  throw new ReceiptReaderError(`FACILITATOR_RECEIPT_TOKENS has no entry for ${shorten(vendor, 4)}; run pnpm tokens`);
}
