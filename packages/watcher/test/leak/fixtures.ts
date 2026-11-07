// Synthetic fixtures for the leakage indexer's tests, built from the instruction layouts of
// the payment-channels codama IDL (`vendor/payment-channels/program/payment_channels/idl/
// payment_channels.json`). Addresses are deterministic 32-byte keys, never anyone's; a
// fixture per instruction, encoded the way the program reads it.
import { getBase58Decoder, type Address, type Signature } from "@solana/kit";
import { emptyBaseTransaction, type BaseTransaction, type LedgerInstruction, type TokenTransfer } from "../../src/parse.js";
import { ED25519_PROGRAM, PAYMENT_CHANNELS_PROGRAM, type DistributionEntry } from "../../src/reconstruct.js";

const base58 = getBase58Decoder();

/** A deterministic 32-byte key from a label: byte i is `hash(label, i)`. */
export function keyBytes(label: string): Uint8Array {
  const out = new Uint8Array(32);
  let h = 2166136261;
  for (const c of label) h = Math.imul(h ^ c.charCodeAt(0), 16777619) >>> 0;
  for (let i = 0; i < 32; i++) {
    h = Math.imul(h ^ i, 16777619) >>> 0;
    out[i] = (h >>> 24) & 0xff;
  }
  if (out.every((b) => b === 0)) out[0] = 1;
  return out;
}

export function address(label: string): Address {
  return base58.decode(keyBytes(label)) as Address;
}

export function signature(label: string): Signature {
  const bytes = new Uint8Array(64);
  bytes.set(keyBytes(`${label}:a`), 0);
  bytes.set(keyBytes(`${label}:b`), 32);
  return base58.decode(bytes) as Signature;
}

class Writer {
  private readonly parts: Uint8Array[] = [];
  u8(v: number): this {
    this.parts.push(new Uint8Array([v]));
    return this;
  }
  u16(v: number): this {
    const b = new Uint8Array(2);
    new DataView(b.buffer).setUint16(0, v, true);
    this.parts.push(b);
    return this;
  }
  u32(v: number): this {
    const b = new Uint8Array(4);
    new DataView(b.buffer).setUint32(0, v, true);
    this.parts.push(b);
    return this;
  }
  u64(v: bigint): this {
    const b = new Uint8Array(8);
    new DataView(b.buffer).setBigUint64(0, v, true);
    this.parts.push(b);
    return this;
  }
  bytes(b: Uint8Array): this {
    this.parts.push(b);
    return this;
  }
  pubkey(label: string): this {
    return this.bytes(keyBytes(label));
  }
  entries(list: readonly { label: string; bps: number }[]): this {
    this.u32(list.length);
    for (const e of list) this.pubkey(e.label).u16(e.bps);
    return this;
  }
  build(): Uint8Array {
    const total = this.parts.reduce((n, p) => n + p.byteLength, 0);
    const out = new Uint8Array(total);
    let offset = 0;
    for (const p of this.parts) {
      out.set(p, offset);
      offset += p.byteLength;
    }
    return out;
  }
}

export interface OpenFixture {
  readonly payer: string;
  readonly payee: string;
  readonly channel: string;
  readonly mint?: string;
  readonly deposit: bigint;
  readonly recipients: readonly { label: string; bps: number }[];
  readonly openSlot?: bigint;
  /** The layout before `openSlot` existed (mainnet opens of June and July 2026). */
  readonly legacy?: boolean;
}

export function openData(f: OpenFixture): Uint8Array {
  const w = new Writer().u8(1).u64(7n).u64(f.deposit).u32(900);
  if (!f.legacy) w.u64(f.openSlot ?? 1000n);
  return w.entries(f.recipients).build();
}

/** The IDL's account order for `open`. */
export function openAccounts(f: OpenFixture): Address[] {
  return [f.payer, "rentPayer", f.payee, f.mint ?? "usdc", "signer", f.channel, "payerAta", "channelAta", "token", "system", "rent", "ata", "eventAuthority", "self"].map(address);
}

export function settleData(): Uint8Array {
  return new Writer().u8(2).build();
}

export function topUpData(amount: bigint): Uint8Array {
  return new Writer().u8(3).u64(amount).build();
}

export function settleAndSealData(hasVoucher: boolean): Uint8Array {
  return new Writer().u8(4).u8(hasVoucher ? 1 : 0).build();
}

export function requestCloseData(): Uint8Array {
  return new Writer().u8(5).build();
}

export function sealData(): Uint8Array {
  return new Writer().u8(6).build();
}

export function distributeData(recipients: readonly { label: string; bps: number }[]): Uint8Array {
  return new Writer().u8(7).entries(recipients).build();
}

export function withdrawPayerData(): Uint8Array {
  return new Writer().u8(8).build();
}

export function reclaimData(): Uint8Array {
  return new Writer().u8(9).build();
}

export function entriesOf(list: readonly { label: string; bps: number }[]): DistributionEntry[] {
  return list.map((e) => ({ recipient: address(e.label), bps: e.bps }));
}

/**
 * An Ed25519 program instruction verifying one standard voucher (`0x56 0x01 ‖ channelId ‖
 * cumulativeAmount ‖ expiresAt`), with the key, the signature and the message in its own data.
 */
export function ed25519Data(channel: string, cumulativeAmount: bigint, signer = "facilitator"): Uint8Array {
  const header = new Writer().u8(1).u8(0).u16(48).u16(0xffff).u16(16).u16(0xffff).u16(112).u16(50).u16(0xffff).build();
  const message = new Writer().u8(0x56).u8(1).pubkey(channel).u64(cumulativeAmount).u64(0n).build();
  return new Writer().bytes(header).pubkey(signer).bytes(new Uint8Array(64)).bytes(message).build();
}

export interface TxFixture {
  readonly signature: string;
  readonly slot: number;
  readonly blockTime: number;
  readonly instructions: readonly { data: Uint8Array; accounts: readonly Address[]; programId?: Address }[];
  readonly transfers?: readonly TokenTransfer[];
  readonly tokenOwners?: ReadonlyMap<Address, Address>;
  readonly err?: unknown;
}

/** A parsed base-layer transaction as `parseBaseTransaction` would return it. */
export function transaction(f: TxFixture): BaseTransaction {
  const instructions: LedgerInstruction[] = f.instructions.map((ix, i) => ({ programId: ix.programId ?? PAYMENT_CHANNELS_PROGRAM, accounts: ix.accounts, data: ix.data, outerIndex: i, inner: false }));
  return {
    ...emptyBaseTransaction(signature(f.signature)),
    onBaseLayer: true,
    slot: f.slot,
    blockTime: f.blockTime,
    err: f.err ?? null,
    instructions,
    transfers: f.transfers ?? [],
    tokenOwners: f.tokenOwners ?? new Map(),
    programIds: [...new Set(instructions.map((ix) => ix.programId))],
  };
}

export const ED25519 = ED25519_PROGRAM;
