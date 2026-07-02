# Tool Contract Integrity — Why "Val can't fill in basic params" Keeps Recurring

This assistant has hit the same underlying failure class at least three times
under different symptoms, each time diagnosed and "fixed" without closing the
structural gap that let it happen. This doc names the pattern so the next
incident gets recognized faster, and records the guardrails now in place.

## The pattern

The model is not the unreliable part. Every incident below involved the
model doing the reasonable, convention-following thing and getting rejected
by a hand-written surface that silently drifted out of sync with what the
model was told (or reasonably inferred) was true.

| Date       | Symptom                                                                                            | What actually drifted                                                                                                                                                                                                                 |
| ---------- | -------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-10 | "Val doesn't know her tools"                                                                       | Skill catalog not injected into the system prompt; `NOW.md` told the model to call fictional `list_emails`/`draft_email` tools that were never real                                                                                   |
| 2026-06-19 | `add_task` 500s, ElevenLabs agent missing 17 tools                                                 | `patch_agent.py` full-replaced (rather than merged) the ElevenLabs tool list; a Zod schema rejected `null` where the caller sent it                                                                                                   |
| 2026-07-01 | "Val can't set a reminder", 69-100% error rates on `create_task`/`schedule_create`/`task_list_add` | Skill-config tools never received the universal `activity` field injection every native/MCP tool gets; `NOW.md` instructed calling `task_list_add`, a function wired only to an HTTP route, never registered as a model-callable tool |

The common shape: **a hand-maintained surface (a prompt doc, a config file, a
hard-coded param allowlist) makes a claim about the tool registry that
nothing checks against the registry itself.** The claim goes stale the next
time a tool is renamed, removed, or gains a new convention, and nothing
fails until the model tries to act on the stale claim — silently, in
production, for however long it takes a human to notice the pattern of
failures and go spelunking through conversation logs to find it.

## Why point fixes didn't stick

Every prior incident fixed the _specific_ stale reference found that day
(rewrite `NOW.md`'s email section, neutralize `patch_agent.py`, add
`get_habit_analytics`). None of them fixed the mechanism that let the drift
happen undetected — so the same shape of bug resurfaced somewhere else in
the system a few weeks later. A prior session (2026-06-19) explicitly
considered and rejected building a general "codegen tool-registry + CI gate"
as over-engineered for a single-user app. That call was reasonable on its
own terms (this isn't a team shipping to thousands of users), but it also
meant nothing was left standing guard, and drift accumulated again.

## What's actually in place now (2026-07-01/02)

Two guardrails, both intentionally lightweight — proportionate to a
single-user system, not a full CI pipeline:

1. **`validateInputAgainstSchema` (`src/skills/validate-input.ts`) always
   accepts the universal `activity` field**, regardless of what an
   individual skill's `TOOLS.json` declares. This closes the contract gap
   at the one chokepoint every skill-tool call passes through, instead of
   patching each affected tool's schema individually — so it also covers
   skill tools not yet known to be affected.

2. **`bun run lint:tool-refs` (`scripts/check-tool-references.ts`)** scans
   `NOW.md`/`SOUL.md`/`IDENTITY.md`/`HEARTBEAT.md`/`VAL-CUSTOM-PATCHES.md`
   for backtick-quoted tokens that look like tool names but aren't in the
   current skill/native tool registry, and prints them for a human to
   check. It is **not** wired into the pre-commit hook or CI — run it
   manually after editing one of those docs, or after renaming/removing a
   tool. It has a small hand-maintained allowlist (`KNOWN_NON_TOOLS`,
   `KNOWN_NATIVE_TOOLS`) for expected non-matches (parameter names, skill
   ids, MCP tools, intentional "there is no X tool" negative references);
   expect to extend it occasionally rather than achieving zero maintenance.

Neither guardrail prevents _every_ instance of this pattern (a fully general
fix would mean generating tool schemas and prompt docs from a single source
of truth, which is a much bigger project than this warrants right now). They
target the two concrete failure modes actually observed. If a fourth
incident of this shape shows up in a part of the system these two don't
cover, that's a signal to reconsider the scope, not to write another
one-off patch.

## Related

- `docs/architecture/scheduling.md` — the `schedule_create` tool whose
  validation was also batched (all field errors reported together instead
  of one per retry round) as part of the 2026-07-01 fix.
