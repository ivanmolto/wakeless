// Local decode of a client-signed transfer: the only place the buyer and the amount of a
// deposit can be read, since the enclave returns neither (docs/spike-log.md; probe of
// 31 Oct 2026). Pure, no I/O.
import {
  identifyTokenInstruction,
  parseTransferCheckedInstruction,
  parseTransferInstruction,
  TOKEN_PROGRAM_ADDRESS,
  TokenInstruction,
} from "@solana-program/token";
import {
  decompileTransactionMessage,
  getBase64Encoder,
  getCompiledTransactionMessageDecoder,
  getSignatureFromTransaction,
  getTransactionDecoder,
  type Address,
  type Signature,
} from "@solana/kit";
import { MEMO_PROGRAM_IDS } from "./observe.js";

export interface DecodedTransfer {
  readonly source: Address;
  readonly destination: Address;
  readonly authority: Address;
  readonly amount: bigint;
  readonly mint?: Address;
}

export interface DecodedSignedTransaction {
  readonly signature: Signature;
  /** Addresses whose signature slot is filled. */
  readonly signers: readonly Address[];
  readonly transfers: readonly DecodedTransfer[];
  readonly memo: boolean;
}

export class UndecodableTransactionError extends Error {
  constructor(detail: string, options?: { cause?: unknown }) {
    super(`signed transaction cannot be decoded: ${detail}`, options);
    this.name = "UndecodableTransactionError";
  }
}

/**
 * Decodes a base64 wire transaction. A message that needs address lookup tables cannot be
 * verified offline and is refused rather than guessed at.
 */
export function decodeSignedTransaction(base64: string): DecodedSignedTransaction {
  if (!/^[A-Za-z0-9+/]+={0,2}$/.test(base64)) throw new UndecodableTransactionError("not base64");
  let bytes: ReturnType<ReturnType<typeof getBase64Encoder>["encode"]>;
  try {
    bytes = getBase64Encoder().encode(base64);
  } catch (error) {
    throw new UndecodableTransactionError("not base64", { cause: error });
  }
  try {
    const tx = getTransactionDecoder().decode(bytes);
    const compiled = getCompiledTransactionMessageDecoder().decode(tx.messageBytes);
    if ("addressTableLookups" in compiled && Array.isArray(compiled.addressTableLookups) && compiled.addressTableLookups.length > 0) {
      throw new UndecodableTransactionError("message uses address lookup tables");
    }
    const message = decompileTransactionMessage(compiled);
    const signers = Object.entries(tx.signatures)
      .filter(([, sig]) => sig !== null)
      .map(([addr]) => addr as Address);
    const transfers: DecodedTransfer[] = [];
    let memo = false;
    for (const ix of message.instructions) {
      if (MEMO_PROGRAM_IDS.has(ix.programAddress)) memo = true;
      if (ix.programAddress !== TOKEN_PROGRAM_ADDRESS || !ix.data) continue;
      const kind = identifyTokenInstruction(ix.data);
      if (kind === TokenInstruction.Transfer) {
        const p = parseTransferInstruction(ix as Parameters<typeof parseTransferInstruction>[0]);
        transfers.push({ source: p.accounts.source.address, destination: p.accounts.destination.address, authority: p.accounts.authority.address, amount: p.data.amount });
      } else if (kind === TokenInstruction.TransferChecked) {
        const p = parseTransferCheckedInstruction(ix as Parameters<typeof parseTransferCheckedInstruction>[0]);
        transfers.push({ source: p.accounts.source.address, destination: p.accounts.destination.address, authority: p.accounts.authority.address, amount: p.data.amount, mint: p.accounts.mint.address });
      }
    }
    return { signature: getSignatureFromTransaction(tx), signers, transfers, memo };
  } catch (error) {
    if (error instanceof UndecodableTransactionError) throw error;
    throw new UndecodableTransactionError(error instanceof Error ? error.name : "decode failed", { cause: error });
  }
}
