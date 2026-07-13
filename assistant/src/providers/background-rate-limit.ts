// ---------------------------------------------------------------------------
// Global background-LLM circuit breaker (cost-runaway defense-in-depth).
// ---------------------------------------------------------------------------
//
// Defense-in-depth sibling to two existing, NARROWER protections:
//   - MAX_TOOL_USE_TURNS (agent/loop.ts) bounds ONE agent turn's tool loop.
//   - the memory-retrospective hourly breaker bounds ONE subsystem.
//
// Neither catches a runaway in an unforeseen path: a new watcher, a new fork
// type, a job that self-re-enqueues, or a recursion guard that a future source
// slips past. Two such runaways happened within three days (memory-retrospective
// fork loop; consolidation<->auto-analysis loop), each firing hundreds-to-
// thousands of BACKGROUND provider calls per hour.
//
// This bounds how many BACKGROUND (i.e. NOT `mainAgent`) provider calls may run
// per rolling hour across the WHOLE daemon — every conversation, every
// subagent, every memory/analysis job — regardless of WHICH code path issues
// them. It is the catch-all that trips on any background loop we did not
// individually guard. User-facing `mainAgent` turns are never counted and never
// gated, so a trip degrades only background automation, never live chat/voice.
//
// Normal background load on this deployment peaks well under ~80 calls/hr; the
// observed runaways ran at ~300-1,400/hr. The default cap (250/hr) sits with
// comfortable headroom above legitimate load and below every runaway. Tune with
// the BACKGROUND_MAX_CALLS_PER_HOUR env var; set it to 0 to disable the breaker.
//
// In-memory sliding window on the long-lived daemon process. A restart resets
// it — acceptable, since a restart is itself a circuit break.

const WINDOW_MS = 60 * 60 * 1000;
const DEFAULT_MAX_PER_HOUR = 250;

/**
 * Effective hourly cap. `0` (or a non-positive / unparseable override) disables
 * the breaker. Read per-call so an operator can retune via env without a
 * code change (the value is cheap to parse).
 */
export function backgroundCallCapPerHour(): number {
  const raw = process.env.BACKGROUND_MAX_CALLS_PER_HOUR;
  if (raw === undefined || raw === "") return DEFAULT_MAX_PER_HOUR;
  const n = Number.parseInt(raw, 10);
  if (!Number.isFinite(n)) return DEFAULT_MAX_PER_HOUR;
  return n; // 0 or negative => disabled (checked by caller)
}

// Ascending timestamps of background calls admitted within the trailing hour.
const callStarts: number[] = [];

function evictExpired(now: number): void {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < callStarts.length && callStarts[i]! < cutoff) i++;
  if (i > 0) callStarts.splice(0, i);
}

/** Background calls admitted in the trailing hour. */
export function backgroundCallsInLastHour(now: number = Date.now()): number {
  evictExpired(now);
  return callStarts.length;
}

/** Record that a background call is being admitted. */
export function recordBackgroundCall(now: number = Date.now()): void {
  evictExpired(now);
  callStarts.push(now);
}

/** Test-only: reset the window. */
export function __resetBackgroundRateLimitForTest(): void {
  callStarts.length = 0;
}
