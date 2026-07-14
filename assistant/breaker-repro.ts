import { RateLimitProvider } from "./src/providers/ratelimit.ts";

const calls: unknown[] = [];
const fake = {
  name: "fake",
  async sendMessage(_m: unknown, o: unknown) {
    calls.push(o);
    return { content: [], usage: {} };
  },
};
process.env.BACKGROUND_MAX_CALLS_PER_HOUR = "2";
const p = new RateLimitProvider(fake as never, { maxRequestsPerMinute: 1000 } as never);

// production shape: callSite nested in options.config
for (let i = 0; i < 5; i++) {
  try {
    await p.sendMessage([], { config: { callSite: "memoryRouter" } } as never);
  } catch (e) {
    console.log("nested call", i, "REJECTED:", (e as Error).message.slice(0, 60));
  }
}
console.log("admitted with NESTED callSite:", calls.length, "(cap 2 — 5 means breaker inert for production shape)");

calls.length = 0;
for (let i = 0; i < 5; i++) {
  try {
    await p.sendMessage([], { callSite: "memoryRouter" } as never);
  } catch (e) {
    console.log("top-level call", i, "REJECTED:", (e as Error).message.slice(0, 55));
  }
}
console.log("admitted with TOP-LEVEL callSite:", calls.length);
