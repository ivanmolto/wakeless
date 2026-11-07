/* global process, console */
// prepublishOnly of the five publishable packages. `npm publish` run inside a package
// directory would ship the `workspace:` specifiers and the `development` export (whose
// ./src is not in the tarball): npm applies neither rewrite. pnpm does, on pack, so the
// tarballs `pnpm release:dry` writes under .release/ are what gets published.
const agent = process.env.npm_config_user_agent ?? "";
if (!agent.startsWith("pnpm/")) {
  const name = process.env.npm_package_name ?? "this package";
  console.error(
    `refusing to publish ${name} from its directory with ${agent.split(" ")[0] || "an unknown client"}.\n` +
      "Run `pnpm release:dry`, then publish the tarball it wrote: npm publish --access public --tag alpha .release/<tarball>.tgz",
  );
  process.exit(1);
}
