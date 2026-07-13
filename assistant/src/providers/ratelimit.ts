import type { RateLimitConfig } from "../config/types.js";
import { RateLimitError } from "../util/errors.js";
import {
  backgroundCallCapPerHour,
  backgroundCallsInLastHour,
  recordBackgroundCall,
} from "./background-rate-limit.js";
import { getLogger } from "../util/logger.js";
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

    // Global background-LLM circuit breaker (defense-in-depth). No-op for
    // `mainAgent` (live user turns) and when disabled. Fails open.
    this.enforceBackgroundCircuit(options);

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

  // Global background-LLM circuit breaker. Bounds background (non-`mainAgent`)
  // provider calls per rolling hour across the whole daemon, so a runaway in
  // ANY background path (a new watcher, a self-re-enqueuing job, a missed
  // recursion guard) cannot spend unbounded even if every per-source guard is
  // bypassed. User-facing `mainAgent` turns are never counted or gated. Fails
  // OPEN: any internal error here proceeds with the call rather than blocking
  // the assistant. See background-rate-limit.ts.
  private enforceBackgroundCircuit(options?: SendMessageOptions): void {
    let tripped: RateLimitError | null = null;
    try {
      const callSite = options?.callSite;
      // Only known background call-sites are gated; `mainAgent` and
      // unknown/undefined call-sites are always admitted.
      if (!callSite || callSite === "mainAgent") return;
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
    } catch (err) {
      // Fail OPEN — the breaker must never itself break the assistant.
      log.warn({ err }, "background circuit breaker internal error; failing open");
      return;
    }
    if (tripped) throw tripped;
  }

  private recordRequest(): void {
    if (this.config.maxRequestsPerMinute <= 0) return;
    this.requestTimestamps.push(Date.now());
  }
}
