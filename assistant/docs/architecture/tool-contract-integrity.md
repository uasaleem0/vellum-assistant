# Tool Contract Integrity — Why "Val can't fill in basic params" Keeps Recurring

This assistant has hit the same underlying failure class at least four times
under different symptoms, each time diagnosed and "fixed" without closing the
structural gap that let it happen — including a fourth occurrence found within
hours of the first fix landing, one file away from it. This doc names the
pattern so the next incident gets recognized faster, and records the
guardrails now in place.

## The pattern

The model is not the unreliable part. Every incident below involved the
model doing the reasonable, convention-following thing and getting rejected
by a hand-written surface that silently drifted out of sync with what the
model was told (or reasonably inferred) was true.

| Date       | Symptom                                                                                            | What actually drifted                                                                                                                                                                                                                                                                                    |
| ---------- | -------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 2026-06-10 | "Val doesn't know her tools"                                                                       | Skill catalog not injected into the system prompt; `NOW.md` told the model to call fictional `list_emails`/`draft_email` tools that were never real                                                                                                                                                      |
| 2026-06-19 | `add_task` 500s, ElevenLabs agent missing 17 tools                                                 | `patch_agent.py` full-replaced (rather than merged) the ElevenLabs tool list; a Zod schema rejected `null` where the caller sent it                                                                                                                                                                      |
| 2026-07-01 | "Val can't set a reminder", 69-100% error rates on `create_task`/`schedule_create`/`task_list_add` | Skill-config tools never received the universal `activity` field injection every native/MCP tool gets; `NOW.md` instructed calling `task_list_add`, a function wired only to an HTTP route, never registered as a model-callable tool                                                                    |
| 2026-07-02 | Same `task_list_add` dead reference, found during the postmortem review of the 2026-07-01 fix      | `schedule/TOOLS.json`'s own `schedule_create`/`schedule_list` descriptions and `schedule/SKILL.md`'s Tips section still said `task_list_add`/`task_list_show` — the _same_ stale name, one file over from where it had just been fixed, enshrined as "expected" by two tests in `intent-routing.test.ts` |

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

**The 2026-07-02 incident makes the mechanism explicit rather than just
theorized.** The 2026-07-01 fix scoped itself to the exact file the incident
happened to surface in (`NOW.md`), even though the incident's own root cause
("Val was told to call a tool that doesn't exist") obviously wasn't specific
to that one file. The first version of the drift-check guardrail inherited
the same narrow scope — it only read `NOW.md` and four sibling top-level
docs, so it reported "clean" while `schedule/TOOLS.json` and
`schedule/SKILL.md` sat right next to it with the identical dead reference,
undetected. **A fix and its guardrail both need to be scoped to the failure
class named in the postmortem, not to the file the complaint happened to
land in** — otherwise the guardrail just adds false confidence on top of
unfixed drift.

## What's actually in place now (2026-07-01/02)

Two guardrails, both intentionally lightweight — proportionate to a
single-user system, not a full CI pipeline:

1. **`validateInputAgainstSchema` (`src/skills/validate-input.ts`) always
   accepts the universal `activity` field**, regardless of what an
   individual skill's `TOOLS.json` declares. This closes the contract gap
   at the one chokepoint every skill-tool call passes through, instead of
   patching each affected tool's schema individually — so it also covers
   skill tools not yet known to be affected.

2. **`bun run lint:tool-refs` (`scripts/check-tool-references.ts`)** scans:
   - `NOW.md`/`SOUL.md`/`IDENTITY.md`/`HEARTBEAT.md`/`VAL-CUSTOM-PATCHES.md`
     for backtick-quoted tokens that look like tool names but aren't
     registered;
   - every skill's own `TOOLS.json` for any snake_case token not registered
     and not part of that manifest's own schema (param names/enum values are
     auto-collected from the parsed JSON, not hand-listed, so this needs no
     upkeep as tools' own params change);
   - every skill's own `SKILL.md` for "use/call/invoke X" redirect phrases
     specifically — a blanket snake_case scan of free-form prose was tried
     first and produced 88 mostly-false-positive flags across the bundled
     skill catalog, which would have made the checker unusable noise (the
     same "guardrail rots and nobody reads it" failure mode this doc is
     trying to prevent, just self-inflicted from day one instead of by
     neglect).

   It is **not** wired into the pre-commit hook or CI — run it manually
   after editing a workspace doc or a skill's `TOOLS.json`/`SKILL.md`, or
   after renaming/removing a tool. It has a small hand-maintained allowlist
   (`KNOWN_NON_TOOLS`, `KNOWN_NATIVE_TOOLS`) for expected non-matches
   (parameter names, skill ids, MCP tools, capability tags, intentional
   "there is no X tool" negative references); expect to extend it
   occasionally rather than achieving zero maintenance. Verified clean
   across the full bundled + workspace skill catalog as of 2026-07-02.

Neither guardrail prevents _every_ instance of this pattern (a fully general
fix would mean generating tool schemas and prompt docs from a single source
of truth, which is a much bigger project than this warrants right now). They
target the failure modes actually observed, now scoped to every place those
modes can occur (not just the one file each incident happened to be noticed
in). If a fifth incident of this shape shows up in a part of the system
these still don't cover, that's a signal to reconsider the scope again — and
to ask, explicitly, "does the new guardrail cover the failure class, or just
the file the complaint mentioned?" before calling it done.

## Related

- `docs/architecture/scheduling.md` — the `schedule_create` tool whose
  validation was also batched (all field errors reported together instead
  of one per retry round) as part of the 2026-07-01 fix.
