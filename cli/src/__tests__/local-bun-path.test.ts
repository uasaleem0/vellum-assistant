import { describe, expect, test } from "bun:test";

import { buildBunPathEnv, bunExecutableName } from "../lib/local.js";

describe("local Bun process resolution", () => {
  test("builds PATH from the active home directory instead of a hardcoded user", () => {
    const path = buildBunPathEnv("/usr/bin", "/home/alice");

    expect(path).toStartWith("/home/alice/.bun/bin:");
    expect(path).not.toContain("/home/mainadmin");
  });

  test("uses PATH resolution by default for Bun spawns", () => {
    expect(bunExecutableName()).toBe("bun");
  });
});
