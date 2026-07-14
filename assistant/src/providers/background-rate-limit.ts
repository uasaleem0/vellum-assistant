// ---------------------------------------------------------------------------
// Global LLM circuit breakers (cost-runaway defense-in-depth).
// ---------------------------------------------------------------------------
//
// Defense-in-depth siblings to two existing, NARROWER protections:
//   - MAX_TOOL_USE_TURNS (agent/loop.ts) bounds ONE agent turn's tool loop.
//   - the memory-retrospective hourly breaker bounds ONE subsystem.
//
// Neither catches a runaway in an unforeseen path: a new watcher, a new fork
// type, a job that self-re-enqueues, or a recursion guard that a future source
// slips past. Two such runaways happened within three days (memory-retrospective
// fork loop; consolidation<->auto-analysis loop), each firing hundreds-to-
// thousands of BACKGROUND provider calls per hour.
//
// Two independent rolling-hour windows, both enforced in ratelimit.ts:
//
// 1. BACKGROUND — every provider call whose call-site is NOT `mainAgent`
//    (memory jobs, analysis, classifiers, subagent spawns, ...), regardless of
//    WHICH code path issues it. Catch-all for background loops we did not
//    individually guard. Normal background load on this deployment peaks well
//    under ~80 calls/hr; the observed runaways ran at ~300-1,400/hr. Default
//    cap 250/hr; tune via BACKGROUND_MAX_CALLS_PER_HOUR (0 disables).
//
// 2. AUTONOMOUS mainAgent — full agent turns that no human initiated
//    (`callSite === "mainAgent"` with `turnOrigin === "autonomous"`, i.e. the
//    conversation source is a machine origin: schedule, watcher, wake,
//    heartbeat-escalation, ...). These are exempt from window 1 by design, so
//    a schedule/watcher/wake storm was previously bounded only per-turn and by
//    cron cadence. Live user turns (conversation source `user` — chat, voice,
//    val_query) are NEVER counted or gated. Legitimate autonomous load
//    (schedules + watcher ticks) peaks well under ~60 calls/hr; default cap
//    150/hr; tune via AUTONOMOUS_MAX_CALLS_PER_HOUR (0 disables).
//
// In-memory sliding windows on the long-lived daemon process. A restart resets
// them — acceptable, since a restart is itself a circuit break.

const WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_BACKGROUND_MAX_PER_HOUR = 250;
const DEFAULT_AUTONOMOUS_MAX_PER_HOUR = 150;

class SlidingHourWindow {
  // Ascending timestamps of calls admitted within the trailing hour.
  private readonly starts: number[] = [];

  private evictExpired(now: number): void {
    const cutoff = now - WINDOW_MS;
    let i = 0;
    while (i < this.starts.length && this.starts[i]! < cutoff) i++;
    if (i > 0) this.starts.splice(0, i);
  }

  count(now: number): number {
    this.evictExpired(now);
    return this.starts.length;
  }

  record(now: number): void {
    this.evictExpired(now);
    this.starts.push(now);
  }

  reset(): void {
    this.starts.length = 0;
  }
}

/**
 * Effective hourly cap from an env override. `0` (or a non-positive /
 * unparseable override) disables that breaker. Read per-call so an operator
 * can retune via env without a code change (the value is cheap to parse).
 */
function capFromEnv(envVar: string, fallback: number): number {
  const raw = process.env[envVar];
  if (raw === undefined || raw === "") return fallback;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return fallback;
  return n; // 0 or negative => disabled (checked by caller)
}

// ── Window 1: background (non-mainAgent) calls ─────────────────────────────

const backgroundWindow = new SlidingHourWindow();

export function backgroundCallCapPerHour(): number {
  return capFromEnv(
    "BACKGROUND_MAX_CALLS_PER_HOUR",
    DEFAULT_BACKGROUND_MAX_PER_HOUR,
  );
}

/** Background calls admitted in the trailing hour. */
export function backgroundCallsInLastHour(now: number = Date.now()): number {
  return backgroundWindow.count(now);
}

/** Record that a background call is being admitted. */
export function recordBackgroundCall(now: number = Date.now()): void {
  backgroundWindow.record(now);
}

// ── Window 2: autonomous mainAgent turns ───────────────────────────────────

const autonomousWindow = new SlidingHourWindow();

export function autonomousCallCapPerHour(): number {
  return capFromEnv(
    "AUTONOMOUS_MAX_CALLS_PER_HOUR",
    DEFAULT_AUTONOMOUS_MAX_PER_HOUR,
  );
}

/** Autonomous mainAgent calls admitted in the trailing hour. */
export function autonomousCallsInLastHour(now: number = Date.now()): number {
  return autonomousWindow.count(now);
}

/** Record that an autonomous mainAgent call is being admitted. */
export function recordAutonomousCall(now: number = Date.now()): void {
  autonomousWindow.record(now);
}

// ── Test-only resets ────────────────────────────────────────────────────────

export function __resetBackgroundRateLimitForTest(): void {
  backgroundWindow.reset();
}

export function __resetAutonomousRateLimitForTest(): void {
  autonomousWindow.reset();
}
