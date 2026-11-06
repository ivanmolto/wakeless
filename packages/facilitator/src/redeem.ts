import type { Address, Signature } from "@solana/kit";
import { BINDING_ERROR_CODES, channelId as bindingChannelId, clientRefId, isBindingError, type SettlementBinding } from "@wakeless/binding";
import { decodeBase58Exact, publicKeyOf, signReceipt, type SettlementReceipt, type VoucherKeypair } from "@wakeless/scheme";
import type { FacilitatorLogger } from "./http/log.js";
import { KeyedMutex } from "./stores/keyed-mutex.js";
import type { ChannelRecord, OperationRecord, Stores } from "./stores/types.js";

/**
 * Task 7.2: the redemption worker. Every interval (or on `POST /admin/redeem`), for each
 * open channel with `accepted > settled`, one private transfer escrow → vendor through the
 * binding for the amount owed net of the privacy fee, under one `settle` operation per
 * channel per period. The binding chooses split and delay; the worker never does.
 *
 * Operation lifecycle (`stores/types.ts`): the operation is reserved `pending` before the
 * binding is called; a retry moves `failed` → `pending` first, for the same reason. On
 * confirmation the channel's `settled` moves to the period's cumulative, the operation is
 * `confirmed` and carries the facilitator-signed receipt. A thrown binding error leaves
 * the operation `failed` (attempts + 1) and the amount owed; `shielded_binding_rejected`
 * makes it `rejected`, terminal: the channel is never redeemed again by this worker, an
 * alert is kept, and nothing is retried publicly (`CLAUDE.md`, Privacy rules).
 *
 * `reconcile()` runs once at startup, before any transfer: every `pending` operation is
 * one the process died inside. The rail shows nothing of an ephemeral transfer to anyone,
 * so the only evidence is the escrow's private balance against what the stores account
 * for; a pending amount missing from the balance was sent (the operation is confirmed,
 * with an unsigned reconciliation note instead of a receipt, and alerted), one still there
 * was not (the operation goes to `failed`, alerted, and the worker retries it as usual).
 */

export const DEFAULT_REDEEM_INTERVAL_SECS = 60;
/** Seven days, as `docs/SCHEME.md` §4.4 advertises in `/supported` `extra.maxIdleSecs`. */
export const DEFAULT_MAX_IDLE_SECS = 604_800;
/** What a production deployment should run: one redemption per channel per hour. */
export const PRODUCTION_REDEEM_INTERVAL_SECS = 3600;
export const DEFAULT_MAX_ATTEMPTS = 5;
/** Retry backoff after a failure: `base × 2^(attempts − 1)`, capped. */
export const DEFAULT_BACKOFF: { readonly baseSeconds: number; readonly maxSeconds: number } = { baseSeconds: 60, maxSeconds: 3600 };

export interface RedeemDeps {
  readonly binding: SettlementBinding;
  readonly stores: Stores;
  /** The facilitator's receipt signer (`/supported` `signers`). */
  readonly signer: VoucherKeypair;
  /** Basis points kept by the facilitator out of every redeemed amount. Default 10. */
  readonly privacyFeeBps?: number;
  readonly maxAttempts?: number;
  readonly backoff?: { readonly baseSeconds: number; readonly maxSeconds: number };
  /** An open channel with no activity for this long is idle-closed by `closeOnce()`. Default 7 days; the same value `/supported` advertises. */
  readonly maxIdleSecs?: number;
  /** Unix seconds. */
  readonly now?: () => number;
  /** One line per event: channel id, op id, status. Never a signature or an amount. */
  readonly log?: (line: string) => void;
  readonly logger?: FacilitatorLogger;
  /** Tests inject a timer. */
  readonly setInterval?: (fn: () => void, ms: number) => unknown;
  readonly clearInterval?: (handle: unknown) => void;
}

export type AlertKind =
  | "settle_rejected"
  | "settle_attempts_exhausted"
  | "settle_confirmed_not_recorded"
  | "settle_reconciled_sent"
  | "settle_reconciled_unsent"
  | "refund_rejected"
  | "refund_attempts_exhausted"
  | "refund_confirmed_not_recorded"
  | "refund_reconciled_sent"
  | "refund_reconciled_unsent";

/** What `GET /admin/alerts` lists. Ids and codes only; never an amount or a signature. */
export interface Alert {
  /** Unix seconds. */
  readonly at: number;
  readonly kind: AlertKind;
  readonly channelId: string;
  readonly opId: string;
  /** The settle period; `0` for a refund, which has none. */
  readonly period: number;
  readonly attempts: number;
  readonly code?: string;
  /** The upstream error code when the binding gave one (`UNSUPPORTED_TRANSFER_ROUTE`). */
  readonly apiCode?: string;
}

/** Counts only. */
export interface RedeemRunSummary {
  /** Open channels with something owed. */
  readonly owed: number;
  readonly confirmed: number;
  readonly failed: number;
  readonly rejected: number;
  /** Owed but not attempted this run: in flight, rejected earlier, exhausted, or in backoff. */
  readonly skipped: number;
}

export interface ReconcileSummary {
  readonly pending: number;
  readonly sent: number;
  readonly unsent: number;
}

/** Counts only (task 8.1). */
export interface CloseRunSummary {
  /** Open channels idle-closed this run. */
  readonly idle: number;
  /** Closing channels whose grace had passed: each is paid out, refunded and closed, or skipped. */
  readonly due: number;
  /** Final redemptions to the vendor made this run. */
  readonly settled: number;
  /** Refunds sent this run. */
  readonly refunded: number;
  /** Channels marked closed this run. */
  readonly closed: number;
  readonly failed: number;
  readonly rejected: number;
  /** Due but not finished this run: a settle or refund in flight, failed and in backoff, rejected, or exhausted. */
  readonly skipped: number;
}

export interface Redeemer {
  /** The receipt signer's public key, base58. */
  readonly signer: string;
  /** Startup: settle every `pending` operation's fate against the binding. Sends nothing. */
  reconcile(): Promise<ReconcileSummary>;
  /** One run. Runs are serialised; a run in progress is waited for. */
  runOnce(): Promise<RedeemRunSummary>;
  /**
   * One close pass (task 8.1): idle-close every open channel with no activity for
   * `maxIdleSecs`; then, for every closing channel past `refundAfter`, pay the vendor
   * what is owed (the same settle path as `runOnce`, vendor first), refund
   * `deposit − settled` to the buyer's private balance, and mark the channel closed.
   * Serialised with `runOnce`.
   */
  closeOnce(): Promise<CloseRunSummary>;
  /** Runs `runOnce` then `closeOnce` every `intervalMs` until `stop()`. A run that overlaps the next tick is not doubled. */
  start(intervalMs: number): void;
  stop(): void;
  /** Newest last. */
  alerts(): readonly Alert[];
  /** Every facilitator-signed receipt of the channel, by period. */
  receipts(channelId: string): Promise<SettlementReceipt[]>;
}

const MAX_ALERTS = 1000;

interface SettlePayload {
  readonly period: number;
  readonly cumulative: string;
  readonly gross: string;
  readonly amount: string;
  readonly clientRef: string;
}

export function settleOpId(period: number): string {
  return `settle:${period}`;
}

/** One refund per channel, at close. */
export const REFUND_OP_ID = "refund:1";

interface RefundPayload {
  readonly amount: string;
  readonly clientRef: string;
}

function refundPayloadOf(op: OperationRecord): RefundPayload {
  const { amount, clientRef } = op.payload;
  if (typeof amount !== "string" || typeof clientRef !== "string") {
    throw new Error(`refund operation ${op.opId} on ${op.channelId} has a malformed payload`);
  }
  return { amount, clientRef };
}

function isRefund(op: OperationRecord): boolean {
  return op.type === "refund" && op.opId === REFUND_OP_ID;
}

export function periodOf(opId: string): number | undefined {
  const match = /^settle:([1-9][0-9]*)$/.exec(opId);
  return match === null ? undefined : Number(match[1]);
}

/** The fee kept by the facilitator out of `gross`, rounded down. */
export function feeOf(gross: bigint, bps: number): bigint {
  if (!Number.isSafeInteger(bps) || bps < 0 || bps > 10_000) throw new RangeError("privacyFeeBps must be an integer in 0..10000");
  return (gross * BigInt(bps)) / 10_000n;
}

export function backoffSeconds(attempts: number, backoff = DEFAULT_BACKOFF): number {
  if (attempts <= 0) return 0;
  return Math.min(backoff.baseSeconds * 2 ** (attempts - 1), backoff.maxSeconds);
}

function payloadOf(op: OperationRecord): SettlePayload {
  const { period, cumulative, gross, amount, clientRef } = op.payload;
  if (typeof period !== "number" || typeof cumulative !== "string" || typeof gross !== "string" || typeof amount !== "string" || typeof clientRef !== "string") {
    throw new Error(`settle operation ${op.opId} on ${op.channelId} has a malformed payload`);
  }
  return { period, cumulative, gross, amount, clientRef };
}

function toHexChannelId(base58: string): string {
  const bytes = decodeBase58Exact(base58, 32);
  if (bytes === null) throw new RangeError("channelId must be 32 bytes of base58");
  return Buffer.from(bytes).toString("hex");
}

function isSettle(op: OperationRecord): boolean {
  return op.type === "settle" && periodOf(op.opId) !== undefined;
}

export function createRedeemer(deps: RedeemDeps): Redeemer {
  const { binding, stores } = deps;
  const feeBps = deps.privacyFeeBps ?? 10;
  feeOf(0n, feeBps);
  const maxAttempts = deps.maxAttempts ?? DEFAULT_MAX_ATTEMPTS;
  const backoff = deps.backoff ?? DEFAULT_BACKOFF;
  const maxIdleSecs = deps.maxIdleSecs ?? DEFAULT_MAX_IDLE_SECS;
  if (!Number.isSafeInteger(maxIdleSecs) || maxIdleSecs < 0) throw new RangeError("maxIdleSecs must be a non-negative integer");
  const now = deps.now ?? (() => Math.floor(Date.now() / 1000));
  const signer = publicKeyOf(deps.signer);
  const runs = new KeyedMutex();
  const alerts: Alert[] = [];
  /** `channelId/opId` → unix seconds before which a failed operation is not retried. */
  const retryAfter = new Map<string, number>();
  /** Channels already alerted as exhausted, so the alert is kept once. */
  const exhausted = new Set<string>();
  let timer: unknown;
  let running = false;

  function log(event: string, fields: Record<string, string | number | undefined>, level: "info" | "warn" | "error" = "info"): void {
    const line = [event.replaceAll("_", " "), ...Object.values(fields).filter((v) => v !== undefined)].join(" ");
    deps.log?.(line);
    deps.logger?.[level]({ event, ...fields }, line);
  }

  function alert(kind: AlertKind, op: OperationRecord, period: number, extra: { code?: string; apiCode?: string } = {}): void {
    const entry: Alert = { at: now(), kind, channelId: op.channelId, opId: op.opId, period, attempts: op.attempts, ...extra };
    alerts.push(entry);
    if (alerts.length > MAX_ALERTS) alerts.splice(0, alerts.length - MAX_ALERTS);
    log(kind, { channelId: op.channelId, opId: op.opId, period, attempts: op.attempts, code: extra.code, apiCode: extra.apiCode }, "error");
  }

  async function settleOps(channelId: string): Promise<OperationRecord[]> {
    return (await stores.operations.list(channelId)).filter(isSettle).sort((a, b) => periodOf(a.opId)! - periodOf(b.opId)!);
  }

  /** The channel's `settled` moves up to `cumulative`, never down. */
  async function advanceSettled(channelId: string, cumulative: bigint): Promise<void> {
    await stores.channels.update(channelId, (current) => {
      if (current === undefined) throw new Error(`channel ${channelId} vanished during redemption`);
      return cumulative > current.settled ? { ...current, settled: cumulative } : current;
    });
  }

  /** What to do for one channel this run: an operation to call the binding with, or a reason to skip. */
  async function prepare(channel: ChannelRecord): Promise<{ op: OperationRecord; payload: SettlePayload } | "skip"> {
    const ops = await settleOps(channel.channelId);
    const last = ops.at(-1);
    if (last !== undefined) {
      if (ops.some((op) => op.status === "rejected")) return "skip";
      if (last.status === "pending") return "skip";
      if (last.status === "failed") {
        const key = `${channel.channelId}/${last.opId}`;
        if (last.attempts >= maxAttempts) {
          if (!exhausted.has(key)) {
            exhausted.add(key);
            alert("settle_attempts_exhausted", last, periodOf(last.opId)!);
          }
          return "skip";
        }
        const notBefore = retryAfter.get(key);
        if (notBefore !== undefined && now() < notBefore) return "skip";
        const op = await stores.operations.transition(channel.channelId, last.opId, { status: "pending" });
        return { op, payload: payloadOf(op) };
      }
    }
    // A new period: the whole amount owed now, net of the fee.
    const gross = channel.accepted - channel.settled;
    const amount = gross - feeOf(gross, feeBps);
    if (amount <= 0n) return "skip";
    const period = last === undefined ? 1 : periodOf(last.opId)! + 1;
    const payload: SettlePayload = { period, cumulative: channel.accepted.toString(), gross: gross.toString(), amount: amount.toString(), clientRef: channel.clientRef };
    const reserved = await stores.operations.reserve({ opId: settleOpId(period), channelId: channel.channelId, type: "settle", payload: { ...payload } });
    if (!reserved.created) return "skip"; // Another run got here first.
    return { op: reserved.operation, payload };
  }

  async function redeemChannel(channel: ChannelRecord): Promise<"confirmed" | "failed" | "rejected" | "skipped"> {
    const prepared = await prepare(channel);
    if (prepared === "skip") return "skipped";
    const { op, payload } = prepared;
    const { channelId } = channel;
    log("settle_pending", { channelId, opId: op.opId, period: payload.period, attempts: op.attempts });

    let result: Awaited<ReturnType<SettlementBinding["settle"]>>;
    try {
      result = await binding.settle(channel.vendor as Address, BigInt(payload.amount), {
        id: clientRefId(payload.clientRef),
        channelId: bindingChannelId(toHexChannelId(channelId)),
        period: payload.period,
        cumulative: BigInt(payload.cumulative),
      });
    } catch (error) {
      if (isBindingError(error, BINDING_ERROR_CODES.bindingRejected)) {
        const rejected = await stores.operations.transition(channelId, op.opId, { status: "rejected" });
        alert("settle_rejected", rejected, payload.period, { code: error.code, apiCode: error.apiCode });
        return "rejected";
      }
      const failed = await stores.operations.transition(channelId, op.opId, { status: "failed" });
      retryAfter.set(`${channelId}/${op.opId}`, now() + backoffSeconds(failed.attempts, backoff));
      log("settle_failed", { channelId, opId: op.opId, period: payload.period, attempts: failed.attempts, errorName: error instanceof Error ? error.name : "Error" }, "warn");
      return "failed";
    }

    // The vendor has been paid. Record it; if the record cannot be written the operation stays
    // `pending` and the startup reconciliation finds the amount gone from the escrow.
    const receipt = signReceipt(deps.signer, { channelId, period: payload.period, cumulative: payload.cumulative, amount: payload.amount, signature: result.sig });
    try {
      await advanceSettled(channelId, BigInt(payload.cumulative));
      await stores.operations.transition(channelId, op.opId, { status: "confirmed", signature: result.sig, receipt: { ...receipt } });
    } catch (error) {
      alert("settle_confirmed_not_recorded", op, payload.period, { code: error instanceof Error ? error.name : "Error" });
      return "skipped";
    }
    retryAfter.delete(`${channelId}/${op.opId}`);
    log("settle_confirmed", { channelId, opId: op.opId, period: payload.period });
    return "confirmed";
  }

  async function runOnce(): Promise<RedeemRunSummary> {
    return runs.run("run", async () => {
      const channels = (await stores.channels.list()).filter((c) => c.state === "open" && c.accepted > c.settled);
      const summary = { owed: channels.length, confirmed: 0, failed: 0, rejected: 0, skipped: 0 };
      for (const channel of channels) {
        const outcome = await redeemChannel(channel);
        if (outcome === "skipped") summary.skipped++;
        else summary[outcome]++;
      }
      log("redeem_run", summary);
      return summary;
    });
  }

  /** The channel's lifecycle moves to `closed`, once. */
  async function markClosed(channelId: string): Promise<void> {
    await stores.channels.update(channelId, (current) => {
      if (current === undefined) throw new Error(`channel ${channelId} vanished during close`);
      return current.state === "closed" ? current : { ...current, state: "closed", lastActivityAt: now() };
    });
  }

  /**
   * The refund of one closing channel whose vendor is paid in full: `deposit − settled` to
   * the buyer's private balance under the one `refund:1` operation, then `closed`. Nothing
   * owed to the buyer closes the channel with no transfer and no operation.
   */
  async function refundChannel(channel: ChannelRecord): Promise<"refunded" | "closed" | "failed" | "rejected" | "skipped"> {
    const { channelId } = channel;
    const existing = (await stores.operations.list(channelId)).find(isRefund);
    let op: OperationRecord;
    let payload: RefundPayload;
    if (existing !== undefined) {
      if (existing.status === "confirmed") {
        // Sent, and the process died before the record moved: finish the record.
        await markClosed(channelId);
        log("channel_closed", { channelId });
        return "closed";
      }
      if (existing.status === "rejected" || existing.status === "pending") return "skipped";
      const key = `${channelId}/${existing.opId}`;
      if (existing.attempts >= maxAttempts) {
        if (!exhausted.has(key)) {
          exhausted.add(key);
          alert("refund_attempts_exhausted", existing, 0);
        }
        return "skipped";
      }
      const notBefore = retryAfter.get(key);
      if (notBefore !== undefined && now() < notBefore) return "skipped";
      op = await stores.operations.transition(channelId, existing.opId, { status: "pending" });
      payload = refundPayloadOf(op);
    } else {
      const amount = channel.deposit - channel.settled;
      if (amount <= 0n) {
        await markClosed(channelId);
        log("channel_closed", { channelId });
        return "closed";
      }
      payload = { amount: amount.toString(), clientRef: channel.clientRef };
      const reserved = await stores.operations.reserve({ opId: REFUND_OP_ID, channelId, type: "refund", payload: { ...payload } });
      if (!reserved.created) return "skipped"; // Another run got here first.
      op = reserved.operation;
    }
    log("refund_pending", { channelId, opId: op.opId, attempts: op.attempts });

    let result: { sig: Signature };
    try {
      result = await binding.refund(channel.buyer as Address, BigInt(payload.amount), { id: clientRefId(payload.clientRef) });
    } catch (error) {
      if (isBindingError(error, BINDING_ERROR_CODES.bindingRejected)) {
        const rejected = await stores.operations.transition(channelId, op.opId, { status: "rejected" });
        alert("refund_rejected", rejected, 0, { code: error.code, apiCode: error.apiCode });
        return "rejected";
      }
      const failed = await stores.operations.transition(channelId, op.opId, { status: "failed" });
      retryAfter.set(`${channelId}/${op.opId}`, now() + backoffSeconds(failed.attempts, backoff));
      log("refund_failed", { channelId, opId: op.opId, attempts: failed.attempts, errorName: error instanceof Error ? error.name : "Error" }, "warn");
      return "failed";
    }

    // The buyer has been refunded. Record it; if the record cannot be written the operation
    // stays `pending` and the startup reconciliation finds the amount gone from the escrow.
    try {
      await stores.operations.transition(channelId, op.opId, { status: "confirmed", signature: result.sig });
      await markClosed(channelId);
    } catch (error) {
      alert("refund_confirmed_not_recorded", op, 0, { code: error instanceof Error ? error.name : "Error" });
      return "skipped";
    }
    retryAfter.delete(`${channelId}/${op.opId}`);
    log("refund_confirmed", { channelId, opId: op.opId });
    log("channel_closed", { channelId });
    return "refunded";
  }

  async function closeOnce(): Promise<CloseRunSummary> {
    return runs.run("run", async () => {
      const at = now();
      const summary = { idle: 0, due: 0, settled: 0, refunded: 0, closed: 0, failed: 0, rejected: 0, skipped: 0 };

      // Idle close: no activity for maxIdleSecs. The vendor had until now to claim; no grace.
      for (const channel of await stores.channels.list()) {
        if (channel.state !== "open" || at - channel.lastActivityAt < maxIdleSecs) continue;
        const after = await stores.channels.update(channel.channelId, (current) => {
          if (current === undefined || current.state !== "open" || now() - current.lastActivityAt < maxIdleSecs) return current as ChannelRecord;
          return { ...current, state: "closing", closingAt: now(), refundAfter: now() };
        });
        if (after.state === "closing" && after.closingAt === at) {
          summary.idle++;
          log("idle_close", { channelId: channel.channelId });
        }
      }

      // Due: closing channels past their grace. Vendor first, then the buyer, then closed.
      const due = (await stores.channels.list()).filter((c) => c.state === "closing" && c.refundAfter !== undefined && at >= c.refundAfter);
      summary.due = due.length;
      for (const channel of due) {
        let current = channel;
        if (current.accepted > current.settled) {
          const outcome = await redeemChannel(current);
          if (outcome === "confirmed") summary.settled++;
          else if (outcome === "failed" || outcome === "rejected") {
            summary[outcome]++;
            continue;
          } else {
            summary.skipped++;
            continue;
          }
          current = (await stores.channels.get(current.channelId)) ?? current;
          if (current.accepted > current.settled) {
            summary.skipped++;
            continue;
          }
        }
        const outcome = await refundChannel(current);
        if (outcome === "refunded") {
          summary.refunded++;
          summary.closed++;
        } else if (outcome === "closed") summary.closed++;
        else summary[outcome]++;
      }
      log("close_run", summary);
      return summary;
    });
  }

  async function reconcile(): Promise<ReconcileSummary> {
    return runs.run("run", async () => {
      const channels = await stores.channels.list();
      // Settle operations carry a period; a refund (`refund:1`) carries none and closes the channel when it is found sent.
      const pending: { op: OperationRecord; amount: bigint; period: number; settle?: SettlePayload }[] = [];
      let accountedOut = 0n;
      let deposits = 0n;
      for (const channel of channels) {
        deposits += channel.deposit;
        for (const op of await settleOps(channel.channelId)) {
          if (op.status === "confirmed") accountedOut += BigInt(payloadOf(op).amount);
          else if (op.status === "pending") {
            const settle = payloadOf(op);
            pending.push({ op, amount: BigInt(settle.amount), period: settle.period, settle });
          }
        }
        for (const op of (await stores.operations.list(channel.channelId)).filter(isRefund)) {
          if (op.status === "confirmed") accountedOut += BigInt(refundPayloadOf(op).amount);
          else if (op.status === "pending") pending.push({ op, amount: BigInt(refundPayloadOf(op).amount), period: 0 });
        }
      }
      const summary = { pending: pending.length, sent: 0, unsent: 0 };
      if (pending.length === 0) return summary;

      // What the escrow should hold if no pending transfer went out, against what it holds.
      const balance = await binding.privateBalance();
      let deficit = deposits - accountedOut - balance;
      pending.sort((a, b) => a.op.channelId.localeCompare(b.op.channelId) || a.period - b.period);
      for (const { op, amount, period, settle } of pending) {
        const refund = settle === undefined;
        if (deficit >= amount) {
          deficit -= amount;
          if (settle !== undefined) {
            await advanceSettled(op.channelId, BigInt(settle.cumulative));
            await stores.operations.transition(op.channelId, op.opId, { status: "confirmed", receipt: { reconciled: true, period: settle.period, cumulative: settle.cumulative, amount: settle.amount } });
          } else {
            await stores.operations.transition(op.channelId, op.opId, { status: "confirmed", receipt: { reconciled: true, amount: amount.toString() } });
            await markClosed(op.channelId);
          }
          alert(refund ? "refund_reconciled_sent" : "settle_reconciled_sent", op, period);
          summary.sent++;
        } else {
          const failed = await stores.operations.transition(op.channelId, op.opId, { status: "failed" });
          retryAfter.set(`${op.channelId}/${op.opId}`, now() + backoffSeconds(failed.attempts, backoff));
          alert(refund ? "refund_reconciled_unsent" : "settle_reconciled_unsent", failed, period);
          summary.unsent++;
        }
      }
      log("reconcile", summary);
      return summary;
    });
  }

  return {
    signer,
    reconcile,
    runOnce,
    closeOnce,
    start(intervalMs) {
      if (timer !== undefined) return;
      const set = deps.setInterval ?? ((fn, ms) => setInterval(fn, ms));
      timer = set(() => {
        if (running) return;
        running = true;
        void runOnce()
          .then(() => closeOnce())
          .catch((error: unknown) => log("redeem_run_error", { errorName: error instanceof Error ? error.name : "Error" }, "error"))
          .finally(() => {
            running = false;
          });
      }, intervalMs);
    },
    stop() {
      if (timer === undefined) return;
      (deps.clearInterval ?? ((handle) => clearInterval(handle as ReturnType<typeof setInterval>)))(timer);
      timer = undefined;
    },
    alerts: () => [...alerts],
    async receipts(channelId) {
      const out: SettlementReceipt[] = [];
      for (const op of await settleOps(channelId)) {
        const r = op.receipt;
        if (op.status !== "confirmed" || r === undefined || typeof r.facilitatorSignature !== "string") continue;
        out.push({
          channelId,
          period: r.period as number,
          cumulative: r.cumulative as string,
          amount: r.amount as string,
          signature: r.signature as string,
          facilitatorSignature: r.facilitatorSignature,
        });
      }
      return out;
    },
  };
}

/** The signature the binding reported for a confirmed settle operation, when one was. */
export function settleSignatureOf(op: OperationRecord): Signature | undefined {
  return op.status === "confirmed" && op.signature !== undefined ? (op.signature as Signature) : undefined;
}

/** The channel's confirmed refund, when it has been sent: amount and the private transfer's signature (none after a reconciliation). */
export function refundOf(ops: readonly OperationRecord[]): { amount: string; signature: string | null } | undefined {
  const op = ops.find((o) => isRefund(o) && o.status === "confirmed");
  if (op === undefined) return undefined;
  return { amount: refundPayloadOf(op).amount, signature: op.signature ?? null };
}
