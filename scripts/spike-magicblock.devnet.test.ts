// Devnet checks over the signatures recorded in docs/spike-log.md, fetched through the Helius RPC.
// Run with `pnpm test:devnet` (needs .env with HELIUS_API_KEY and SOLANA_RPC_URL).
import { readFileSync } from "node:fs";
import { resolve } from "node:path";
import { createSolanaRpc, signature as asSignature } from "@solana/kit";
import { expect, it } from "vitest";
import { assertDevnetRpcUrl } from "./lib/devnet.js";
import { skipUnless } from "./lib/skip-unless.js";

const root = resolve(import.meta.dirname, "..");
const MEMO_PROGRAM_IDS = ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr", "Memo1UhkJRfHyvLMcVucJwxXeuD728EqVDDwQDxFMNo"];

type Recorded = { layer: "base" | "ephemeral"; label: string; signature: string };

/** Parses the `layer label signature` lines of the log's Signatures block and the wallets line. */
function readLog(): { recorded: Recorded[]; vendor1: string; vendor1Ata: string; escrow: string } {
  const log = readFileSync(resolve(root, "docs/spike-log.md"), "utf8");
  const block = log.split("## Signatures")[1]?.split("```")[1] ?? "";
  const recorded: Recorded[] = [];
  for (const line of block.split("\n")) {
    const m = line.match(/^(base|ephemeral) (.*) ([1-9A-HJ-NP-Za-km-z]{87,88})$/);
    if (m) recorded.push({ layer: m[1] as Recorded["layer"], label: m[2]!, signature: m[3]! });
  }
  const vendor = log.match(/vendor1 `([1-9A-HJ-NP-Za-km-z]{32,44})` \(base ATA `([1-9A-HJ-NP-Za-km-z]{32,44})`\)/);
  const escrow = log.match(/escrow `([1-9A-HJ-NP-Za-km-z]{32,44})`/);
  if (!vendor || !escrow) throw new Error("docs/spike-log.md has no wallets line");
  return { recorded, vendor1: vendor[1]!, vendor1Ata: vendor[2]!, escrow: escrow[1]! };
}

type ParsedTx = {
  transaction: { message: { accountKeys: { pubkey: string }[]; instructions: { programId: string }[] } };
  meta: { innerInstructions?: { instructions: { programId: string }[] }[] } | null;
} | null;

async function fetchBase(sig: string): Promise<ParsedTx> {
  const rpcUrl = process.env.SOLANA_RPC_URL!;
  assertDevnetRpcUrl(rpcUrl);
  const rpc = createSolanaRpc(rpcUrl);
  return (await rpc
    .getTransaction(asSignature(sig), { encoding: "jsonParsed", maxSupportedTransactionVersion: 1 as unknown as 0, commitment: "confirmed" })
    .send()) as unknown as ParsedTx;
}

skipUnless("HELIUS_API_KEY", "spike signatures are checked against devnet")("spike-magicblock signatures on devnet", () => {
  it("escrow to vendor base-layer tx names no vendor ATA", async () => {
    const { recorded, vendor1, vendor1Ata } = readLog();
    const step4 = recorded.filter((r) => /^(pass \d+ )?escrow → vendor1/.test(r.label));
    expect(step4.length, "the log records at least one escrow → vendor1 transfer").toBeGreaterThan(0);
    for (const r of step4) {
      if (r.layer === "base") {
        const tx = await fetchBase(r.signature);
        expect(tx, `base-layer transaction ${r.signature} found`).not.toBeNull();
        const keys = tx!.transaction.message.accountKeys.map((k) => k.pubkey);
        expect(keys).not.toContain(vendor1Ata);
        expect(keys).not.toContain(vendor1);
      } else {
        // The transfer ran inside the rollup: its signature must not exist on the base layer at all.
        expect(await fetchBase(r.signature), `ephemeral signature ${r.signature} must not be on the base layer`).toBeNull();
      }
    }
  }, 120_000);

  it("no Memo instruction on any spike signature", async () => {
    const { recorded } = readLog();
    const base = recorded.filter((r) => r.layer === "base");
    expect(base.length).toBeGreaterThan(0);
    for (const r of base) {
      const tx = await fetchBase(r.signature);
      expect(tx, `base-layer transaction ${r.signature} found`).not.toBeNull();
      const programIds = [
        ...tx!.transaction.message.instructions.map((i) => i.programId),
        ...(tx!.meta?.innerInstructions ?? []).flatMap((i) => i.instructions.map((x) => x.programId)),
      ];
      for (const memo of MEMO_PROGRAM_IDS) expect(programIds, `${r.label} ${r.signature}`).not.toContain(memo);
    }
  }, 180_000);
});
