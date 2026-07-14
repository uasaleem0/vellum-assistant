import { z } from "zod";

export const MemoryRetrospectiveConfigSchema = z
  .object({
    timeThresholdMs: z
      .number({
        error: "memory.retrospective.timeThresholdMs must be a number",
      })
      .int("memory.retrospective.timeThresholdMs must be an integer")
      .positive(
        "memory.retrospective.timeThresholdMs must be a positive integer",
      )
      .default(30 * 60 * 1000)
      .describe(
        "Milliseconds since the last retrospective attempt before the interval trigger fires.",
      ),

    messageThreshold: z
      .number({
        error: "memory.retrospective.messageThreshold must be a number",
      })
      .int("memory.retrospective.messageThreshold must be an integer")
      .positive(
        "memory.retrospective.messageThreshold must be a positive integer",
      )
      .default(10)
      .describe(
        "New messages since the last successful retrospective run before the message-count trigger fires.",
      ),

    minCooldownMs: z
      .number({ error: "memory.retrospective.minCooldownMs must be a number" })
      .int("memory.retrospective.minCooldownMs must be an integer")
      .nonnegative(
        "memory.retrospective.minCooldownMs must be a non-negative integer",
      )
      .default(5 * 60 * 1000)
      .describe(
        "Minimum milliseconds between attempts (success or failure). Prevents tight retry loops across trigger types. Pre-compaction bypasses this gate.",
      ),

    maxRunsPerHour: z
      .number({ error: "memory.retrospective.maxRunsPerHour must be a number" })
      .int("memory.retrospective.maxRunsPerHour must be an integer")
      .positive("memory.retrospective.maxRunsPerHour must be a positive integer")
      .default(60)
      .describe(
        "Global circuit breaker: max retrospective forks that may RUN per rolling hour across ALL conversations. Defense-in-depth sibling to the per-turn MAX_TOOL_USE_TURNS backstop — bounds run COUNT, not one run's tool loop. Normal peak is well under this; a runaway is 10-30x it. In-memory window, reset on daemon restart.",
      ),

    keepSupersededRuns: z
      .boolean({
        error: "memory.retrospective.keepSupersededRuns must be a boolean",
      })
      .default(false)
      .describe(
        "When false (default), superseded retrospective conversations are deleted once a newer run succeeds — the persisted remembered_log on memory_retrospective_state is the dedup baseline (the most recent run is scanned only as a fallback for state rows that predate the log column), so older runs are dead weight (fork-based runs each carry a full copy of the source conversation's messages). Operators who want to retain the full run history set this to true; retained runs also skip the startup orphan sweep so they survive restarts.",
      ),

    matchConversationProfile: z
      .boolean({
        error:
          "memory.retrospective.matchConversationProfile must be a boolean",
      })
      .default(false)
      .describe(
        "When true, fork-based retrospectives run under the source conversation's inference profile (which forkConversation copies onto the fork) instead of the call site's default. Provider prompt caches are byte-exact prefix matches scoped per model, and a thinking enable/disable mismatch invalidates the messages cache tier — so reusing the source's cached prefix requires the retrospective to resolve the SAME model/thinking/effort as the conversation's own turns. Falls back to the call site's default when the conversation has no profile or the referenced profile no longer exists.",
      ),
  })
  .describe(
    "Controls the memory-retrospective background pass. Model selection lives under llm.callSites.memoryRetrospective.",
  );

export type MemoryRetrospectiveConfig = z.infer<
  typeof MemoryRetrospectiveConfigSchema
>;
