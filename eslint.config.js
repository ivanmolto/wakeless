import js from "@eslint/js";
import tseslint from "typescript-eslint";

export default tseslint.config(
  // Anchored: `vendor/**` is the third-party checkout at the root, not packages/vendor.
  { ignores: ["**/node_modules/**", "**/dist/**", "vendor/**", "keys/**", ".agents/**", ".claude/**", "packages/site/public/**"] },
  js.configs.recommended,
  ...tseslint.configs.recommended,
  {
    rules: {
      "no-restricted-imports": [
        "error",
        {
          patterns: [
            {
              group: [
                "@magicblock-labs/*",
                "@heliuslabs/*",
                "privacy-cash",
                "privacy-cash/*",
                "@privacy-cash/*",
                "privacycash",
                "privacycash/*",
                "@privacycash/*",
              ],
              message:
                "The settlement primitive is reached only through packages/binding-* behind SettlementBinding (CLAUDE.md, Privacy rules).",
            },
          ],
        },
      ],
    },
  },
  {
    files: ["packages/binding-*/**"],
    rules: { "no-restricted-imports": "off" },
  },
);
