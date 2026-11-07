// One synthetic channel set with known counts, shared by the aggregate and publish tests.
//
//   payer-1 → vendor-1, vendor-2, vendor-3 (three channels, one each; vendor-1 with a fee recipient)
//   payer-2 → vendor-1 (two channels)
//   payer-3 → vendor-1 (one channel)
//   channel-7: seen through a settle only; its open is outside the window
//
// Every open puts the facilitator's sponsor key in the `payee` seat (the x402 SVM profile); the
// vendor is the distribution's recipient. 7 channels, 3 payers, 3 payTo, 5 relationships, 1 payer
// with two or more payTo, channels per payer [3, 2, 1] (median 2, max 3), vendor-1 degree 3
// payers / 4 channels, 1 payee seat.
import type { Address } from "@solana/kit";
import { decodeTransaction, type ChannelEvent } from "../../src/leak/decode.js";
import type { BaseTransaction, TokenTransfer } from "../../src/parse.js";
import { address, distributeData, ED25519, ed25519Data, openAccounts, openData, sealData, settleData, transaction, withdrawPayerData } from "./fixtures.js";

const MONDAY_29_JUN_2026 = 1_782_691_200; // 2026-06-29T00:00:00Z
const DAY = 86_400;

interface Channel {
  readonly channel: string;
  readonly payer: string;
  readonly payee: string;
  readonly deposit: bigint;
  readonly settled: bigint;
  readonly openedAt: number;
  readonly fee?: boolean;
  readonly refund?: bigint;
}

export const CHANNELS: readonly Channel[] = [
  { channel: "channel-1", payer: "payer-1", payee: "vendor-1", deposit: 1_000_000n, settled: 300_000n, openedAt: MONDAY_29_JUN_2026 + DAY, fee: true, refund: 700_000n },
  { channel: "channel-2", payer: "payer-1", payee: "vendor-2", deposit: 500_000n, settled: 100_000n, openedAt: MONDAY_29_JUN_2026 + 2 * DAY },
  { channel: "channel-3", payer: "payer-1", payee: "vendor-3", deposit: 500_000n, settled: 0n, openedAt: MONDAY_29_JUN_2026 + 9 * DAY },
  { channel: "channel-4", payer: "payer-2", payee: "vendor-1", deposit: 200_000n, settled: 50_000n, openedAt: MONDAY_29_JUN_2026 + 10 * DAY },
  { channel: "channel-5", payer: "payer-2", payee: "vendor-1", deposit: 200_000n, settled: 200_000n, openedAt: MONDAY_29_JUN_2026 + 20 * DAY },
  { channel: "channel-6", payer: "payer-3", payee: "vendor-1", deposit: 100_000n, settled: 20_000n, openedAt: MONDAY_29_JUN_2026 + 21 * DAY },
];

export function syntheticTransactions(): BaseTransaction[] {
  const txs: BaseTransaction[] = [];
  let slot = 100;
  for (const c of CHANNELS) {
    const recipients = c.fee ? [{ label: c.payee, bps: 9900 }, { label: "facilitator-fee", bps: 100 }] : [{ label: c.payee, bps: 10000 }];
    const open = { payer: c.payer, payee: "facilitator-seat", channel: c.channel, deposit: c.deposit, recipients, legacy: c.channel === "channel-6" };
    txs.push(transaction({ signature: `${c.channel}:open`, slot: slot++, blockTime: c.openedAt, instructions: [{ data: openData(open), accounts: openAccounts(open) }] }));
    if (c.settled > 0n) {
      // Two settles, the second with the final cumulative amount; the ledger shows the max.
      txs.push(transaction({ signature: `${c.channel}:settle-1`, slot: slot++, blockTime: c.openedAt + 3600, instructions: [{ programId: ED25519, data: ed25519Data(c.channel, c.settled / 2n), accounts: [] }, { data: settleData(), accounts: [address(c.channel), address("sysvar")] }] }));
      txs.push(transaction({ signature: `${c.channel}:settle-2`, slot: slot++, blockTime: c.openedAt + 7200, instructions: [{ programId: ED25519, data: ed25519Data(c.channel, c.settled), accounts: [] }, { data: settleData(), accounts: [address(c.channel), address("sysvar")] }] }));
      const channelAta = address(`${c.channel}:ata`);
      const payeeAta = address(`${c.payee}:ata`);
      const transfers: TokenTransfer[] = [{ amount: c.fee ? (c.settled * 99n) / 100n : c.settled, source: channelAta, destination: payeeAta, outerIndex: 0, inner: true }];
      const owners = new Map<Address, Address>([[payeeAta, address(c.payee)]]);
      if (c.fee) {
        const feeAta = address("facilitator-fee:ata");
        transfers.push({ amount: c.settled / 100n, source: channelAta, destination: feeAta, outerIndex: 0, inner: true });
        owners.set(feeAta, address("facilitator-fee"));
      }
      const accounts = [address(c.channel), address(c.payer), address("rentPayer"), channelAta, address(`${c.payer}:ata`), payeeAta, address("treasuryAta"), address("usdc"), address("token"), address("eventAuthority"), address("self")];
      txs.push(transaction({ signature: `${c.channel}:distribute`, slot: slot++, blockTime: c.openedAt + 8000, instructions: [{ data: distributeData(recipients), accounts }], transfers, tokenOwners: owners }));
    }
    if (c.refund !== undefined) {
      const channelAta = address(`${c.channel}:ata`);
      txs.push(transaction({ signature: `${c.channel}:seal`, slot: slot++, blockTime: c.openedAt + 9000, instructions: [{ data: sealData(), accounts: [address(c.channel)] }] }));
      txs.push(
        transaction({
          signature: `${c.channel}:refund`,
          slot: slot++,
          blockTime: c.openedAt + 9500,
          instructions: [{ data: withdrawPayerData(), accounts: [address(c.payer), address(c.channel), channelAta, address(`${c.payer}:ata`), address("usdc"), address("token")] }],
          transfers: [{ amount: c.refund, source: channelAta, destination: address(`${c.payer}:ata`), outerIndex: 0, inner: true }],
        }),
      );
    }
  }
  // channel-7: a settle whose open is older than the window.
  txs.push(transaction({ signature: "channel-7:settle", slot: slot++, blockTime: MONDAY_29_JUN_2026 + 25 * DAY, instructions: [{ programId: ED25519, data: ed25519Data("channel-7", 5_000n), accounts: [] }, { data: settleData(), accounts: [address("channel-7"), address("sysvar")] }] }));
  // A failed open counts for nothing.
  const failed = { payer: "payer-9", payee: "vendor-9", channel: "channel-9", deposit: 1n, recipients: [{ label: "vendor-9", bps: 10000 }] };
  txs.push(transaction({ signature: "channel-9:open-failed", slot, blockTime: MONDAY_29_JUN_2026 + 26 * DAY, instructions: [{ data: openData(failed), accounts: openAccounts(failed) }], err: { InstructionError: [0, "Custom"] } }));
  return txs;
}

export function syntheticEvents(): ChannelEvent[] {
  return syntheticTransactions().flatMap(decodeTransaction);
}

export const EXPECTED = {
  channels: 7,
  channelsOpened: 6,
  channelsWithoutOpen: 1,
  payers: 3,
  payTo: 3,
  relationships: 5,
  payersWithTwoOrMorePayTo: 1,
  channelsPerPayer: { median: 2, max: 3 },
  vendor1: { payers: 3, channels: 4 },
  /** Channels in the mint most channels use; channel-7's 5 000 has no readable mint and is counted, not summed. */
  settledValues: [300_000n, 100_000n, 50_000n, 200_000n, 20_000n],
  // Opens on 30 Jun, 1 Jul, 8 Jul, 9 Jul, 19 Jul (a Sunday) and 20 Jul (a Monday).
  weeks: [
    { week: "2026-06-29", channels: 2 },
    { week: "2026-07-06", channels: 2 },
    { week: "2026-07-13", channels: 1 },
    { week: "2026-07-20", channels: 1 },
  ],
} as const;
