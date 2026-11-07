// The five tarballs as a stranger gets them: installed into a scratch project outside the
// workspace (the @wakeless names overridden to the local tarballs, everything else from the
// pnpm store), each README's first example compiled with tsc against the installed
// dist/*.d.ts, and the examples run. The vendor example serves on a local port, the client
// example pays it twice, and the facilitator runs in this process: the real app with the
// client tests' confirming binding (packages/client/test/harness.ts). The buyer's rail in
// the scratch project is protocol only, as in that harness; the private transfer is
// MagicBlockBuyer's and is proved on devnet, not here. The MagicBlock example is compiled,
// not run: constructing the binding is a devnet TEE attestation.
//
// Gated on WAKELESS_PACK: the scratch install reaches the pnpm store (and the registry
// when a package is not there), so `pnpm test` skips it and `pnpm test:pack` and
// `pnpm release:dry` run it.
import { execFile, execFileSync, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readFileSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterAll, beforeAll, expect, it } from "vitest";
import { TEE_VALIDATOR, startFacilitator, type Facilitator } from "../../packages/client/test/harness.js";
import { skipUnless } from "../lib/skip-unless.js";
import { PUBLISHABLE, REPO_ROOT, buildPublishable, packTarballs, packageDir, type Publishable } from "../lib/release.js";

const BASE58_88 = /[1-9A-HJ-NP-Za-km-z]{88}/;
const BEARER = /bearer\s+\S+/i;

/** Names each example takes from the scratch project's given.ts, which a reader supplies. */
const GIVEN: Record<Publishable, readonly string[]> = {
  scheme: ["buyerKeypair", "escrowAddress", "mint"],
  binding: [],
  "binding-magicblock": ["escrowKeypairBytes", "usdcMint"],
  client: ["buyerKeypair", "rail"],
  vendor: ["vendorAddress"],
};

const GIVEN_TS = `import { randomBytes } from "node:crypto";
import { address } from "@solana/kit";
import { DEVNET_CAIP2, type BuyerBinding } from "@wakeless/binding";
import { DEVNET_USDC } from "@wakeless/client";
import { encodeBase58 } from "@wakeless/scheme";

type Sig = Awaited<ReturnType<BuyerBinding["deposit"]>>["sig"];

export const buyerKeypair = new Uint8Array(randomBytes(32));
export const escrowAddress = encodeBase58(randomBytes(32));
export const mint = DEVNET_USDC;
export const usdcMint = address(DEVNET_USDC);
export const escrowKeypairBytes = new Uint8Array(64);
export const vendorAddress = encodeBase58(randomBytes(32));
// Protocol only: a random signature for each deposit. On devnet this is MagicBlockBuyer.
export const rail: BuyerBinding = {
  id: "magicblock",
  teeValidator: address(process.env.TEE_VALIDATOR!),
  network: () => DEVNET_CAIP2,
  async deposit() {
    return { sig: encodeBase58(randomBytes(64)) as Sig, transaction: randomBytes(200).toString("base64") };
  },
};
`;

const RUN_TS = `import type { AddressInfo } from "node:net";
import { serve } from "@hono/node-server";
const { app } = await import("./vendor.js");
let server: ReturnType<typeof serve> | undefined;
const info = await new Promise<AddressInfo>((resolve) => {
  server = serve({ fetch: app.fetch, port: 0, hostname: "127.0.0.1" }, resolve);
});
process.env.VENDOR_URL = \`http://127.0.0.1:\${info.port}\`;
try {
  await import("./client.js");
} finally {
  server?.close();
}
process.exit(0);
`;

function readmeExample(pkg: Publishable): string {
  const readme = readFileSync(join(packageDir(pkg), "README.md"), "utf8");
  const match = /```ts\n([\s\S]*?)```/.exec(readme);
  if (!match) throw new Error(`packages/${pkg}/README.md has no ts example`);
  return match[1]!;
}

let scratch: string;
let facilitator: Facilitator;

/** Async on purpose: the facilitator answers from this process's event loop, which spawnSync would block. */
function run(file: string, env: Record<string, string> = {}): Promise<{ status: number | null; stdout: string; stderr: string }> {
  return new Promise((resolve) => {
    execFile(process.execPath, [file], { cwd: scratch, encoding: "utf8", env: { ...process.env, TEE_VALIDATOR, ...env }, timeout: 60_000 }, (error, stdout, stderr) => {
      resolve({ status: error ? (typeof error.code === "number" ? error.code : 1) : 0, stdout, stderr });
    });
  });
}

skipUnless("WAKELESS_PACK", "pack-install: installs the tarballs into a scratch project")("pack and install", () => {
  beforeAll(async () => {
    buildPublishable();
    scratch = mkdtempSync(join(tmpdir(), "wakeless-pack-"));
    const tarballs = packTarballs(join(scratch, "tarballs"));
    const local = Object.fromEntries(PUBLISHABLE.map((pkg, i) => [`@wakeless/${pkg}`, `file:${tarballs[i]}`]));
    writeFileSync(
      join(scratch, "package.json"),
      JSON.stringify({
        name: "wakeless-pack-scratch",
        private: true,
        type: "module",
        dependencies: { ...local, "@solana/kit": "8.6.0", hono: "4.13.14", "@hono/node-server": "2.1.5", "@types/node": "22.20.5" },
      }),
    );
    // The @wakeless names are not on the registry yet: every reference resolves to the local tarball.
    const overrides = Object.entries(local).map(([name, spec]) => `  "${name}": "${spec}"`).join("\n");
    writeFileSync(join(scratch, "pnpm-workspace.yaml"), `overrides:\n${overrides}\nallowBuilds:\n  bufferutil: false\n  esbuild: false\n  utf-8-validate: false\n`);
    execFileSync("pnpm", ["install", "--prefer-offline", "--no-frozen-lockfile"], { cwd: scratch, stdio: "pipe", env: { ...process.env, CI: "" } });

    mkdirSync(join(scratch, "src"));
    writeFileSync(join(scratch, "src/given.ts"), GIVEN_TS);
    for (const pkg of PUBLISHABLE) {
      const names = GIVEN[pkg];
      const prelude = names.length > 0 ? `import { ${names.join(", ")} } from "./given.js";\n` : "";
      const epilogue = pkg === "vendor" ? "\nexport { app };\n" : "";
      writeFileSync(join(scratch, `src/${pkg}.ts`), `${prelude}${readmeExample(pkg)}${epilogue}`);
    }
    writeFileSync(join(scratch, "src/run.ts"), RUN_TS);
    writeFileSync(
      join(scratch, "tsconfig.json"),
      JSON.stringify({
        compilerOptions: { target: "ES2023", lib: ["ES2023"], module: "NodeNext", moduleResolution: "NodeNext", strict: true, skipLibCheck: true, types: ["node"], rootDir: "src", outDir: "out" },
        include: ["src"],
      }),
    );
    facilitator = await startFacilitator();
  }, 600_000);

  afterAll(async () => {
    await facilitator?.close();
    if (scratch) rmSync(scratch, { recursive: true, force: true });
  });

  it("the five tarballs install into a scratch project and the README example runs", async () => {
    // Compiles: every README example against the installed dist/*.d.ts, outside the workspace.
    const tsc = join(REPO_ROOT, "node_modules/typescript/bin/tsc");
    const compiled = spawnSync(process.execPath, [tsc, "-p", join(scratch, "tsconfig.json")], { cwd: scratch, encoding: "utf8" });
    expect(compiled.stdout + compiled.stderr, "tsc on the README examples").toBe("");
    expect(compiled.status).toBe(0);

    // Runs: the pure ones on their own, then the vendor served and the client paying it.
    const scheme = await run("out/scheme.js");
    expect(scheme.status, scheme.stderr).toBe(0);
    expect(scheme.stdout.split("\n").filter(Boolean)).toEqual(["true", "{ ok: true, watermark: 1001n }", "true"]);
    const binding = await run("out/binding.js");
    expect(binding.status, binding.stderr).toBe(0);

    const paid = await run("out/run.js", { FACILITATOR_URL: facilitator.url, TEE_VALIDATOR });
    expect(paid.status, paid.stderr).toBe(0);
    expect(paid.stdout).toMatch(/^200 200 \{ symbol: 'SOL', price: 1 \}$/m);
    const cumulatives = /\[ '(\d+)', '(\d+)' \]/.exec(paid.stdout);
    expect(cumulatives, paid.stdout).not.toBeNull();
    expect(BigInt(cumulatives![2]!)).toBeGreaterThan(BigInt(cumulatives![1]!));
    for (const out of [scheme, binding, paid]) {
      expect(out.stdout + out.stderr).not.toMatch(BASE58_88);
      expect(out.stdout + out.stderr).not.toMatch(BEARER);
    }
  }, 120_000);

  it("the wakeless bin answers --help installed, and through a symlink as npm installs bins", () => {
    const bin = join(scratch, "node_modules/.bin/wakeless");
    const shim = spawnSync(bin, ["fund", "--help"], { cwd: scratch, encoding: "utf8" });
    expect(shim.status, shim.stderr).toBe(0);
    expect(shim.stdout).toContain("usage: wakeless fund --from <chain> --amount <usdc>");
    const link = join(scratch, "wakeless-link");
    symlinkSync(join(scratch, "node_modules/@wakeless/client/dist/cli.js"), link);
    const linked = spawnSync(process.execPath, [link, "fund", "--help"], { cwd: scratch, encoding: "utf8" });
    expect(linked.status, linked.stderr).toBe(0);
    expect(linked.stdout).toContain("usage: wakeless fund");
  });
});
