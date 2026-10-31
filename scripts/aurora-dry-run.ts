// Calls Aurora's quote and status endpoints with dry quotes and writes
// docs/aurora-dry-run.md. Sends no funds, loads no keypair.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { redactKey, renderDoc, runDryRun } from "./lib/aurora.js";
import { loadDotEnv } from "./lib/env.js";

const root = resolve(import.meta.dirname, "..");
loadDotEnv(root);

const apiKey = process.env.AURORA_API_KEY;
// Off by default: one real quote, to see the deposit address and expiry. Still sends no funds.
const liveQuote = process.argv.includes("--live-quote");

async function main(apiKey: string): Promise<void> {
  const result = await runDryRun({ apiKey, fetch: globalThis.fetch, now: () => new Date() }, { liveQuote });
  const doc = renderDoc(result);
  if (doc.includes(apiKey)) throw new Error("Refusing to write: the document contains the API key");
  const path = resolve(root, "docs/aurora-dry-run.md");
  writeFileSync(path, doc);
  console.log(`wrote ${path}`);
  for (const { origin, response } of result.quotes) console.log(`${origin.padEnd(5)} quote ${response.status}`);
  if (result.liveQuote) console.log(`${result.liveQuote.origin.padEnd(5)} live quote ${result.liveQuote.status}`);
  for (const { status } of result.statusProbes) console.log(`status probe ${status}`);
}

if (!apiKey) {
  console.error("AURORA_API_KEY is not set: create a key at https://studio.aurora.dev and put it in .env");
  process.exitCode = 1;
} else {
  main(apiKey).catch((error: unknown) => {
    console.error(redactKey(error instanceof Error ? error.message : String(error), apiKey));
    process.exitCode = 1;
  });
}
