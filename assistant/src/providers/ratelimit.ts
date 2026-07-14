import type { RateLimitConfig } from "../config/types.js";
import { RateLimitError } from "../util/errors.js";
import { getLogger } from "../util/logger.js";
import {
  autonomousCallCapPerHour,
  autonomousCallsInLastHour,
  backgroundCallCapPerHour,
  backgroundCallsInLastHour,
  recordAutonomousCall,
  recordBackgroundCall,
} from "./background-rate-limit.js";
import type {
  Message,
  Provider,
  ProviderResponse,
  SendMessageOptions,
} from "./types.js";

const log = getLogger("rate-limit");

export class RateLimitProvider implements Provider {
  // Delegate name dynamically so that wrapper providers (e.g.
  // CallSiteRoutingProvider) whose name getter reflects per-call async context
  // (AsyncLocalStorage) are reached correctly during streaming — rather than
  // returning a stale snapshot captured at construction time.
  get name(): string {
    return this.inner.name;
  }

  get tokenEstimationProvider(): string | undefined {
    return this.inner.tokenEstimationProvider;
  }

  private requestTimestamps: number[];

  constructor(
    private readonly inner: Provider,
    private readonly config: RateLimitConfig,
    sharedRequestTimestamps?: number[],
  ) {
    this.requestTimestamps = sharedRequestTimestamps ?? [];
  }

  async sendMessage(
    messages: Message[],
    options?: SendMessageOptions,
  ): Promise<ProviderResponse> {
    this.enforceRequestRate();

    // Record the request timestamp before the await to prevent concurrent
    // calls from bypassing the rate limit during the async gap.
    this.recordRequest();

    // Global LLM circuit breakers (defense-in-depth): background calls and
    // autonomous mainAgent turns each have their own rolling-hour window.
    // Live user turns are never gated. Fails open.
    this.enforceCircuitBreakers(options);

    const response = await this.inner.sendMessage(messages, options);

    return response;
  }

  private enforceRequestRate(): void {
    const limit = this.config.maxRequestsPerMinute;
    if (limit <= 0) return;

    const now = Date.now();
    const windowStart = now - 60_000;
    // Prune expired timestamps in-place to preserve the shared array
    // reference. Single-pass compaction: copy valid entries to the front,
    // track the oldest surviving entry, and truncate — all in O(n).
    let write = 0;
    let oldestInWindow = Infinity;
    for (let read = 0; read < this.requestTimestamps.length; read++) {
      if (this.requestTimestamps[read] > windowStart) {
        if (this.requestTimestamps[read] < oldestInWindow) {
          oldestInWindow = this.requestTimestamps[read];
        }
        this.requestTimestamps[write++] = this.requestTimestamps[read];
      }
    }
    this.requestTimestamps.length = write;

    if (this.requestTimestamps.length >= limit) {
      const waitSec = Math.ceil((oldestInWindow + 60_000 - now) / 1000);
      log.warn(
        {
          provider: this.name,
          limit,
          currentCount: this.requestTimestamps.length,
          retryAfterSec: waitSec,
        },
        `Provider rate limit exceeded: ${limit} requests/minute for ${this.name}`,
      );
      throw new RateLimitError(
        `Rate limit exceeded: ${limit} requests/minute. Try again in ${waitSec}s.`,
      );
    }
  }

  // Global LLM circuit breakers. Two rolling-hour windows (see
  // background-rate-limit.ts):
  //   1. background — every non-`mainAgent` call (memory jobs, analysis,
  //      classifiers, ...), so a runaway in ANY background path cannot spend
  //      unbounded even if every per-source guard is bypassed.
  //   2. autonomous — `mainAgent` turns no human initiated (schedule, watcher,
  //      wake; tagged `turnOrigin: "autonomous"` by the agent loop), so a
  //      wake/schedule storm is bounded too.
  // Live user turns (`mainAgent` without the autonomous tag) are never counted
  // or gated. Fails OPEN: any internal error here proceeds with the call
  // rather than blocking the assistant.
  //
  // NOTE: `callSite`/`turnOrigin` live on `options.config` (SendMessageConfig)
  // — that is the shape every production caller sends. The original breaker
  // read a top-level `options.callSite` that no caller sets, which made it
  // silently inert; keep the top-level read only as a fallback.
  private enforceCircuitBreakers(options?: SendMessageOptions): void {
    let tripped: RateLimitError | null = null;
    try {
      const config = options?.config;
      const callSite =
        config?.callSite ??
        (options as { callSite?: string } | undefined)?.callSite;
      // Unknown/undefined call-sites are always admitted.
      if (!callSite) return;

      if (callSite === "mainAgent") {
        if (config?.turnOrigin !== "autonomous") return; // live user turn
        const cap = autonomousCallCapPerHour();
        if (cap <= 0) return; // breaker disabled
        const count = autonomousCallsInLastHour();
        if (count >= cap) {
          log.error(
            { callSite, count, cap },
            "[AUTONOMOUS CIRCUIT BREAKER] hourly autonomous-turn LLM call cap reached; rejecting autonomous call. Live user turns are unaffected. Tune via AUTONOMOUS_MAX_CALLS_PER_HOUR (0 disables).",
          );
          tripped = new RateLimitError(
            `Autonomous LLM circuit open: ${count} autonomous mainAgent calls in the last hour (cap ${cap}). Scheduled/watcher/wake work paused; live user turns unaffected.`,
          );
        } else {
          recordAutonomousCall();
        }
      } else {
        const cap = backgroundCallCapPerHour();
        if (cap <= 0) return; // breaker disabled
        const count = backgroundCallsInLastHour();
        if (count >= cap) {
          log.error(
            { callSite, count, cap },
            "[BACKGROUND CIRCUIT BREAKER] hourly background LLM call cap reached; rejecting background call. User-facing calls are unaffected. Tune via BACKGROUND_MAX_CALLS_PER_HOUR (0 disables).",
          );
          tripped = new RateLimitError(
            `Background LLM circuit open: ${count} background calls in the last hour (cap ${cap}). Background work paused; user-facing calls unaffected.`,
          );
        } else {
          recordBackgroundCall();
        }
      }
    } catch (err) {
      // Fail OPEN — the breaker must never itself break the assistant.
      log.warn({ err }, "circuit breaker internal error; failing open");
      return;
    }
    if (tripped) throw tripped;
  }

  private recordRequest(): void {
    if (this.config.maxRequestsPerMinute <= 0) return;
    this.requestTimestamps.push(Date.now());
  }
}
