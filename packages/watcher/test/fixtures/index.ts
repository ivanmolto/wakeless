// Real devnet transactions, as the Helius RPC returned them (`getTransaction`, `jsonParsed`,
// `maxSupportedTransactionVersion: 1`), fetched on 7 Nov 2026. Public rail: the three
// batch-settlement signatures and the five `exact` signatures of docs/public-rail-log.md.
// Wakeless: the buyer's vault deposit (docs/spike-log.md, attempt 2) and the validator's
// vault → vendor1 release (ibid., "touched vendor1 wallet"); a channel deposit executes
// inside the rollup and has no base-layer response, which `null` stands for.
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { signature as asSignature, type Address, type Signature } from "@solana/kit";
import { parseBaseTransaction, type BaseTransaction } from "../../src/parse.js";

function load(name: string): unknown {
  return JSON.parse(readFileSync(join(import.meta.dirname, `${name}.json`), "utf8")) as unknown;
}

export const PUBLIC_SIGNATURES = {
  open: asSignature("4CjgcqkYFVk5g1o92b67VL73FnxhJo4eyz56nBSHzyqmYHu7KqoW5rjYf7qxELTUrTpeixWJwRxrSifLynjwshjz"),
  settle: asSignature("4UkRoSZNzxCsJxGYsuRJxuYWpQrbBbXNHwD8bR9W4P4h2XgpV8XmRRQbfwwQjZsZW3rnxcSa53MC6B4KHHjnZSVX"),
  distribute: asSignature("4gQrESh5wjKkMBqzymEpbbXKXE9ksFHAuHULoEYVJdoVdmPxeAQ3U85mZBtfP18sSzHrv1ubrm1TpRf8ayUbqszM"),
} as const;

export const WAKELESS_SIGNATURES = {
  /** A channel deposit of the 7 Nov e2e run: a private transfer inside the rollup, not on the base layer. */
  deposit: asSignature("2Ym8ompGJLHargwaYXppXWUC89nmK2WKVPqjrk8mSUnT2Ycw3SDnDovf4uvzomtErtrCnwgbtnhPBYVtAjAtFcEg"),
  vaultDeposit: asSignature("2GqSZzaPYiXjKnzzEtqXoNbbJNCjigsVyuN8wvBDuUz1JV6wuGLDJ8AxNTPY5kYqnMVJWkRCDMNUDWkF5hyxyh22"),
  vendorWithdraw: asSignature("5XKE2bt32CvgwRSNc4iaESJUd397WQLut7xHSudQK18YnGXACvEMLAsMU7AVAmy4BL66PpGxxPsx2ntc2Lz319bp"),
} as const;

export const PUBLIC_PAYER = "94BRf9UjVLdNUBGGeKuFqWSk4sA67EDtAmS9pm6RTjzT" as Address;
export const PUBLIC_PAYTO = "9JD9k3HdkZbPubKbJYBtCbfrQQeGZUKvdezmEJ9LfPgy" as Address;
export const PUBLIC_FACILITATOR = "7re7bveMuceHWqgFum4Ncq1NKAYjyxKCQJbFY2C6QFNt" as Address;

export const BUYER = "3sWw9GDqNiqqQZUsSs7qkcbnodA4yMLXtXbH4q6anpba" as Address;
export const ESCROW = "EasXF7gqHLMMncsB7aV18EtzrhNkzQy2oC7pdKPKT3k6" as Address;
export const VENDORS = ["ATvAn6py5RWRVJuZxGPPbLAhbdtSQNVQJbFVSuBAhetm", "3Qdg6oJAoe6uHE7zeDGz9TNvmrQRRWAYrMEqJyPZm9Sc", "5Vckjt8WpuA4gWv13qqHKe4jnA5BQyUedrGUZhSLKFtJ"] as Address[];
export const VENDOR1_ATA = "CKnjjE8QCfnwjgLm3xrZNAnSKr1hch9NaDxP1fhcETdf" as Address;
export const VAULT_OWNER = "EiV97BPvmJzP4kzy28ciqddhQW864Wit3r3zYiLXARjG" as Address;

export const publicRaw: Readonly<Record<string, unknown>> = {
  [PUBLIC_SIGNATURES.open]: load("public-open"),
  [PUBLIC_SIGNATURES.settle]: load("public-settle"),
  [PUBLIC_SIGNATURES.distribute]: load("public-distribute"),
};

export const exactRaw = load("public-exact") as Readonly<Record<string, unknown>>;

export const wakelessRaw: Readonly<Record<string, unknown>> = {
  [WAKELESS_SIGNATURES.deposit]: null,
  [WAKELESS_SIGNATURES.vaultDeposit]: load("wakeless-vault-deposit"),
  [WAKELESS_SIGNATURES.vendorWithdraw]: load("wakeless-vendor-withdraw"),
};

export function parsed(raw: Readonly<Record<string, unknown>>): BaseTransaction[] {
  return Object.entries(raw).map(([signature, json]) => parseBaseTransaction(signature as Signature, json));
}
