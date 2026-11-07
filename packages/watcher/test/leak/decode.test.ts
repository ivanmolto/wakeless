import fc from "fast-check";
import { describe, expect, it } from "vitest";
import { decodeInstruction, decodeTransaction, DISCRIMINATORS } from "../../src/leak/decode.js";
import { address, distributeData, ED25519, ed25519Data, entriesOf, openAccounts, openData, reclaimData, requestCloseData, sealData, settleAndSealData, settleData, topUpData, transaction, withdrawPayerData } from "./fixtures.js";

const CHANNEL = address("channel-1");
const PAYER = address("payer-1");
const PAYEE = address("vendor-1");
const FEE = address("facilitator-fee");
const CHANNEL_ATA = address("channelAta");
const PAYEE_ATA = address("payeeAta");
const FEE_ATA = address("feeAta");
const PAYER_ATA = address("payerAta");

describe("leak decode", () => {
  it("decodes open, settle, distribute, refund and seal fixtures", () => {
    const open = { payer: "payer-1", payee: "vendor-1", channel: "channel-1", deposit: 250000n, recipients: [{ label: "vendor-1", bps: 9900 }, { label: "facilitator-fee", bps: 100 }], openSlot: 123456789n };
    expect(decodeInstruction(openData(open), openAccounts(open))).toEqual({
      kind: "open",
      channel: CHANNEL,
      payer: PAYER,
      payee: PAYEE,
      mint: address("usdc"),
      deposit: 250000n,
      gracePeriod: 900,
      openSlot: 123456789n,
      recipients: entriesOf(open.recipients),
    });

    // The layout before `openSlot` (59 bytes for one recipient, 25 for none) decodes with openSlot null.
    const legacy = { ...open, legacy: true, recipients: [{ label: "vendor-1", bps: 10000 }] };
    expect(openData(legacy)).toHaveLength(59);
    expect(decodeInstruction(openData(legacy), openAccounts(legacy))).toMatchObject({ kind: "open", channel: CHANNEL, payer: PAYER, deposit: 250000n, openSlot: null, recipients: entriesOf(legacy.recipients) });
    expect(decodeInstruction(openData({ ...legacy, recipients: [] }), openAccounts(legacy))).toMatchObject({ kind: "open", openSlot: null, recipients: [] });
    // A byte more or less than either layout is not an open.
    expect(decodeInstruction(openData(open).subarray(0, 66), openAccounts(open))).toBeNull();
    expect(decodeInstruction(new Uint8Array([...openData(open), 0]), openAccounts(open))).toBeNull();

    // settle: the amount comes from the voucher beside it; without one it is null, the channel still named.
    const vouchers = new Map([[CHANNEL, 100000n]]);
    expect(decodeInstruction(settleData(), [CHANNEL, address("sysvar")], { vouchers, transfers: [], ownerOf: (a) => a })).toEqual({ kind: "settle", channel: CHANNEL, cumulativeAmount: 100000n });
    expect(decodeInstruction(settleData(), [CHANNEL, address("sysvar")])).toEqual({ kind: "settle", channel: CHANNEL, cumulativeAmount: null });

    // distribute: payouts are the transfers out of the channel's token account, owners from the balances.
    const transfers = [
      { amount: 99000n, source: CHANNEL_ATA, destination: PAYEE_ATA, outerIndex: 0, inner: true },
      { amount: 1000n, source: CHANNEL_ATA, destination: FEE_ATA, outerIndex: 0, inner: true },
    ];
    const owners = new Map([[PAYEE_ATA, PAYEE], [FEE_ATA, FEE]]);
    const distributeAccounts = [CHANNEL, PAYER, address("rentPayer"), CHANNEL_ATA, PAYER_ATA, PAYEE_ATA, address("treasuryAta"), address("usdc"), address("token"), address("eventAuthority"), address("self"), FEE_ATA];
    expect(decodeInstruction(distributeData(open.recipients), distributeAccounts, { vouchers: new Map(), transfers, ownerOf: (a) => owners.get(a) ?? a })).toEqual({
      kind: "distribute",
      channel: CHANNEL,
      payer: PAYER,
      recipients: entriesOf(open.recipients),
      payouts: [
        { destination: PAYEE_ATA, recipient: PAYEE, amount: 99000n },
        { destination: FEE_ATA, recipient: FEE, amount: 1000n },
      ],
    });

    // refund: withdrawPayer moves the unspent deposit back to the payer.
    const refund = [{ amount: 150000n, source: CHANNEL_ATA, destination: PAYER_ATA, outerIndex: 0, inner: true }];
    expect(decodeInstruction(withdrawPayerData(), [PAYER, CHANNEL, CHANNEL_ATA, PAYER_ATA, address("usdc"), address("token")], { vouchers: new Map(), transfers: refund, ownerOf: (a) => a })).toEqual({ kind: "withdrawPayer", channel: CHANNEL, payer: PAYER, refunded: 150000n });

    expect(decodeInstruction(sealData(), [CHANNEL])).toEqual({ kind: "seal", channel: CHANNEL });
    expect(decodeInstruction(settleAndSealData(true), [PAYEE, CHANNEL, address("sysvar")], { vouchers, transfers: [], ownerOf: (a) => a })).toEqual({ kind: "settleAndSeal", channel: CHANNEL, payee: PAYEE, hasVoucher: true, cumulativeAmount: 100000n });
    expect(decodeInstruction(settleAndSealData(false), [PAYEE, CHANNEL, address("sysvar")], { vouchers, transfers: [], ownerOf: (a) => a })).toEqual({ kind: "settleAndSeal", channel: CHANNEL, payee: PAYEE, hasVoucher: false, cumulativeAmount: null });
    expect(decodeInstruction(topUpData(5000n), [PAYER, CHANNEL, PAYER_ATA, CHANNEL_ATA, address("usdc"), address("token")])).toEqual({ kind: "topUp", channel: CHANNEL, payer: PAYER, amount: 5000n });
    expect(decodeInstruction(requestCloseData(), [PAYER, CHANNEL])).toEqual({ kind: "requestClose", channel: CHANNEL, payer: PAYER });
    expect(decodeInstruction(reclaimData(), [CHANNEL, address("rentPayer")])).toEqual({ kind: "reclaim", channel: CHANNEL });
    expect(Object.values(DISCRIMINATORS)).toEqual([1, 2, 3, 4, 5, 6, 7, 8, 9]);
  });

  it("refuses short accounts, unknown discriminators and empty data", () => {
    const open = { payer: "payer-1", payee: "vendor-1", channel: "channel-1", deposit: 1n, recipients: [{ label: "vendor-1", bps: 10000 }] };
    expect(decodeInstruction(openData(open), openAccounts(open).slice(0, 5))).toBeNull();
    expect(decodeInstruction(new Uint8Array([228]), [CHANNEL])).toBeNull();
    expect(decodeInstruction(new Uint8Array(0), [CHANNEL])).toBeNull();
    expect(decodeInstruction(null, [CHANNEL])).toBeNull();
    expect(decodeInstruction(settleAndSealData(true).subarray(0, 1), [PAYEE, CHANNEL])).toBeNull();
  });

  it("decodeTransaction reads the voucher from the Ed25519 instruction and skips failed transactions", () => {
    const tx = transaction({
      signature: "settle-1",
      slot: 10,
      blockTime: 1_760_000_000,
      instructions: [
        { programId: ED25519, data: ed25519Data("channel-1", 42000n), accounts: [] },
        { data: settleData(), accounts: [CHANNEL, address("sysvar")] },
      ],
    });
    expect(decodeTransaction(tx)).toEqual([{ signature: tx.signature, slot: 10, blockTime: 1_760_000_000, instruction: { kind: "settle", channel: CHANNEL, cumulativeAmount: 42000n } }]);
    expect(decodeTransaction({ ...tx, err: { InstructionError: [1, "Custom"] } })).toEqual([]);
    expect(decodeTransaction({ ...tx, onBaseLayer: false })).toEqual([]);
  });

  it("never throws on arbitrary data and accounts", () => {
    fc.assert(
      fc.property(fc.uint8Array({ maxLength: 400 }), fc.array(fc.constantFrom(CHANNEL, PAYER, PAYEE, FEE, CHANNEL_ATA), { maxLength: 16 }), (bytes, accounts) => {
        const result = decodeInstruction(bytes, accounts);
        if (result !== null) expect(Object.values(DISCRIMINATORS)).toContain(bytes[0]);
      }),
      { numRuns: 400 },
    );
  });
});
