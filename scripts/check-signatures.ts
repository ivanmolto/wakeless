// Task 12.2: every signature the README names resolves. Reads README.md (or the files given),
// looks each signature up read-only (devnet base layer, then the TEE RPC for a rollup
// signature; the leak package's mainnet reader for a signature the document marks as
// mainnet), prints one shortened line per signature and exits 1 if any is missing. No
// keypair is loaded and the RPC URL is never printed.
//
//   pnpm check:signatures
//   pnpm check:signatures docs/side-by-side.md docs/WATCHER.md
import { readFileSync } from "node:fs";
import { relative, resolve } from "node:path";
import { extractSignatures, formatResolutions, mainnetReaderFromEnv, missing, resolveSignatures, type FoundSignature } from "./lib/check-signatures.js";
import { redactSecrets } from "./lib/devnet.js";
import { loadDotEnv } from "./lib/env.js";

const ROOT = resolve(import.meta.dirname, "..");

async function main(): Promise<number> {
  loadDotEnv(ROOT);
  if (process.env.MAINNET_ENABLED === "true") throw new Error("MAINNET_ENABLED is not honoured here: the lookups are read-only on devnet, plus the leak reader for mainnet signatures");
  const devnetRpcUrl = process.env.SOLANA_RPC_URL;
  if (!devnetRpcUrl) throw new Error("SOLANA_RPC_URL is not set: copy .env.example to .env and fill it in");
  const files = process.argv.slice(2).length > 0 ? process.argv.slice(2) : ["README.md"];

  let failures = 0;
  for (const file of files) {
    const path = resolve(ROOT, file);
    const found: FoundSignature[] = extractSignatures(readFileSync(path, "utf8"));
    console.log(`${relative(ROOT, path)}: ${found.length} signature${found.length === 1 ? "" : "s"}`);
    if (found.length === 0) continue;
    const resolutions = await resolveSignatures(found, {
      devnetRpcUrl,
      teeRpcUrl: process.env.MAGICBLOCK_TEE_RPC ?? "https://devnet-tee.magicblock.app",
      mainnetReader: mainnetReaderFromEnv(process.env),
      paceMs: 250,
    });
    console.log(formatResolutions(resolutions));
    const gone = missing(resolutions);
    for (const r of gone) {
      const line = found.find((f) => f.signature === r.signature)?.line;
      console.error(`FAIL: ${relative(ROOT, path)}:${line} names a signature no ${r.cluster} node knows`);
    }
    failures += gone.length;
    console.log("");
  }
  console.log(failures === 0 ? "PASS every signature in the README resolves" : `FAIL ${failures} signature${failures === 1 ? "" : "s"} missing`);
  return failures === 0 ? 0 : 1;
}

main().then(
  (code) => {
    process.exitCode = code;
  },
  (error: unknown) => {
    console.error(redactSecrets(error instanceof Error ? error.message : String(error)));
    process.exitCode = 1;
  },
);
