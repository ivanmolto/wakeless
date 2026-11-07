// The leakage indexer (task 11.3): page the program's signatures under a cap and a
// since-date, fetch each transaction, decode, aggregate, rebuild one payer's trajectory,
// and build the truncated snapshot. The reader is injected so tests run on recorded
// responses; the clock is a parameter. Nothing here writes a file.
import type { Address, Signature } from "@solana/kit";
import { parseBaseTransaction, type BaseTransaction } from "../parse.js";
import { reconstruct } from "../reconstruct.js";
import { aggregate, pickSamplePayer, signaturesOfPayer, type LeakAggregate } from "./aggregate.js";
import { decodeTransaction, type ChannelEvent } from "./decode.js";
import { buildSnapshot, PROGRAM_ID, type SampleTrajectory } from "./publish.js";
import type { MainnetReader, SignatureInfo } from "./rpc.js";
import type { LeakSnapshot, SnapshotX402scan } from "./snapshot.schema.js";

export const DEFAULT_MAX_SIGNATURES = 20_000;
export const PAGE_SIZE = 1000;

export interface TransactionCache {
  get(signature: Signature): unknown | undefined;
  set(signature: Signature, raw: unknown): void;
}

export interface IndexOptions {
  readonly reader: MainnetReader;
  readonly maxSignatures?: number;
  /** Signatures with a block time before this are not fetched; paging stops at the first one. */
  readonly since?: Date;
  readonly now: Date;
  readonly concurrency?: number;
  readonly cache?: TransactionCache;
  readonly x402scan: SnapshotX402scan;
  readonly log?: (line: string) => void;
}

export interface IndexResult {
  readonly snapshot: LeakSnapshot;
  readonly aggregate: LeakAggregate;
  readonly signatures: readonly SignatureInfo[];
  readonly events: readonly ChannelEvent[];
}

/** Newest first, as the RPC pages them; stops at the cap or at the first signature older than `since`. */
export async function collectSignatures(reader: MainnetReader, options: { readonly maxSignatures: number; readonly since?: Date; readonly pageSize?: number }): Promise<SignatureInfo[]> {
  const pageSize = options.pageSize ?? PAGE_SIZE;
  const sinceSeconds = options.since === undefined ? undefined : Math.floor(options.since.getTime() / 1000);
  const out: SignatureInfo[] = [];
  let before: Signature | undefined;
  while (out.length < options.maxSignatures) {
    const limit = Math.min(pageSize, options.maxSignatures - out.length);
    const page = await reader.listSignatures(PROGRAM_ID, { limit, ...(before === undefined ? {} : { before }) });
    if (page.length === 0) break;
    for (const info of page) {
      if (sinceSeconds !== undefined && info.blockTime !== null && info.blockTime < sinceSeconds) return out;
      out.push(info);
    }
    if (page.length < limit) break;
    before = page[page.length - 1]!.signature;
  }
  return out;
}

async function fetchAll(reader: MainnetReader, signatures: readonly SignatureInfo[], concurrency: number, cache: TransactionCache | undefined, log: (line: string) => void): Promise<Map<Signature, BaseTransaction>> {
  const parsed = new Map<Signature, BaseTransaction>();
  let next = 0;
  let done = 0;
  let fetched = 0;
  const worker = async (): Promise<void> => {
    for (;;) {
      const index = next++;
      const info = signatures[index];
      if (info === undefined) return;
      let raw = cache?.get(info.signature);
      if (raw === undefined) {
        raw = await reader.fetchTransaction(info.signature);
        cache?.set(info.signature, raw ?? null);
        fetched++;
      }
      parsed.set(info.signature, parseBaseTransaction(info.signature, raw ?? null));
      done++;
      if (done % 1000 === 0) log(`${done}/${signatures.length} transactions (${fetched} fetched, ${done - fetched} from cache)`);
    }
  };
  await Promise.all(Array.from({ length: Math.max(1, concurrency) }, worker));
  log(`${done}/${signatures.length} transactions (${fetched} fetched, ${done - fetched} from cache)`);
  return parsed;
}

function sampleTrajectory(agg: LeakAggregate, transactions: ReadonlyMap<Signature, BaseTransaction>): SampleTrajectory | null {
  const payer: Address | null = pickSamplePayer(agg);
  if (payer === null) return null;
  const txs = signaturesOfPayer(agg, payer).flatMap((s) => {
    const tx = transactions.get(s);
    return tx === undefined ? [] : [tx];
  });
  return { payer, channels: agg.channels.filter((c) => c.payer === payer).length, rebuilt: reconstruct(txs) };
}

export async function indexLeak(options: IndexOptions): Promise<IndexResult> {
  const log = options.log ?? (() => undefined);
  const maxSignatures = options.maxSignatures ?? DEFAULT_MAX_SIGNATURES;
  const signatures = await collectSignatures(options.reader, { maxSignatures, ...(options.since === undefined ? {} : { since: options.since }) });
  log(`${signatures.length} signatures (cap ${maxSignatures})`);
  const transactions = await fetchAll(options.reader, signatures, options.concurrency ?? 8, options.cache, log);

  const events: ChannelEvent[] = [];
  let failed = 0;
  for (const tx of transactions.values()) {
    if (tx.onBaseLayer && tx.err !== null && tx.err !== undefined) failed++;
    events.push(...decodeTransaction(tx));
  }
  const agg = aggregate(events);
  const times = signatures.flatMap((s) => (s.blockTime === null ? [] : [s.blockTime]));
  const iso = (t: number): string => new Date(t * 1000).toISOString();
  const snapshot = buildSnapshot(
    agg,
    {
      date: options.now.toISOString().slice(0, 10),
      rpcHost: options.reader.host,
      sample: {
        signaturesScanned: signatures.length,
        signaturesCap: maxSignatures,
        since: options.since === undefined ? null : options.since.toISOString().slice(0, 10),
        oldest: times.length === 0 ? null : iso(Math.min(...times)),
        newest: times.length === 0 ? null : iso(Math.max(...times)),
        transactionsFetched: transactions.size,
        transactionsFailed: failed,
        channelsWithoutOpen: agg.channelsWithoutOpen,
      },
      x402scan: options.x402scan,
    },
    sampleTrajectory(agg, transactions),
  );
  return { snapshot, aggregate: agg, signatures, events };
}

export { aggregate, medianOf, medianOfBig, pickSamplePayer, signaturesOfPayer, weekOf, type ChannelSummary, type Degree, type LeakAggregate, type WeekCount } from "./aggregate.js";
export { decodeInstruction, decodeTransaction, DISCRIMINATORS, type ChannelEvent, type ChannelInstruction, type DecodeContext, type InstructionKind, type Payout } from "./decode.js";
export { buildSnapshot, EXPLORER_URL, PROGRAM_ID, renderLeakage, sampleSentence, shorten, snapshotToJson, type SampleTrajectory, type SnapshotMeta } from "./publish.js";
export { assertMainnetRpcUrl, createMainnetReader, redactSecrets as redactRpcSecrets, type MainnetReader, type ReaderOptions, type SignatureInfo } from "./rpc.js";
export {
  latestLeakHeadline,
  ParseError as SnapshotParseError,
  parseLeakHeadline,
  parseLeakSnapshot,
  SNAPSHOT_SCHEMA,
  TRUNCATED_ADDRESS,
  type LeakHeadline,
  type LeakSnapshot,
  type SnapshotDegree,
  type SnapshotHeadline,
  type SnapshotSample,
  type SnapshotSettled,
  type SnapshotTrajectory,
  type SnapshotWeek,
  type SnapshotX402scan,
} from "./snapshot.schema.js";
