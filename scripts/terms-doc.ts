// `pnpm terms:doc`: writes docs/TERMS.md from packages/vendor/src/terms/doc.ts, so the worked
// table is the output of terms(), never typed (task 12.1T). docs/test/terms-doc.test.ts holds
// the file to the generator.
import { writeFileSync } from "node:fs";
import { resolve } from "node:path";
import { renderTermsDoc } from "@wakeless/vendor";

const ROOT = resolve(import.meta.dirname, "..");
const generatedOn = process.argv.find((a) => a.startsWith("--date="))?.slice("--date=".length) ?? new Date().toISOString().slice(0, 10);
const path = resolve(ROOT, "docs", "TERMS.md");
writeFileSync(path, renderTermsDoc({ generatedOn }));
console.log(`docs/TERMS.md written (generated on ${generatedOn})`);
