// The hand-maintained description of a run under docs/watcher/: the owner's addresses, the
// amounts it paid, the signatures and who made each, and the owner's actual trajectory for
// compare(). Parsed as untrusted data.
import { isAddress, isSignature, type Address, type Signature } from "@solana/kit";
import type { Party, RunDescription, SignatureInput } from "./observer.js";
import type { Trajectory } from "./reconstruct.js";

export interface RunFile extends RunDescription {
  readonly title: string;
  /** The owner's view, for compare(). */
  readonly actual: Trajectory;
}

export class RunFileError extends Error {
  constructor(detail: string) {
    super(`run file: ${detail}`);
    this.name = "RunFileError";
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function address(value: unknown, field: string): Address {
  if (typeof value !== "string" || !isAddress(value)) throw new RunFileError(`${field} is not an address`);
  return value;
}

function addresses(value: unknown, field: string): Address[] {
  if (!Array.isArray(value)) throw new RunFileError(`${field} is not an array`);
  return value.map((v, i) => address(v, `${field}[${i}]`));
}

function amount(value: unknown, field: string): bigint {
  if (typeof value !== "string" || !/^(0|[1-9][0-9]*)$/.test(value)) throw new RunFileError(`${field} is not a decimal u64 string`);
  return BigInt(value);
}

function party(value: unknown, field: string): Party {
  if (value === "buyer" || value === "escrow" || value === "vendor") return value;
  throw new RunFileError(`${field} is not buyer, escrow or vendor`);
}

function trajectory(value: unknown, field: string): Trajectory {
  if (!isRecord(value)) throw new RunFileError(`${field} is not an object`);
  const vendors = addresses(value.vendors, `${field}.vendors`);
  const spendPerVendor: Record<Address, bigint> = {};
  if (!isRecord(value.spendPerVendor)) throw new RunFileError(`${field}.spendPerVendor is not an object`);
  for (const [vendor, spend] of Object.entries(value.spendPerVendor)) spendPerVendor[address(vendor, `${field}.spendPerVendor key`)] = amount(spend, `${field}.spendPerVendor.${vendor}`);
  const times = value.settlementTimes ?? [];
  if (!Array.isArray(times) || !times.every((t) => typeof t === "number" && Number.isSafeInteger(t))) throw new RunFileError(`${field}.settlementTimes is not an array of integers`);
  return {
    ...(value.payer === undefined ? {} : { payer: address(value.payer, `${field}.payer`) }),
    vendors,
    firstContactOrder: value.firstContactOrder === undefined ? vendors : addresses(value.firstContactOrder, `${field}.firstContactOrder`),
    spendPerVendor,
    settlementTimes: times as number[],
  };
}

export function parseRunFile(json: unknown): RunFile {
  if (!isRecord(json)) throw new RunFileError("not an object");
  if (json.rail !== "wakeless" && json.rail !== "public") throw new RunFileError("rail is not wakeless or public");
  if (typeof json.title !== "string") throw new RunFileError("title is not a string");
  if (!Array.isArray(json.signatures)) throw new RunFileError("signatures is not an array");
  const signatures: SignatureInput[] = json.signatures.map((entry, i) => {
    if (!isRecord(entry)) throw new RunFileError(`signatures[${i}] is not an object`);
    if (typeof entry.signature !== "string" || !isSignature(entry.signature)) throw new RunFileError(`signatures[${i}].signature is not a signature`);
    if (typeof entry.label !== "string") throw new RunFileError(`signatures[${i}].label is not a string`);
    return { signature: entry.signature as Signature, label: entry.label, party: party(entry.party, `signatures[${i}].party`) };
  });
  const tokenAccounts: Record<string, Address[]> = {};
  if (json.tokenAccounts !== undefined) {
    if (!isRecord(json.tokenAccounts)) throw new RunFileError("tokenAccounts is not an object");
    for (const [owner, list] of Object.entries(json.tokenAccounts)) tokenAccounts[address(owner, "tokenAccounts key")] = addresses(list, `tokenAccounts.${owner}`);
  }
  const attributable = json.attributableAmounts ?? [];
  if (!Array.isArray(attributable)) throw new RunFileError("attributableAmounts is not an array");
  return {
    rail: json.rail,
    title: json.title,
    buyer: address(json.buyer, "buyer"),
    ...(json.escrow === undefined ? {} : { escrow: address(json.escrow, "escrow") }),
    vendors: addresses(json.vendors, "vendors"),
    tokenAccounts,
    attributableAmounts: attributable.map((a, i) => amount(a, `attributableAmounts[${i}]`)),
    signatures,
    actual: trajectory(json.actual, "actual"),
  };
}
