import { afterEach, describe, expect, it, vi } from "vitest";
import { skipUnless } from "../lib/skip-unless.js";

describe("skipUnless", () => {
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
  });

  it("prints why a suite skipped", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("WAKELESS_TEST_VAR", "");
    skipUnless("WAKELESS_TEST_VAR", "needs a test variable");
    expect(warn).toHaveBeenCalledOnce();
    expect(warn.mock.calls[0]?.[0]).toContain("needs a test variable");
    expect(warn.mock.calls[0]?.[0]).toContain("WAKELESS_TEST_VAR");
  });

  it("stays silent and never prints the value when the variable is set", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    vi.stubEnv("WAKELESS_TEST_VAR", "secret-value");
    skipUnless("WAKELESS_TEST_VAR", "needs a test variable");
    expect(warn).not.toHaveBeenCalled();
  });
});
