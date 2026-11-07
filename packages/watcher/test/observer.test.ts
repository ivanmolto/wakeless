import { signature as asSignature, type Address } from "@solana/kit";
import type { ObserverView } from "@wakeless/binding";
import { describe, expect, it } from "vitest";
import { formatFailures, observe, renderMarkdownTable, reportOf, reportToJson, runChecks, subjectFor, type Checkable, type RunDescription } from "../src/observer.js";
import { parseBaseTransaction } from "../src/parse.js";
import { createRecordedReader } from "../src/rpc.js";
import { BUYER, ESCROW, PUBLIC_PAYTO, PUBLIC_SIGNATURES, VENDORS, WAKELESS_SIGNATURES, publicRaw, wakelessRaw } from "./fixtures/index.js";

const SIG = asSignature("3yURCW9df5FsPC2nCYnnX5WdnhZFiihwwmTPdNrief2yWyK7bUyLv8FdWM6rBk4Zmt8LYxNdnpy6k36rm79BxpSC");
const VENDOR = VENDORS[0]!;
const OTHER = "4TzfDduj9WmgSNoDyk9tVBB6Dd6D8LhucrvmcjyTwQ79" as Address;
const VAULT_ATA = "TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r" as Address;

/** A base-layer view with nothing in it, to be given exactly one thing to find. */
function view(patch: Partial<ObserverView> & { accountKeys?: Address[]; instructions?: Checkable["instructions"] }): Checkable {
  return { signature: SIG, onBaseLayer: true, programIds: [], signers: [], plaintextAmounts: [], plaintextRecipients: [], memoText: [], feeTransfers: [], ...patch };
}

const SUBJECT = { label: "the vendors", addresses: [VENDOR], amounts: [100000n, 200000n, 300000n] };

function verdict(checks: ReturnType<typeof runChecks>): boolean[] {
  return checks.map((c) => c.pass);
}

const WAKELESS_RUN: RunDescription = {
  rail: "wakeless",
  buyer: BUYER,
  escrow: ESCROW,
  vendors: VENDORS,
  attributableAmounts: [100000n, 200000n, 300000n, 10010n, 20020n, 30030n],
  signatures: [
    { signature: WAKELESS_SIGNATURES.deposit, label: "channel deposit, vendor 1", party: "buyer" },
    { signature: WAKELESS_SIGNATURES.vaultDeposit, label: "vault deposit, 2 USDC", party: "buyer" },
    { signature: WAKELESS_SIGNATURES.vendorWithdraw, label: "vendor 1 withdraws 0.25 USDC", party: "vendor" },
  ],
};

describe("the four checks", () => {
  it("a fixture naming the vendor address fails check 1", () => {
    const checks = runChecks(view({ signers: [BUYER, VENDOR], accountKeys: [BUYER, VENDOR, OTHER] }), SUBJECT);
    expect(verdict(checks)).toEqual([false, true, true, true]);
    expect(checks[0]!.evidence).toEqual([`account key ${VENDOR}`]);
    // Without account keys (a binding's own view) the signer is still found.
    expect(verdict(runChecks(view({ signers: [VENDOR] }), SUBJECT))[0]).toBe(false);
    // A memo that quotes the address is the address in clear too.
    expect(verdict(runChecks(view({ memoText: [`x402:rcvauth:${VENDOR}`] }), SUBJECT))).toEqual([false, true, false, true]);
  });

  it("a fixture with a vendor-attributable amount fails check 2", () => {
    // The amount names no vendor anywhere, but it is one the owner paid to a vendor.
    const checks = runChecks(view({ plaintextAmounts: [{ amount: 300000n, kind: "transfer", source: OTHER, destination: VAULT_ATA }], plaintextRecipients: [VAULT_ATA] }), SUBJECT);
    expect(verdict(checks)).toEqual([true, false, true, true]);
    expect(checks[1]!.evidence[0]).toContain("equals an amount paid to a vendor");
    // A transfer to a token account the vendor owns is attributable through the owner, and names the vendor.
    const owned = runChecks(view({ plaintextAmounts: [{ amount: 7n, kind: "balanceDelta", destination: OTHER, owner: VENDOR }] }), SUBJECT);
    expect(verdict(owned)).toEqual([false, false, true, true]);
    // An amount sitting in a program's instruction data as a little-endian u64 is in plaintext too.
    const data = new Uint8Array([7, 0x40, 0x0d, 0x03, 0, 0, 0, 0, 0, 9]); // 200000 = 0x030d40
    const inData = runChecks(view({ instructions: [{ programId: OTHER, data }] }), SUBJECT);
    expect(verdict(inData)).toEqual([true, false, true, true]);
    expect(inData[1]!.evidence).toEqual(["instruction data of 4Tzf…wQ79 carries 200000 as a u64"]);
  });

  it("a fixture with a Memo instruction fails check 3", () => {
    const checks = runChecks(view({ programIds: ["MemoSq4gqABAXKb96qnH8TysNcWxMyWCqXgDLGmfcHr" as Address], memoText: ["x402:batch:7c585c91"] }), SUBJECT);
    expect(verdict(checks)).toEqual([true, true, false, true]);
    expect(checks[2]!.evidence).toEqual(['memo "x402:batch:7c585c91"']);
  });

  it("a fixture with a fee transfer naming the vendor fails check 4", () => {
    const checks = runChecks(view({ feeTransfers: [{ from: BUYER, to: VENDOR, lamports: 5000n }] }), SUBJECT);
    expect(checks[3]!.pass).toBe(false);
    expect(checks[3]!.evidence).toEqual([`5000 lamports ${BUYER} → ${VENDOR}`]);
    // A fee paid to anyone else is fine.
    expect(verdict(runChecks(view({ feeTransfers: [{ from: BUYER, to: OTHER, lamports: 5000n }] }), SUBJECT))).toEqual([true, true, true, true]);
  });

  it("a clean vault-deposit fixture passes all four checks", () => {
    const tx = parseBaseTransaction(WAKELESS_SIGNATURES.vaultDeposit, wakelessRaw[WAKELESS_SIGNATURES.vaultDeposit]);
    const checks = runChecks(tx, subjectFor(WAKELESS_RUN, "buyer"));
    expect(verdict(checks)).toEqual([true, true, true, true]);
    expect(checks.flatMap((c) => c.evidence)).toEqual([]);
    // The same transaction with the vault's owner declared a vendor would fail: the checks look, they do not assume.
    const vault = "EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG" as Address;
    expect(verdict(runChecks(tx, { label: "x", addresses: [vault] }))).toEqual([false, false, true, true]);
  });

  it("a signature that is not on the base layer passes all four: there is nothing to read", () => {
    expect(verdict(runChecks(parseBaseTransaction(SIG, null), SUBJECT))).toEqual([true, true, true, true]);
  });

  it("a vendor's own withdrawal is checked against the escrow and the buyer, and links to neither", () => {
    const tx = parseBaseTransaction(WAKELESS_SIGNATURES.vendorWithdraw, wakelessRaw[WAKELESS_SIGNATURES.vendorWithdraw]);
    const subject = subjectFor(WAKELESS_RUN, "vendor");
    expect(subject.label).toBe("the escrow and the buyer");
    expect(subject.addresses).toEqual([BUYER, ESCROW]);
    expect(verdict(runChecks(tx, subject))).toEqual([true, true, true, true]);
    // Against the vendors it fails by construction: the briefing's "recipient, asset, amount; source is the vault".
    expect(verdict(runChecks(tx, subjectFor(WAKELESS_RUN, "buyer")))).toEqual([false, false, true, true]);
  });
});

describe("observe", () => {
  it("every recorded Wakeless signature passes, and the report counts what the base layer shows", async () => {
    const report = await observe(WAKELESS_RUN, createRecordedReader(wakelessRaw));
    expect(report.failures).toEqual([]);
    expect(report.counts).toEqual({ signatures: 3, onBaseLayer: 2, notOnBaseLayer: 1 });
    expect(report.rows.map((r) => r.checkedAgainst)).toEqual(["the vendors", "the vendors", "the escrow and the buyer"]);
    expect(report.rows[0]).toMatchObject({ onBaseLayer: false, slot: null, programIds: [], signers: [] });
    const table = renderMarkdownTable(report);
    expect(table).toContain("not on the base layer");
    expect(table).toContain(`\`${WAKELESS_SIGNATURES.vaultDeposit}\``);
    expect(table).toContain("1 pass, 2 pass, 3 pass, 4 pass (the escrow and the buyer)");
    const json = JSON.parse(reportToJson(report)) as { rows: { plaintextAmounts: { amount: string }[] }[] };
    expect(json.rows[1]!.plaintextAmounts[0]!.amount).toBe("2000000");
  });

  it("the public rail fails checks 1 to 3 on every rail signature, as information, and fails nothing", async () => {
    const run: RunDescription = {
      rail: "public",
      buyer: "94BRf9UjVLdNUBGGeKuFqWSk4sA67EDtAmS9pm6RTjzT" as Address,
      vendors: [PUBLIC_PAYTO],
      attributableAmounts: [100000n],
      signatures: [
        { signature: PUBLIC_SIGNATURES.open, label: "open", party: "buyer" },
        { signature: PUBLIC_SIGNATURES.settle, label: "settle", party: "escrow" },
        { signature: PUBLIC_SIGNATURES.distribute, label: "distribute", party: "escrow" },
      ],
    };
    const report = await observe(run, createRecordedReader(publicRaw));
    expect(report.failures).toEqual([]);
    expect(report.rows.map((r) => r.checks.map((c) => c.pass))).toEqual([
      [false, false, false, true], // open: payTo in the instruction data; the deposit; two memos
      [true, false, true, true], // settle: no vendor address, but the voucher's cumulative amount sits in the Ed25519 data
      [false, false, false, true], // distribute: payTo in the data and its token account credited; the payout; the batch memo
    ]);
    expect(report.rows[0]!.checks[0]!.evidence).toEqual([`instruction data of CHNL…yGsX carries ${PUBLIC_PAYTO}`]);
    expect(report.rows[1]!.checks[1]!.evidence).toEqual(["instruction data of Ed25…1111 carries 100000 as a u64"]);
  });

  it("a failed check on the wakeless rail names the signature and the check, for the non-zero exit", () => {
    const tx = parseBaseTransaction(PUBLIC_SIGNATURES.distribute, publicRaw[PUBLIC_SIGNATURES.distribute]);
    const run: RunDescription = { ...WAKELESS_RUN, vendors: [PUBLIC_PAYTO], signatures: [{ signature: PUBLIC_SIGNATURES.distribute, label: "a public payout", party: "escrow" }] };
    const report = reportOf("wakeless", [
      { ...run.signatures[0]!, onBaseLayer: true, slot: tx.slot, blockTime: tx.blockTime, err: null, programIds: tx.programIds, signers: tx.signers, plaintextAmounts: tx.plaintextAmounts, plaintextRecipients: tx.plaintextRecipients, memoText: tx.memoText, feeTransfers: tx.feeTransfers, checkedAgainst: "the vendors", checks: runChecks(tx, subjectFor(run, "escrow")) },
    ]);
    expect(report.failures.map((f) => f.check)).toEqual([1, 2, 3]);
    const lines = formatFailures(report);
    expect(lines[0]).toMatch(new RegExp(`^FAIL check 1 \\(no vendor address\\) on ${PUBLIC_SIGNATURES.distribute} \\[a public payout\\]: `));
    expect(lines[0]).toContain(PUBLIC_PAYTO);
  });
});
