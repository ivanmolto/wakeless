// Root-relative on purpose: `vendor/**` is the third-party checkout, and
// `**/vendor/**` would silently drop the tests in packages/vendor.
export const baseExclude = ["**/node_modules/**", "**/dist/**", "vendor/**", ".agents/**", ".claude/**"];
