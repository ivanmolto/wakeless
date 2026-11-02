// The vendor's read-only view over the fake transport: attests, logs the vendor in, reads
// its private balance and the reference ids beside it, and asks the TEE whether a transfer
// landed, with the vendor's own TEE login. It builds and sends nothing.
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { generateKeyPair, getAddressFromPublicKey, signature as asSignature, type Address } from "@solana/kit";
import { DEVNET_CAIP2, isBindingError, type PayeeBinding } from "@wakeless/binding";
import { beforeAll, describe, expect, expectTypeOf, it } from "vitest";
import { MagicBlockPayee, type EscrowKeyPair } from "../src/index.js";
import { BASE_RPC, FakeTransport, PAYMENTS_API, TEE_RPC, USDC, teeTransactionAsObserved, type FakeTransportOptions } from "./fake-transport.js";

const LANDED = asSignature("5XKE2bt32CvgwRSNc4iaESJUd397WQLut7xHSudQK18YnGXACvEMLAsMU7AVAmy4BL66PpGxxPsx2ntc2Lz319bp");
const FAILED = asSignature("HkLhGamKri8TLU7MCAoxggWr7TthinnQHCMN9DpUG2DA9xgHLzXkhqAzQEADyBHSsHB36BvnHJxk8CWUnncTRVn");
const MISSING = asSignature("2JjvPa9kXC17oVmiZh49evtGu1xExduy2Fr9kDvDrn2kNGq6fXYUM5yYBYWS2XFdeoZy4J1ttpTdag2d7X8bdvTN");

let vendor: EscrowKeyPair;
let vendorAddress: Address;
let vendorAta: Address;

beforeAll(async () => {
  vendor = await generateKeyPair();
  vendorAddress = await getAddressFromPublicKey(vendor.publicKey);
  [vendorAta] = await findAssociatedTokenPda({ owner: vendorAddress, mint: USDC, tokenProgram: TOKEN_PROGRAM_ADDRESS });
});

function fake(opts: Partial<FakeTransportOptions> = {}): FakeTransport {
  const escrow = "EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6" as Address;
  return new FakeTransport({ escrowAddress: escrow, escrowAta: "7TE7c8ZiHH1VbKHCqGGWxCTgFKmhde2R7npNWqNcVh7H" as Address, wallets: new Map([[vendorAddress, { ata: vendorAta, balance: 760_000n }]]), ...opts });
}

const common = () => ({ network: DEVNET_CAIP2, baseRpcUrl: BASE_RPC, teeRpcUrl: TEE_RPC, paymentsApiUrl: PAYMENTS_API, mint: USDC });

describe("MagicBlockPayee over a fake transport", () => {
  it("attests, logs the vendor in, reads its balance and finds no reference ids", async () => {
    const transport = fake();
    const payee = await MagicBlockPayee.create({ ...common(), transport, payee: vendor });
    expectTypeOf(payee).toMatchTypeOf<PayeeBinding>();
    expect(payee.attestation.verified).toBe(true);
    expect(payee.address()).toBe(vendorAddress);
    expect(payee.network()).toBe(DEVNET_CAIP2);
    expect(await payee.privateBalance()).toEqual({ balance: 760_000n, referenceIds: [] });
    const read = transport.calls("GET", "/v1/spl/private-balance")[0]!;
    expect(read.path).toContain(`address=${vendorAddress}`);
    expect(read.token).toBe("api.token.part3.part4");
    // A read-only view: nothing built, nothing sent.
    expect(transport.calls("POST", "/v1/spl/transfer")).toHaveLength(0);
    expect(transport.teeCalls.some((c) => c.method === "sendTransaction")).toBe(false);
  });

  it("asks the TEE with the vendor's own login whether a transfer landed", async () => {
    const transport = fake({ teeTransactions: new Map<string, unknown>([[FAILED, teeTransactionAsObserved(FAILED, { InstructionError: [0, "x"] })], [MISSING, null]]) });
    const payee = await MagicBlockPayee.create({ ...common(), transport, payee: vendor });
    expect(await payee.transferStatus(LANDED)).toBe("landed");
    expect(await payee.transferStatus(FAILED)).toBe("failed");
    expect(await payee.transferStatus(MISSING)).toBe("not_found");
    const reads = transport.teeCalls.filter((c) => c.method === "getTransaction");
    expect(reads.map((c) => c.token)).toEqual([`tee-token-for-${vendorAddress.slice(0, 4)}`, `tee-token-for-${vendorAddress.slice(0, 4)}`, `tee-token-for-${vendorAddress.slice(0, 4)}`]);
  });

  it("attestation failure refuses construction, before any login", async () => {
    const transport = fake({ attest: async () => false });
    const error = await MagicBlockPayee.create({ ...common(), transport, payee: vendor }).catch((e: unknown) => e);
    expect(isBindingError(error, "shielded_attestation_failed")).toBe(true);
    expect(transport.apiCalls).toHaveLength(0);
  });

  it("refuses anything but devnet before any network call", async () => {
    const transport = fake();
    await expect(MagicBlockPayee.create({ ...common(), network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp", transport, payee: vendor })).rejects.toThrow(/devnet only/);
    await expect(MagicBlockPayee.create({ ...common(), baseRpcUrl: "https://mainnet.helius-rpc.com/?api-key=x", transport, payee: vendor })).rejects.toThrow(/mainnet/);
    expect(transport.apiCalls).toHaveLength(0);
    expect(transport.teeCalls).toHaveLength(0);
  });
});
