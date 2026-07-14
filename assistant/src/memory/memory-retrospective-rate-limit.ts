// ---------------------------------------------------------------------------
// Memory retrospective — global hourly run circuit breaker.
// ---------------------------------------------------------------------------
//
// Defense-in-depth sibling to the per-turn MAX_TOOL_USE_TURNS backstop in
// agent/loop.ts. That cap bounds ONE fork's tool loop; this bounds how many
// retrospective forks may RUN per rolling hour across ALL conversations, so a
// re-enqueue cycle, a self-triggering loop, or a many-source burst cannot spend
// unbounded even though each individual fork is already turn-capped.
//
// In-memory sliding window on the long-lived daemon process. A daemon restart
// resets it — acceptable, since a restart is itself a circuit break (it kills
// any in-flight runaway). The cap is enforced at the point a run commits to the
// expensive fork+wake path; cheap early-return runs (no new messages, source
// mid-turn) are never counted. See `memory-retrospective-job.ts`.

const WINDOW_MS = 60 * 60 * 1000;

// Ascending run-start timestamps within the trailing WINDOW_MS.
const runStarts: number[] = [];

function evictExpired(now: number): void {
  const cutoff = now - WINDOW_MS;
  let i = 0;
  while (i < runStarts.length && runStarts[i]! < cutoff) i++;
  if (i > 0) runStarts.splice(0, i);
}

/** Runs that have started (committed to fork+wake) in the trailing hour. */
export function retrospectiveRunsInLastHour(now: number = Date.now()): number {
  evictExpired(now);
  return runStarts.length;
}

/** Record that a run is committing to the expensive path. */
export function recordRetrospectiveRun(now: number = Date.now()): void {
  evictExpired(now);
  runStarts.push(now);
}

/** Test-only: reset the window. */
export function __resetRetrospectiveRateLimitForTest(): void {
  runStarts.length = 0;
}
