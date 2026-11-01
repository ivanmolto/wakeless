// The buyer side over a fake rail: what reaches the rail, what the payload carries, and
// what is refused before anything is sent. The rail fake does nothing private; the real one
// is `MagicBlockBuyer`, tested in its own package and on devnet.
import { randomBytes } from "node:crypto";
import type { Address, Signature } from "@solana/kit";
import { DEVNET_CAIP2, type BuyerBinding, type ClientRef } from "@wakeless/binding";
import { SCHEME_ID, clientRefOf, deriveChannelId, encodeBase58, publicKeyOf, verifyVoucher, type PaymentRequirements } from "@wakeless/scheme";
import { describe, expect, it } from "vitest";
import { DepositRefusedError, deposit } from "../src/index.js";

const USDC = "4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU";
const TEE_VALIDATOR = "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo";
const address = () => encodeBase58(randomBytes(32));

function requirements(escrow: string, overrides: Partial<PaymentRequirements> = {}): PaymentRequirements {
  return {
    scheme: SCHEME_ID,
    network: DEVNET_CAIP2,
    amount: "10000",
    asset: USDC,
    payTo: address(),
    maxTimeoutSeconds: 60,
    extra: { withdrawDelay: 900, tokenProgram: "TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA", escrowAddress: escrow, binding: "magicblock", teeValidator: TEE_VALIDATOR, privacyFeeBps: 10 },
    ...overrides,
  };
}

interface FakeRail extends BuyerBinding {
  calls: { to: Address; amount: bigint; ref: ClientRef }[];
  transportSaw: string[];
}

function fakeRail(teeValidator: string | undefined = TEE_VALIDATOR): FakeRail {
  const rail: FakeRail = {
    id: "magicblock",
    ...(teeValidator === undefined ? {} : { teeValidator: teeValidator as Address }),
    calls: [],
    transportSaw: [],
    network: () => DEVNET_CAIP2,
    async deposit(to, amount, ref) {
      rail.calls.push({ to, amount, ref });
      // What a transport would see: the request body, nothing else.
      rail.transportSaw.push(JSON.stringify({ to, amount: Number(amount), clientRefId: ref.id }));
      return { sig: encodeBase58(randomBytes(64)) as Signature, transaction: randomBytes(200).toString("base64") };
    },
  };
  return rail;
}

describe("client deposit", () => {
  it("makes the private transfer with the channel's clientRefId and builds the deposit payload", async () => {
    const escrow = address();
    const req = requirements(escrow);
    const buyer = { secretKey: new Uint8Array(randomBytes(32)) };
    const rail = fakeRail();
    const result = await deposit({ rail, requirements: req, buyer, salt: "7", amount: 1_000_000n, cumulative: 10_010n });

    const channelId = deriveChannelId({ buyer: publicKeyOf(buyer), escrowAddress: escrow, mint: USDC, salt: "7" });
    expect(result.channelId).toBe(channelId);
    expect(result.clientRef).toBe(clientRefOf(channelId));
    expect(rail.calls).toEqual([{ to: escrow, amount: 1_000_000n, ref: { id: clientRefOf(channelId) } }]);

    const { payload } = result;
    expect(payload.type).toBe("deposit");
    expect(payload.channelConfig).toEqual({ buyer: publicKeyOf(buyer), vendor: req.payTo, mint: USDC, salt: "7", withdrawDelay: 900 });
    expect(payload.depositSignature).toBe(result.signature);
    expect(payload.deposit.amount).toBe("1000000");
    expect(payload.deposit.transaction).toMatch(/^[A-Za-z0-9+/]+={0,2}$/);
    expect(payload.voucher).toMatchObject({ channelId, maxClaimableAmount: "10010", expiresAt: 0 });
    expect(verifyVoucher(publicKeyOf(buyer), payload.voucher)).toBe(true);
  });

  it("a top-up is the same call with the channel's salt and the next cumulative", async () => {
    const escrow = address();
    const req = requirements(escrow);
    const buyer = { secretKey: new Uint8Array(randomBytes(64)) };
    const rail = fakeRail();
    const first = await deposit({ rail, requirements: req, buyer, salt: "9", amount: 500_000n, cumulative: 10_010n });
    const topUp = await deposit({ rail, requirements: req, buyer, salt: "9", amount: 250_000n, cumulative: 20_020n });
    expect(topUp.channelId).toBe(first.channelId);
    expect(topUp.clientRef).toBe(first.clientRef);
    expect(topUp.payload.depositSignature).not.toBe(first.payload.depositSignature);
    expect(rail.calls.map((c) => c.ref.id)).toEqual([first.clientRef, first.clientRef]);
    expect(topUp.payload.voucher.maxClaimableAmount).toBe("20020");
  });

  it("refuses an accept this rail cannot serve before anything is sent", async () => {
    const escrow = address();
    const buyer = { secretKey: new Uint8Array(randomBytes(32)) };
    const base = { buyer, salt: "1", amount: 1_000_000n, cumulative: 10_010n };
    const cases: { name: string; rail: FakeRail; requirements: PaymentRequirements; code: string }[] = [
      { name: "scheme", rail: fakeRail(), requirements: requirements(escrow, { scheme: "batch-settlement" as never }), code: "unsupported_scheme" },
      { name: "binding", rail: fakeRail(), requirements: requirements(escrow, { extra: { ...requirements(escrow).extra, binding: "rings" } }), code: "invalid_payment_requirements" },
      { name: "network", rail: fakeRail(), requirements: requirements(escrow, { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" }), code: "invalid_network" },
      { name: "teeValidator", rail: fakeRail(), requirements: requirements(escrow, { extra: { ...requirements(escrow).extra, teeValidator: address() } }), code: "shielded_attestation_failed" },
      { name: "minDeposit", rail: fakeRail(), requirements: requirements(escrow, { extra: { ...requirements(escrow).extra, minDeposit: "2000000" } }), code: "invalid_batch_settlement_svm_deposit_below_min_deposit" },
      { name: "escrow", rail: fakeRail(), requirements: requirements("not-an-address"), code: "invalid_payload" },
    ];
    for (const c of cases) {
      const error = await deposit({ rail: c.rail, requirements: c.requirements, ...base }).catch((e: unknown) => e);
      expect(error, c.name).toBeInstanceOf(DepositRefusedError);
      expect((error as DepositRefusedError).code, c.name).toBe(c.code);
      expect(c.rail.calls, c.name).toHaveLength(0);
    }
    await expect(deposit({ rail: fakeRail(), requirements: requirements(escrow), ...base, amount: 0n })).rejects.toThrow(DepositRefusedError);
    // A rail without a TEE (no teeValidator) is not held to the accept's.
    const noTee = fakeRail(undefined);
    await expect(deposit({ rail: noTee, requirements: requirements(escrow), ...base })).resolves.toBeDefined();
    expect(noTee.calls).toHaveLength(1);
  });

  it("the buyer key never reaches the rail", async () => {
    const escrow = address();
    const secret = new Uint8Array(randomBytes(64));
    const rail = fakeRail();
    await deposit({ rail, requirements: requirements(escrow), buyer: { secretKey: secret }, salt: "3", amount: 1_000_000n, cumulative: 10_010n });
    const seed58 = encodeBase58(secret.subarray(0, 32));
    const full58 = encodeBase58(secret);
    const seedB64 = Buffer.from(secret.subarray(0, 32)).toString("base64");
    for (const seen of rail.transportSaw) {
      expect(seen).not.toContain(seed58);
      expect(seen).not.toContain(full58);
      expect(seen).not.toContain(seedB64);
      expect(seen).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
    }
    // Only the public key travels.
    expect(JSON.stringify(rail.calls, (_, v: unknown) => (typeof v === "bigint" ? v.toString() : v))).not.toContain(seed58);
  });
});
