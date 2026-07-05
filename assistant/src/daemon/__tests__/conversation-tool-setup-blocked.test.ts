/**
 * Tests for the per-turn `ctx.blockedToolNames` hard blocklist applied inside
 * `createResolveToolsCallback`. Blocked names are removed from the executor
 * gate (`ctx.allowedToolNames`) so any call is rejected before its executor
 * runs, while the tool stays on the wire (cache-safe). Used by the watcher
 * engine so triage turns can never send/write.
 */

import { afterEach, beforeEach, describe, expect, spyOn, test } from "bun:test";

import * as configLoader from "../../config/loader.js";
import type { AssistantConfig } from "../../config/schema.js";
import type { ToolDefinition } from "../../providers/types.js";
import { __clearRegistryForTesting } from "../../tools/registry.js";
import { createResolveToolsCallback } from "../conversation-tool-setup.js";

type SkillProjectionContext =
  import("../conversation-tool-setup.js").SkillProjectionContext;
type SkillProjectionCache =
  import("../conversation-skill-tools.js").SkillProjectionCache;

function def(name: string): ToolDefinition {
  return { name, description: name, input_schema: { type: "object" } };
}

function makeCtx(
  overrides: Partial<SkillProjectionContext> = {},
): SkillProjectionContext {
  return {
    skillProjectionState: new Map(),
    skillProjectionCache: { fingerprints: new Map() } as SkillProjectionCache,
    coreToolNames: new Set<string>(),
    toolsDisabledDepth: 0,
    ...overrides,
  };
}

let getConfigSpy: ReturnType<typeof spyOn> | undefined;

beforeEach(() => {
  __clearRegistryForTesting();
  getConfigSpy = spyOn(configLoader, "getConfig").mockReturnValue({
    tools: { exclude: [] },
  } as AssistantConfig);
});

afterEach(() => {
  getConfigSpy?.mockRestore();
  getConfigSpy = undefined;
  __clearRegistryForTesting();
});

describe("createResolveToolsCallback — blockedToolNames", () => {
  test("blocked tool is removed from ctx.allowedToolNames (rejected at executor)", () => {
    const ctx = makeCtx({ blockedToolNames: new Set(["messaging_send"]) });
    const resolver = createResolveToolsCallback(
      [def("messaging_send"), def("file_read")],
      ctx,
    );
    resolver!([]);
    expect(ctx.allowedToolNames?.has("messaging_send")).toBe(false);
    expect(ctx.allowedToolNames?.has("file_read")).toBe(true);
  });

  test("blocked tool stays visible on the wire (cache-safe)", () => {
    const ctx = makeCtx({ blockedToolNames: new Set(["messaging_send"]) });
    const resolver = createResolveToolsCallback(
      [def("messaging_send"), def("file_read")],
      ctx,
    );
    const names = resolver!([]).map((d) => d.name);
    expect(names).toContain("messaging_send");
    expect(names).toContain("file_read");
  });

  test("unset blockedToolNames leaves the allowlist intact", () => {
    const ctx = makeCtx();
    const resolver = createResolveToolsCallback(
      [def("messaging_send"), def("file_read")],
      ctx,
    );
    resolver!([]);
    expect(ctx.allowedToolNames?.has("messaging_send")).toBe(true);
    expect(ctx.allowedToolNames?.has("file_read")).toBe(true);
  });

  test("blocked name absent from the tool list is a harmless no-op", () => {
    const ctx = makeCtx({ blockedToolNames: new Set(["does_not_exist"]) });
    const resolver = createResolveToolsCallback([def("file_read")], ctx);
    expect(() => resolver!([])).not.toThrow();
    expect(ctx.allowedToolNames?.has("file_read")).toBe(true);
  });

  test("multiple blocked tools all removed from the gate", () => {
    const ctx = makeCtx({
      blockedToolNames: new Set(["messaging_send", "call_start"]),
    });
    const resolver = createResolveToolsCallback(
      [def("messaging_send"), def("call_start"), def("file_read")],
      ctx,
    );
    resolver!([]);
    expect(ctx.allowedToolNames?.has("messaging_send")).toBe(false);
    expect(ctx.allowedToolNames?.has("call_start")).toBe(false);
    expect(ctx.allowedToolNames?.has("file_read")).toBe(true);
  });
});
