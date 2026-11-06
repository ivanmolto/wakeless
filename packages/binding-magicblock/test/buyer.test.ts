// The buyer's rail over the fake transport, and the round trip: what MagicBlockBuyer
// deposits, MagicBlockBinding.readDeposit confirms, through the same fake wire.
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { generateKeyPair, getAddressFromPublicKey, type Address } from "@solana/kit";
import { clientRefId, DEVNET_CAIP2, isBindingError, type BuyerBinding } from "@wakeless/binding";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { ApiError, InsufficientPrivateBalanceError, MagicBlockBinding, MagicBlockBuyer, decodeSignedTransaction, type EscrowKeyPair } from "../src/index.js";
import { BASE_RPC, FakeTransport, PAYMENTS_API, TEE_RPC, USDC, VALIDATOR, type FakeTransportOptions } from "./fake-transport.js";

const USDC_UNITS = 1_000_000n;

let escrow: EscrowKeyPair;
let escrowAddress: Address;
let escrowAta: Address;
let buyer: EscrowKeyPair;
let buyerAddress: Address;
let buyerAta: Address;

beforeAll(async () => {
  escrow = await generateKeyPair();
  escrowAddress = await getAddressFromPublicKey(escrow.publicKey);
  [escrowAta] = await findAssociatedTokenPda({ owner: escrowAddress, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
  buyer = await generateKeyPair();
  buyerAddress = await getAddressFromPublicKey(buyer.publicKey);
  [buyerAta] = await findAssociatedTokenPda({ owner: buyerAddress, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
});

function fake(buyerBalance = 5n * USDC_UNITS, opts: Partial<FakeTransportOptions> = {}): FakeTransport {
  return new FakeTransport({ escrowAddress, escrowAta, balance: 510_000n, wallets: new Map([[buyerAddress, { ata: buyerAta, balance: buyerBalance }]]), ...opts });
}

const common = () => ({ network: DEVNET_CAIP2, baseRpcUrl: BASE_RPC, teeRpcUrl: TEE_RPC, paymentsApiUrl: PAYMENTS_API, mint: USDC, confirm: { attempts: 3, intervalMs: 1 }, sleep: async () => {} });

describe("MagicBlockBuyer over a fake transport", () => {
  it("attests, logs the buyer in and exposes the attested validator", async () => {
    const transport = fake();
    const rail = await MagicBlockBuyer.create({ ...common(), transport, buyer });
    expectTypeOf(rail).toMatchTypeOf<BuyerBinding>();
    expect(rail.id).toBe("magicblock");
    expect(rail.network()).toBe(DEVNET_CAIP2);
    expect(rail.address()).toBe(buyerAddress);
    expect(rail.teeValidator).toBe(VALIDATOR);
    expect(rail.attestation.verified).toBe(true);
    expect(transport.calls("GET", "/v1/spl/challenge")[0]!.path).toContain(`pubkey=${buyerAddress}`);
    expect(await rail.privateBalance()).toBe(5n * USDC_UNITS);
  });

  it("attestation failure refuses construction", async () => {
    const transport = fake(5n * USDC_UNITS, { attest: async () => false });
    const error = await MagicBlockBuyer.create({ ...common(), transport, buyer }).catch((e: unknown) => e);
    expect(isBindingError(error, "shielded_attestation_failed")).toBe(true);
    expect(transport.apiCalls).toHaveLength(0);
  });

  it("deposits with a private ephemeral transfer carrying the clientRefId, signed by the buyer, and no memo", async () => {
    const transport = fake();
    const rail = await MagicBlockBuyer.create({ ...common(), transport, buyer });
    const { sig, transaction } = await rail.deposit(escrowAddress, USDC_UNITS, { id: clientRefId("1001") });

    const [body] = transport.transferBodies();
    expect(body).toEqual({ from: buyerAddress, to: escrowAddress, cluster: "devnet-private", mint: USDC, amount: 1_000_000, visibility: "private", fromBalance: "ephemeral", toBalance: "ephemeral", clientRefId: "1001", initAtasIfMissing: true });
    expect(body).not.toHaveProperty("memo");
    expect(transport.calls("POST", "/v1/spl/transfer")[0]!.token).toBe("api.token.part3.part4");
    const send = transport.teeCalls.find((c) => c.method === "sendTransaction")!;
    expect(send.token).toMatch(/^tee-token-for-/);
    expect(send.params[0]).toBe(transaction);

    const decoded = decodeSignedTransaction(transaction);
    expect(decoded.signature).toBe(sig);
    expect(decoded.signers).toEqual([buyerAddress]);
    expect(decoded.memo).toBe(false);
    expect(decoded.transfers).toEqual([{ source: buyerAta, destination: escrowAta, authority: buyerAddress, amount: USDC_UNITS }]);
  });

  it("the deposit the buyer made is what the escrow's binding confirms", async () => {
    const transport = fake();
    const rail = await MagicBlockBuyer.create({ ...common(), transport, buyer });
    const binding = await MagicBlockBinding.create({ ...common(), transport, escrow });
    const ref = clientRefId("1001");
    const { sig, transaction } = await rail.deposit(escrowAddress, USDC_UNITS, { id: ref });
    transport.balance += USDC_UNITS; // the rollup credited the escrow
    expect(await binding.readDeposit(sig, { id: ref, buyer: buyerAddress, amount: USDC_UNITS, transaction })).toEqual({ amount: USDC_UNITS, buyer: buyerAddress });
    // Not for another amount, and not twice.
    expect(await binding.readDeposit(sig, { id: ref, buyer: buyerAddress, amount: USDC_UNITS + 1n, transaction })).toBeNull();
    expect(await binding.readDeposit(sig, { id: ref, buyer: buyerAddress, amount: USDC_UNITS, transaction })).toBeNull();
    // Bytes that are not a transaction are not the one behind the signature.
    expect(await binding.readDeposit(sig, { id: ref, buyer: buyerAddress, amount: USDC_UNITS, transaction: "AQID" })).toBeNull();
  });

  it("fails loudly and sends nothing when the private balance is short, the route is refused or the build is public", async () => {
    const short = fake(USDC_UNITS - 1n);
    const r1 = await MagicBlockBuyer.create({ ...common(), transport: short, buyer });
    await expect(r1.deposit(escrowAddress, USDC_UNITS, { id: clientRefId("1") })).rejects.toBeInstanceOf(InsufficientPrivateBalanceError);
    expect(short.transferBodies()).toHaveLength(0);

    const refused = fake(5n * USDC_UNITS, { transfer: async () => { throw new ApiError("POST /v1/spl/transfer", 400, "UNSUPPORTED_TRANSFER_ROUTE", "no"); } });
    const r2 = await MagicBlockBuyer.create({ ...common(), transport: refused, buyer });
    const e2 = await r2.deposit(escrowAddress, USDC_UNITS, { id: clientRefId("1") }).catch((e: unknown) => e);
    expect(isBindingError(e2, "shielded_binding_rejected")).toBe(true);
    expect(refused.teeCalls.filter((c) => c.method === "sendTransaction")).toHaveLength(0);

    const base = fake(5n * USDC_UNITS, {
      transfer: async (body) => ({ ...(await fake().api({ method: "POST", path: "/v1/spl/transfer", body }) as Record<string, unknown>), sendTo: "base", sendRpcEndpoint: undefined }),
    });
    const r3 = await MagicBlockBuyer.create({ ...common(), transport: base, buyer });
    const e3 = await r3.deposit(escrowAddress, USDC_UNITS, { id: clientRefId("1") }).catch((e: unknown) => e);
    expect(isBindingError(e3, "shielded_binding_rejected")).toBe(true);
    expect((e3 as { apiCode?: string }).apiCode).toBe("SEND_TO_BASE");
    expect(base.teeCalls.filter((c) => c.method === "sendTransaction")).toHaveLength(0);
    for (const t of [short, refused, base]) expect(t.apiCalls.some((c) => (c.body as Record<string, unknown> | undefined)?.visibility === "public")).toBe(false);
    await expect(r1.deposit(escrowAddress, 0n, { id: clientRefId("1") })).rejects.toThrow(RangeError);
  });
});

describe("MagicBlockBuyer withdrawal (task 8.1)", () => {
  it("withdraws to the base layer with a buyer-signed public transaction, and only when asked", async () => {
    const transport = fake(3n * USDC_UNITS);
    const rail = await MagicBlockBuyer.create({ ...common(), transport, buyer });
    expect(transport.calls("POST", "/v1/spl/withdraw")).toHaveLength(0);
    expect(transport.baseSubmits).toHaveLength(0);

    const { sig } = await rail.withdraw(1_499_500n);
    const builds = transport.calls("POST", "/v1/spl/withdraw");
    expect(builds).toHaveLength(1);
    expect(builds[0]!.body).toEqual({ owner: buyerAddress, cluster: "devnet-private", mint: USDC, amount: 1_499_500, initAtasIfMissing: true, idempotent: true });
    expect(builds[0]!.token).toBe("api.token.part3.part4");
    // Signed by the buyer, submitted to the base RPC, never to the TEE RPC.
    expect(transport.baseSubmits).toHaveLength(1);
    expect(transport.baseSubmits[0]!.signature).toBe(sig);
    expect(decodeSignedTransaction(transport.baseSubmits[0]!.wire).signers).toEqual([buyerAddress]);
    expect(transport.teeCalls.filter((c) => c.method === "sendTransaction")).toHaveLength(0);

    // A short private balance, or a builder that routes elsewhere, sends nothing.
    await expect(rail.withdraw(4n * USDC_UNITS)).rejects.toBeInstanceOf(InsufficientPrivateBalanceError);
    const elsewhere = fake(3n * USDC_UNITS, { withdraw: async (body) => ({ ...(await transport.api({ method: "POST", path: "/v1/spl/withdraw", body })) as object, sendTo: "ephemeral" }) });
    const other = await MagicBlockBuyer.create({ ...common(), transport: elsewhere, buyer });
    await expect(other.withdraw(1n)).rejects.toThrow(/base layer/);
    expect(elsewhere.baseSubmits).toHaveLength(0);
    expect(transport.baseSubmits).toHaveLength(1);
  });
});
