import { describe, expect, test } from "bun:test";

import {
  resolveDirectChatCostPolicy,
  shouldUseLeanDirectChatMode,
} from "../daemon/conversation-cost-policy.js";

describe("direct chat cost policy", () => {
  test("uses lean mode for ordinary direct Telegram main-agent turns", () => {
    expect(
      shouldUseLeanDirectChatMode({
        callSite: "mainAgent",
        channelName: "telegram",
        chatType: "private",
      }),
    ).toBe(true);

    expect(
      resolveDirectChatCostPolicy({
        callSite: "mainAgent",
        channelName: "telegram",
        chatType: "private",
      }),
    ).toEqual({
      leanDirectChat: true,
      generateTitle: false,
      runMemoryRetrieval: false,
      injectWorkspace: false,
      initialInjectionMode: "minimal",
    });
  });

  test("uses lean mode when Telegram direct chat type is absent", () => {
    expect(
      shouldUseLeanDirectChatMode({
        callSite: "mainAgent",
        channelName: "telegram",
      }),
    ).toBe(true);
  });

  test("does not use lean mode for group or channel chats", () => {
    for (const chatType of ["group", "supergroup", "channel"]) {
      expect(
        shouldUseLeanDirectChatMode({
          callSite: "mainAgent",
          channelName: "telegram",
          chatType,
        }),
      ).toBe(false);
    }
  });

  test("does not use lean mode for command, subagent, background, or escalated turns", () => {
    const base = {
      callSite: "mainAgent" as const,
      channelName: "telegram",
      chatType: "private",
    };

    expect(
      shouldUseLeanDirectChatMode({
        ...base,
        commandIntent: { type: "start" },
      }),
    ).toBe(false);
    expect(shouldUseLeanDirectChatMode({ ...base, isSubagent: true })).toBe(
      false,
    );
    expect(
      shouldUseLeanDirectChatMode({ ...base, callSite: "heartbeatAgent" }),
    ).toBe(false);
    expect(
      shouldUseLeanDirectChatMode({
        ...base,
        overrideProfile: "quality-optimized",
      }),
    ).toBe(false);
  });

  test("does not use lean mode for Vellum dashboard conversations", () => {
    expect(
      resolveDirectChatCostPolicy({
        callSite: "mainAgent",
        channelName: "vellum",
      }),
    ).toEqual({
      leanDirectChat: false,
      generateTitle: true,
      runMemoryRetrieval: true,
      injectWorkspace: true,
      initialInjectionMode: "full",
    });
  });
});
