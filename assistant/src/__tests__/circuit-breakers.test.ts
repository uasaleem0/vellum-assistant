import { afterEach, beforeEach, describe, expect, mock, test } from "bun:test";

mock.module("../util/logger.js", () => ({
  getLogger: () =>
    new Proxy({} as Record<string, unknown>, {
      get: () => () => {},
    }),
}));

import type { RateLimitConfig } from "../config/types.js";
import {
  __resetAutonomousRateLimitForTest,
  __resetBackgroundRateLimitForTest,
} from "../providers/background-rate-limit.js";
import { RateLimitProvider } from "../providers/ratelimit.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "../providers/types.js";
import { RateLimitError } from "../util/errors.js";

function makeProvider(response?: Partial<ProviderResponse>): Provider {
  return {
    name: "mock",
    sendMessage: async () => ({
      content: [{ type: "text" as const, text: "ok" }],
      model: "test-model",
      usage: { inputTokens: 100, outputTokens: 50 },
      stopReason: "end_turn",
      ...response,
    }),
  };
}

const messages: Message[] = [
  { role: "user", content: [{ type: "text", text: "hi" }] },
];

// Per-minute limit high enough that only the circuit breakers can trip.
const config: RateLimitConfig = { maxRequestsPerMinute: 10_000 };

function backgroundCall(callSite: string): SendMessageOptions {
  // The shape every production caller sends: callSite nested in `config`.
  return { config: { callSite } } as SendMessageOptions;
}

function autonomousCall(): SendMessageOptions {
  return {
    config: { callSite: "mainAgent", turnOrigin: "autonomous" },
  } as SendMessageOptions;
}

function interactiveCall(): SendMessageOptions {
  return {
    config: { callSite: "mainAgent", turnOrigin: "interactive" },
  } as SendMessageOptions;
}

describe("RateLimitProvider circuit breakers", () => {
  beforeEach(() => {
    __resetBackgroundRateLimitForTest();
    __resetAutonomousRateLimitForTest();
  });

  afterEach(() => {
    delete process.env.BACKGROUND_MAX_CALLS_PER_HOUR;
    delete process.env.AUTONOMOUS_MAX_CALLS_PER_HOUR;
  });

  describe("background window", () => {
    test("gates production-shaped calls (callSite nested in options.config)", async () => {
      // Regression: the original breaker read a top-level `options.callSite`
      // that no production caller sets, making it silently inert.
      process.env.BACKGROUND_MAX_CALLS_PER_HOUR = "2";
      const provider = new RateLimitProvider(makeProvider(), config);

      await provider.sendMessage(messages, backgroundCall("memoryRouter"));
      await provider.sendMessage(messages, backgroundCall("memoryRouter"));
      await expect(
        provider.sendMessage(messages, backgroundCall("memoryRouter")),
      ).rejects.toThrow(RateLimitError);
    });

    test("counts all background call-sites against one shared window", async () => {
      process.env.BACKGROUND_MAX_CALLS_PER_HOUR = "2";
      const provider = new RateLimitProvider(makeProvider(), config);

      await provider.sendMessage(messages, backgroundCall("memoryRouter"));
      await provider.sendMessage(
        messages,
        backgroundCall("analyzeConversation"),
      );
      await expect(
        provider.sendMessage(messages, backgroundCall("heartbeatAgent")),
      ).rejects.toThrow(RateLimitError);
    });

    test("never gates mainAgent or unknown call-sites", async () => {
      process.env.BACKGROUND_MAX_CALLS_PER_HOUR = "1";
      const provider = new RateLimitProvider(makeProvider(), config);

      for (let i = 0; i < 3; i++) {
        await provider.sendMessage(messages, interactiveCall());
        await provider.sendMessage(messages); // no callSite at all
      }
    });

    test("cap 0 disables the breaker", async () => {
      process.env.BACKGROUND_MAX_CALLS_PER_HOUR = "0";
      const provider = new RateLimitProvider(makeProvider(), config);

      for (let i = 0; i < 5; i++) {
        await provider.sendMessage(messages, backgroundCall("memoryRouter"));
      }
    });
  });

  describe("autonomous window", () => {
    test("gates autonomous mainAgent turns at the cap", async () => {
      process.env.AUTONOMOUS_MAX_CALLS_PER_HOUR = "2";
      const provider = new RateLimitProvider(makeProvider(), config);

      await provider.sendMessage(messages, autonomousCall());
      await provider.sendMessage(messages, autonomousCall());
      await expect(
        provider.sendMessage(messages, autonomousCall()),
      ).rejects.toThrow(RateLimitError);
    });

    test("interactive mainAgent turns are never counted or gated", async () => {
      process.env.AUTONOMOUS_MAX_CALLS_PER_HOUR = "1";
      const provider = new RateLimitProvider(makeProvider(), config);

      await provider.sendMessage(messages, autonomousCall()); // fills the window
      for (let i = 0; i < 3; i++) {
        await provider.sendMessage(messages, interactiveCall());
        // mainAgent with no turnOrigin at all (legacy caller) is interactive.
        await provider.sendMessage(messages, backgroundCall("mainAgent"));
      }
      // The window still holds only the one autonomous call → next one trips.
      await expect(
        provider.sendMessage(messages, autonomousCall()),
      ).rejects.toThrow(RateLimitError);
    });

    test("autonomous and background windows are independent", async () => {
      process.env.BACKGROUND_MAX_CALLS_PER_HOUR = "1";
      process.env.AUTONOMOUS_MAX_CALLS_PER_HOUR = "1";
      const provider = new RateLimitProvider(makeProvider(), config);

      await provider.sendMessage(messages, backgroundCall("memoryRouter"));
      // Background window is full; the autonomous window must still admit.
      await provider.sendMessage(messages, autonomousCall());
      await expect(
        provider.sendMessage(messages, backgroundCall("memoryRouter")),
      ).rejects.toThrow(RateLimitError);
      await expect(
        provider.sendMessage(messages, autonomousCall()),
      ).rejects.toThrow(RateLimitError);
    });

    test("cap 0 disables the breaker", async () => {
      process.env.AUTONOMOUS_MAX_CALLS_PER_HOUR = "0";
      const provider = new RateLimitProvider(makeProvider(), config);

      for (let i = 0; i < 5; i++) {
        await provider.sendMessage(messages, autonomousCall());
      }
    });
  });

  test("fails open on malformed options", async () => {
    process.env.BACKGROUND_MAX_CALLS_PER_HOUR = "1";
    const provider = new RateLimitProvider(makeProvider(), config);

    // A config getter that throws must not block the call.
    const poisoned = {} as SendMessageOptions;
    Object.defineProperty(poisoned, "config", {
      get() {
        throw new Error("boom");
      },
    });
    const response = await provider.sendMessage(messages, poisoned);
    expect(response.content[0]).toEqual({ type: "text", text: "ok" });
  });
});
