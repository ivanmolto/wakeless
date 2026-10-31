// Contract test over a fake transport: the binding is real, the wire is not.
import { findAssociatedTokenPda, TOKEN_PROGRAM_ADDRESS } from "@solana-program/token";
import { generateKeyPair, getAddressFromPublicKey, signature as asSignature, type Address, type Signature } from "@solana/kit";
import { channelId, clientRefId, DEVNET_CAIP2, isBindingError, type SettleRef } from "@wakeless/binding";
import fc from "fast-check";
import { beforeAll, describe, expect, it } from "vitest";
import { ApiError, MagicBlockBinding, UnconfirmedTransferError, type EscrowKeyPair, type MagicBlockBindingConfig } from "../src/index.js";
import { BASE_RPC, FakeTransport, PAYMENTS_API, TEE_RPC, teeTransactionAsObserved, USDC, signedDeposit, type FakeTransportOptions } from "./fake-transport.js";

const USDC_UNITS = 1_000_000n;
const VENDOR = "ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm" as Address;
const SETTLE_REF: SettleRef = { id: clientRefId("2001"), channelId: channelId("00000000000007d1" + "ab".repeat(24)), period: 1, cumulative: 500_000n };

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

function fake(opts: Partial<FakeTransportOptions> = {}): FakeTransport {
  return new FakeTransport({ escrowAddress, escrowAta, ...opts });
}

async function create(transport: FakeTransport, config: Partial<MagicBlockBindingConfig> = {}): Promise<MagicBlockBinding> {
  return MagicBlockBinding.create({
    network: DEVNET_CAIP2,
    baseRpcUrl: BASE_RPC,
    teeRpcUrl: TEE_RPC,
    paymentsApiUrl: PAYMENTS_API,
    mint: USDC,
    escrow,
    transport,
    confirm: { attempts: 3, intervalMs: 1 },
    sleep: async () => {},
    ...config,
  });
}

describe("MagicBlockBinding over a fake transport", () => {
  it("constructs after attestation, logs in twice and reports the escrow", async () => {
    const transport = fake();
    const binding = await create(transport);
    expect(binding.id).toBe("magicblock");
    expect(binding.network()).toBe(DEVNET_CAIP2);
    expect(binding.escrowAddress()).toBe(escrowAddress);
    expect(binding.attestation.verified).toBe(true);
    expect(binding.attestation.validatorIdentity).toBe("MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo");
    expect(binding.attestation.verifier).toEqual({ package: "@magicblock-labs/ephemeral-rollups-kit", version: "0.17.3", method: "verifyTeeRpcIntegrity" });
    // API login uses the API's own challenge/login, with cluster devnet-private; the TEE login is separate.
    expect(transport.calls("GET", "/v1/spl/challenge")[0]!.path).toContain("cluster=devnet-private");
    expect(transport.calls("POST", "/v1/spl/login")).toHaveLength(1);
    expect(await binding.privateBalance()).toBe(10_000n);
    expect(transport.calls("GET", "/v1/spl/private-balance").every((c) => c.token === "api.token.part3.part4")).toBe(true);
  });

  it("attestation failure refuses construction", async () => {
    for (const attest of [async () => false as const, async () => { throw new Error("quote verification failed"); }]) {
      const transport = fake({ attest });
      const error = await create(transport).catch((e: unknown) => e);
      expect(isBindingError(error, "shielded_attestation_failed"), String(error)).toBe(true);
      expect((error as Error).message).toContain("shielded_attestation_failed");
      // Nothing after attestation ran: no login, no balance read.
      expect(transport.apiCalls).toHaveLength(0);
    }
  });

  it("refuses mainnet, a foreign TEE host and a cluster that is not the one named", async () => {
    await expect(create(fake(), { network: "solana:5eykt4UsFv8P8NJdTREpY1vzqKqZKvdp" })).rejects.toThrow(/devnet only/);
    await expect(create(fake(), { baseRpcUrl: "https://mainnet.helius-rpc.com/?api-key=x" })).rejects.toThrow(/mainnet/);
    await expect(create(fake(), { teeRpcUrl: "https://mainnet-tee.magicblock.app" })).rejects.toThrow(/devnet-tee\.magicblock\.app/);
    await expect(create(fake(), { teeRpcUrl: "http://devnet-tee.magicblock.app" })).rejects.toThrow(/https/);
    await expect(create(fake({ genesisHash: "5eykt4UsFv8P8NJdTREpY1vzqKqZKvdpBmHsGTp7Vx2E" }))).rejects.toThrow(/Refusing cluster/);
  });

  it("readDeposit recognises a matching clientRef", async () => {
    const transport = fake({ balance: 510_000n });
    const binding = await create(transport);
    const amount = 1n * USDC_UNITS;
    const deposit = await signedDeposit(buyer, buyerAddress, buyerAta, escrowAta, amount);
    transport.balance += amount; // the private transfer credited the escrow
    const result = await binding.readDeposit(deposit.signature, { id: clientRefId("1001"), buyer: buyerAddress, amount, transaction: deposit.transaction });
    expect(result).toEqual({ amount, buyer: buyerAddress });
    expect(transport.teeCalls.filter((c) => c.method === "getTransaction").map((c) => c.params[0])).toEqual([deposit.signature]);
    // The same signature is never credited twice.
    expect(await binding.readDeposit(deposit.signature, { id: clientRefId("1001"), buyer: buyerAddress, amount, transaction: deposit.transaction })).toBeNull();
  });

  it("readDeposit returns null on a wrong clientRef", async () => {
    const transport = fake({ balance: 510_000n });
    const binding = await create(transport);
    const amount = 1n * USDC_UNITS;
    const deposit = await signedDeposit(buyer, buyerAddress, buyerAta, escrowAta, amount);
    const other = await signedDeposit(buyer, buyerAddress, buyerAta, escrowAta, amount + 1n);
    transport.balance += amount;
    const ref = { id: clientRefId("1001"), buyer: buyerAddress, amount, transaction: deposit.transaction };
    // A ref whose signed transaction is not the one behind the signature.
    expect(await binding.readDeposit(deposit.signature, { ...ref, transaction: other.transaction })).toBeNull();
    // A ref naming another buyer, or another amount.
    expect(await binding.readDeposit(deposit.signature, { ...ref, buyer: escrowAddress })).toBeNull();
    expect(await binding.readDeposit(deposit.signature, { ...ref, amount: amount + 1n })).toBeNull();
    // A transaction paying some other account than the escrow's.
    const elsewhere = await signedDeposit(buyer, buyerAddress, buyerAta, buyerAta, amount);
    expect(await binding.readDeposit(elsewhere.signature, { ...ref, transaction: elsewhere.transaction })).toBeNull();
    // Nothing above reached the enclave or the balance endpoint beyond construction.
    expect(transport.teeCalls.filter((c) => c.method === "getTransaction")).toHaveLength(0);
    // The right ref still confirms afterwards.
    expect(await binding.readDeposit(deposit.signature, ref)).toEqual({ amount, buyer: buyerAddress });
  });

  it("readDeposit returns null until the transfer landed and the balance grew", async () => {
    const amount = 1n * USDC_UNITS;
    const deposit = await signedDeposit(buyer, buyerAddress, buyerAta, escrowAta, amount);
    const ref = { id: clientRefId("1001"), buyer: buyerAddress, amount, transaction: deposit.transaction };
    const teeTransactions = new Map<string, unknown>([[deposit.signature, null]]);
    const transport = fake({ balance: 510_000n, teeTransactions });
    const binding = await create(transport);
    expect(await binding.readDeposit(deposit.signature, ref), "not found on the TEE").toBeNull();
    teeTransactions.set(deposit.signature, teeTransactionAsObserved(deposit.signature, { InstructionError: [0, "InvalidAccountData"] }));
    expect(await binding.readDeposit(deposit.signature, ref), "failed inside the rollup").toBeNull();
    teeTransactions.delete(deposit.signature);
    expect(await binding.readDeposit(deposit.signature, ref), "balance has not grown").toBeNull();
    transport.balance += amount - 1n;
    expect(await binding.readDeposit(deposit.signature, ref), "balance grew by less").toBeNull();
    transport.balance += 1n;
    expect(await binding.readDeposit(deposit.signature, ref)).toEqual({ amount, buyer: buyerAddress });
  });

  it("settle builds a private ephemeral transfer, signs it and returns the receipt", async () => {
    const transport = fake({ balance: 510_000n });
    const binding = await create(transport);
    const { sig, receipt } = await binding.settle(VENDOR, 500_000n, SETTLE_REF);
    expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/);
    expect(receipt).toEqual({ channelId: SETTLE_REF.channelId, period: 1, cumulative: 500_000n, amount: 500_000n, signature: sig, ref: "2001" });
    const [body] = transport.transferBodies();
    expect(body).toMatchObject({ from: escrowAddress, to: VENDOR, cluster: "devnet-private", mint: USDC, amount: 500_000, visibility: "private", fromBalance: "ephemeral", toBalance: "ephemeral", clientRefId: "2001", split: 1, gasless: false });
    expect(transport.calls("POST", "/v1/spl/transfer")[0]!.token).toBe("api.token.part3.part4");
    const send = transport.teeCalls.find((c) => c.method === "sendTransaction")!;
    expect(send.token).toMatch(/^tee-token-for-/);
    expect(send.params[1]).toEqual({ encoding: "base64", preflightCommitment: "confirmed" });
    // The wire transaction submitted is signed by the escrow and carries the returned signature.
    const { decodeSignedTransaction } = await import("../src/deposit.js");
    const decoded = decodeSignedTransaction(send.params[0] as string);
    expect(decoded.signature).toBe(sig);
    expect(decoded.signers).toEqual([escrowAddress]);
    expect(decoded.memo).toBe(false);
  });

  it("settle delays stay inside the configured window", async () => {
    const transport = fake({ balance: 1_000n * USDC_UNITS });
    const binding = await create(transport);
    await fc.assert(
      fc.asyncProperty(fc.bigInt({ min: 1n, max: 10n * USDC_UNITS }), async (amount) => {
        await binding.settle(VENDOR, amount, SETTLE_REF);
        const body = transport.transferBodies().at(-1)!;
        const min = Number(body.minDelayMs);
        const max = Number(body.maxDelayMs);
        expect(typeof body.minDelayMs).toBe("string");
        expect(Number.isInteger(min) && Number.isInteger(max)).toBe(true);
        expect(min).toBeGreaterThanOrEqual(30_000);
        expect(max).toBeLessThanOrEqual(300_000);
        expect(min).toBeLessThanOrEqual(max);
      }),
      { numRuns: 200 },
    );
    expect(transport.transferBodies()).toHaveLength(200);

    // A narrower configured window is respected too.
    const narrow = fake({ balance: 1_000n * USDC_UNITS });
    const b2 = await create(narrow, { delayWindowMs: { min: 1_000, max: 2_000 } });
    for (let i = 0; i < 50; i++) await b2.settle(VENDOR, 1n, SETTLE_REF);
    for (const body of narrow.transferBodies()) {
      expect(Number(body.minDelayMs)).toBeGreaterThanOrEqual(1_000);
      expect(Number(body.maxDelayMs)).toBeLessThanOrEqual(2_000);
    }
    await expect(create(fake(), { delayWindowMs: { min: 5, max: 1 } })).rejects.toThrow(RangeError);
  });

  it("split is 1 under 2 USDC and at most 5 above", async () => {
    const transport = fake({ balance: 1_000n * USDC_UNITS });
    const binding = await create(transport);
    const table: [bigint, number][] = [
      [1n, 1],
      [500_000n, 1],
      [2n * USDC_UNITS - 1n, 1],
      [2n * USDC_UNITS, 2],
      [3n * USDC_UNITS - 1n, 2],
      [3n * USDC_UNITS, 3],
      [4n * USDC_UNITS, 4],
      [5n * USDC_UNITS, 5],
      [50n * USDC_UNITS, 5],
      [999n * USDC_UNITS, 5],
    ];
    for (const [amount, split] of table) {
      await binding.settle(VENDOR, amount, SETTLE_REF);
      expect(transport.transferBodies().at(-1)!.split, amount.toString()).toBe(split);
    }
    await expect(binding.settle(VENDOR, 0n, SETTLE_REF)).rejects.toThrow(RangeError);
  });

  it("a rejected private transfer maps to shielded_binding_rejected and is not retried", async () => {
    const rejectedBy = async (transport: FakeTransport, apiCode: string) => {
      const binding = await create(transport);
      const before = transport.transferBodies().length;
      const error = await binding.settle(VENDOR, 500_000n, SETTLE_REF).catch((e: unknown) => e);
      expect(isBindingError(error, "shielded_binding_rejected"), String(error)).toBe(true);
      expect((error as { retryable: boolean }).retryable).toBe(false);
      expect((error as { apiCode?: string }).apiCode).toBe(apiCode);
      expect(transport.transferBodies().length - before, "exactly one transfer request").toBe(1);
      expect(transport.apiCalls.some((c) => (c.body as Record<string, unknown> | undefined)?.visibility === "public"), "no public transfer ever requested").toBe(false);
      expect(transport.transferBodies().every((b) => b.visibility === "private")).toBe(true);
      return transport;
    };
    // The API refuses the route.
    const api = await rejectedBy(
      fake({ transfer: async () => { throw new ApiError("POST /v1/spl/transfer", 400, "UNSUPPORTED_TRANSFER_ROUTE", "route not supported"); } }),
      "UNSUPPORTED_TRANSFER_ROUTE",
    );
    expect(api.teeCalls.filter((c) => c.method === "sendTransaction"), "nothing submitted").toHaveLength(0);
    // Ingress screening refuses the signed transaction.
    const ingress = await rejectedBy(
      fake({ send: async () => { throw new (await import("../src/api.js")).TeeRpcError("sendTransaction", { code: -32003, message: "Transaction rejected by policy" }); } }),
      "TEE_INGRESS",
    );
    expect(ingress.teeCalls.filter((c) => c.method === "sendTransaction"), "submitted exactly once").toHaveLength(1);
    // A 403 from the API is a rejection too.
    await rejectedBy(fake({ transfer: async () => { throw new ApiError("POST /v1/spl/transfer", 403, undefined, "forbidden"); } }), "HTTP_403");
    // A builder that would route onto the base layer is refused before anything is signed.
    const base = fake({
      transfer: async (body) => ({ ...(await new FakeTransport({ escrowAddress, escrowAta }).api({ method: "POST", path: "/v1/spl/transfer", body }) as Record<string, unknown>), sendTo: "base", sendRpcEndpoint: undefined }),
    });
    await rejectedBy(base, "SEND_TO_BASE");
    expect(base.teeCalls.filter((c) => c.method === "sendTransaction")).toHaveLength(0);
  });

  it("other API failures propagate unchanged and an unconfirmed transfer names its signature", async () => {
    const transport = fake({ transfer: async () => { throw new ApiError("POST /v1/spl/transfer", 500, "INTERNAL", "boom"); } });
    const binding = await create(transport);
    await expect(binding.settle(VENDOR, 1n, SETTLE_REF)).rejects.toBeInstanceOf(ApiError);

    const teeTransactions = new Map<string, unknown>();
    const slow = fake({ teeTransactions });
    const b2 = await create(slow, { confirm: { attempts: 2, intervalMs: 1 } });
    // Every getTransaction answers "not found" for whatever signature is asked.
    slow.teeRpc = async function (this: FakeTransport, url, method, params, token) {
      if (method === "getTransaction") {
        this.teeCalls.push({ method, params, token });
        return null;
      }
      return FakeTransport.prototype.teeRpc.call(this, url, method, params, token);
    };
    const error = await b2.settle(VENDOR, 1n, SETTLE_REF).catch((e: unknown) => e);
    expect(error).toBeInstanceOf(UnconfirmedTransferError);
    expect((error as UnconfirmedTransferError).signature).toMatch(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/);
    expect(slow.teeCalls.filter((c) => c.method === "getTransaction")).toHaveLength(2);
  });

  it("refund is a private transfer back to the buyer without shaping", async () => {
    const transport = fake({ balance: 510_000n });
    const binding = await create(transport);
    const { sig } = await binding.refund(buyerAddress, 250_000n, { id: clientRefId("1001") });
    expect(sig).toMatch(/^[1-9A-HJ-NP-Za-km-z]{87,88}$/);
    const [body] = transport.transferBodies();
    expect(body).toMatchObject({ from: escrowAddress, to: buyerAddress, amount: 250_000, visibility: "private", fromBalance: "ephemeral", toBalance: "ephemeral", clientRefId: "1001" });
    expect(body).not.toHaveProperty("minDelayMs");
    expect(body).not.toHaveProperty("split");
  });

  it("no call ever carries a memo field", async () => {
    const transport = fake({ balance: 1_000n * USDC_UNITS });
    const binding = await create(transport);
    const deposit = await signedDeposit(buyer, buyerAddress, buyerAta, escrowAta, USDC_UNITS);
    transport.balance += USDC_UNITS;
    await binding.readDeposit(deposit.signature, { id: clientRefId("1001"), buyer: buyerAddress, amount: USDC_UNITS, transaction: deposit.transaction });
    await binding.settle(VENDOR, 3n * USDC_UNITS, SETTLE_REF);
    await binding.refund(buyerAddress, 1n, { id: clientRefId("1001") });
    await binding.privateBalance();
    await binding.observe(deposit.signature);
    expect(transport.apiCalls.length).toBeGreaterThan(5);
    for (const call of transport.apiCalls) {
      expect(call.body === undefined || !("memo" in call.body), `${call.method} ${call.path}`).toBe(true);
      expect(call.path).not.toMatch(/memo/i);
      expect((call.body as Record<string, unknown> | undefined)?.memo).toBeUndefined();
    }
    for (const call of transport.teeCalls) expect(JSON.stringify(call.params)).not.toMatch(/"memo"/);
    // Every transaction the binding signed and submitted is free of a Memo instruction.
    const { decodeSignedTransaction } = await import("../src/deposit.js");
    const sent = transport.teeCalls.filter((c) => c.method === "sendTransaction");
    expect(sent).toHaveLength(2);
    for (const call of sent) expect(decodeSignedTransaction(call.params[0] as string).memo).toBe(false);
    // The source never mentions the field either.
    const { readFileSync } = await import("node:fs");
    const { resolve } = await import("node:path");
    for (const file of ["binding.ts", "transport.ts", "api.ts", "policy.ts"]) {
      expect(readFileSync(resolve(import.meta.dirname, "../src", file), "utf8")).not.toMatch(/\bmemo\s*:/);
    }
  });

  it("observe reports an ephemeral signature as absent from the base layer and parses a base one", async () => {
    const transport = fake();
    const binding = await create(transport);
    const ephemeral = asSignature("2JjvPa9kXC17oVmiZh49evtGu1xExduy2Fr9kDvDrn2kNGq6fXYUM5yYBYWS2XFdeoZy4J1ttpTdag2d7X8bdvTN");
    expect(await binding.observe(ephemeral)).toEqual({ signature: ephemeral, onBaseLayer: false, programIds: [], signers: [], plaintextAmounts: [], plaintextRecipients: [], memoText: [], feeTransfers: [] });

    const withdrawal = asSignature("5XKE2bt32CvgwRSNc4iaESJUd397WQLut7xHSudQK18YnGXACvEMLAsMU7AVAmy4BL66PpGxxPsx2ntc2Lz319bp");
    const t2 = fake({ baseTransaction: async () => (await import("./fixtures/base-withdrawal.js")).BASE_WITHDRAWAL });
    const b2 = await create(t2);
    const view = await b2.observe(withdrawal);
    expect(view.onBaseLayer).toBe(true);
    expect(view.signers).toEqual(["MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo"]);
    expect(view.programIds).toContain("TokenkegQfeZyiNwAJbNbGKPFXCWuBvf9Ss623VQ5DA");
    expect(view.plaintextAmounts.filter((a) => a.kind === "transfer")).toEqual([{ amount: 250_000n, kind: "transfer", source: "TEy2XnwbueFzCMTAJhgxa4vrWb3N1Dhe4ANy4CgVr3r", destination: "CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf", mint: USDC }]);
    expect(view.plaintextRecipients).toEqual(["CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf"]);
    expect(view.memoText).toEqual([]);
    expect(view.feeTransfers).toEqual([
      { from: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo", to: "29gyMutDbV5PHSha1pEtzmLLNYcyscFNVJEQt5jP1xnv", lamports: 391_040n },
      { from: "MTEWGuqxUpYZGFJQcp8tLN7x5v9BSeoFHYWQQ3n3xzo", to: "29gyMutDbV5PHSha1pEtzmLLNYcyscFNVJEQt5jP1xnv", lamports: 391_040n },
    ]);
  });

  it("the kit version the attestation report names is the one installed", async () => {
    const { createRequire } = await import("node:module");
    const { readFileSync } = await import("node:fs");
    const { dirname, resolve } = await import("node:path");
    // The kit exports only its entry point, so walk up from it to its package.json.
    const entry = createRequire(import.meta.url).resolve("@magicblock-labs/ephemeral-rollups-kit");
    const pkg = JSON.parse(readFileSync(resolve(dirname(entry), "..", "package.json"), "utf8")) as { name: string; version: string };
    expect(pkg.name).toBe("@magicblock-labs/ephemeral-rollups-kit");
    const { KIT_VERSION } = await import("../src/index.js");
    expect(pkg.version).toBe(KIT_VERSION);
  });

  it("never writes a token or key into an error message", async () => {
    const transport = fake({ transfer: async () => { throw new ApiError("POST /v1/spl/transfer", 400, "UNSUPPORTED_TRANSFER_ROUTE", "no"); } });
    const binding = await create(transport);
    const error = (await binding.settle(VENDOR, 1n, SETTLE_REF).catch((e: unknown) => e)) as Error;
    const text = `${error.message} ${String((error as { cause?: Error }).cause?.message)}`;
    expect(text).not.toMatch(/Bearer\s+\S/);
    expect(text).not.toMatch(/api\.token|tee-token-for/);
    expect(text).not.toMatch(/[1-9A-HJ-NP-Za-km-z]{87,88}/);
  });
});

// Keep the Signature type import used even if vitest tree-shakes the helper.
void (null as unknown as Signature);
