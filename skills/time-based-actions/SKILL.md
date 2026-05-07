---
name: time-based-actions
description: Unified routing guide for reminders, schedules, notifications, and tasks - prevents common misrouting
compatibility: "Designed for Vellum personal assistants"
metadata:
  emoji: "⏰"
  vellum:
    display-name: "Time-Based Actions"
---

Quick-reference decision guide for choosing the right tool when users ask about time-triggered actions, recurring automation, notifications, or task tracking.

## Prerequisite: Load the `schedule` skill

`schedule_create` is provided by the **`schedule`** bundled skill. Before calling `schedule_create`, ensure the skill is loaded:

```
skill_load("schedule")
```

This is required before your first `schedule_create` call. Once loaded, the skill stays active for the conversation.

## Decision Tree

1. **Does the request have a specific future time AND should fire only once?**
   - YES -> `schedule_create` with `fire_at: "<ISO 8601 timestamp>"` and `mode: "notify"`
   - Examples: "remind me at 3pm", "remind me in 5 minutes", "alert me tomorrow at 9am"

2. **Does the request have a recurring pattern?**
   - YES -> `schedule_create` with `expression` (cron/RRULE) and `mode: "notify"` (for recurring reminders/alerts) or `mode: "execute"` (if the assistant should act autonomously each recurrence)
   - Default to `mode: "notify"` for recurring reminder-style requests. Use `mode: "execute"` only when each recurrence should trigger the assistant to perform a task (e.g. "every morning, check my email and summarize it").
   - Examples: "every day at 9am", "weekly on Mondays", "every 2 hours"

3. **Does the request need an alert RIGHT NOW (no delay)?**
   - YES -> `assistant notifications send` via `bash`
   - Examples: "send me a notification", "alert me now", "ping me"

4. **Is the request about tracking work with no time trigger?**
   - YES -> `bash` with `assistant task queue add --title "<task title>"`
   - Examples: "add to my tasks", "remind me to do X" (no time), "put this on my list"

## Critical Warning: `assistant notifications send` is IMMEDIATE-ONLY

`assistant notifications send` fires **instantly** when called. It has **NO delay, scheduling, or future-time capability**. NEVER use it for:

- "Remind me in 5 minutes" -> use `schedule_create` with `fire_at`
- "Alert me at 3pm" -> use `schedule_create` with `fire_at`
- "Notify me tomorrow" -> use `schedule_create` with `fire_at`

If you use `assistant notifications send` for any of these, the notification fires immediately and the user misses their intended reminder.

## Critical Warning: `assistant task queue add` has NO time trigger

The task queue creates a work item. It does **NOT** fire at a specific time. NEVER use it as a workaround for delayed notifications. If the user wants a timed alert, use `schedule_create` with `fire_at`.

## One-Shot Reminder Pattern

For one-shot reminders ("remind me at 3pm", "alert me in 20 minutes"):

1. Load the `schedule` skill if not already active: `skill_load("schedule")`
2. Call `schedule_create` with:
   - `fire_at`: ISO 8601 timestamp (e.g. `"2026-05-07T15:00:00-05:00"`)
   - `mode`: `"notify"` for a simple alert, `"execute"` if the assistant should take action
   - `message`: the reminder text to deliver
   - `name`: a short human-readable name
   - `routing_intent`: `"all_channels"` (default)
   - `routing_hints`: `{ "preferred_channels": ["<originating channel>"] }` when available

## Time Grounding Source

Use the `current_time:` field from the injected `<turn_context>` block as the authoritative clock source. The format is:

```
current_time: 2026-04-02 (Wednesday) 14:30:00 -05:00 (America/Chicago)
```

It contains the date, weekday name, local time (HH:MM:SS), UTC offset, and IANA timezone name in parentheses.

**Timezone confidence check:** The timezone shown may be the assistant host's timezone rather than the user's actual timezone (this happens when the user has not configured `Settings -> Appearance -> User timezone`). If you have no prior confirmation of the user's timezone (from conversation history or memory) and the request is locale-specific (e.g. "at 3pm", "tomorrow morning", "tonight"), confirm the timezone once before scheduling. If the user confirms, suggest saving it in Settings -> Appearance -> User timezone so future requests resolve correctly without re-asking.

## Relative Time Parsing

When the user says "in X minutes/hours", compute the ISO 8601 timestamp yourself:

- Take the time and offset from the `current_time:` field (e.g. `23:26:00 -05:00`)
- Add the requested offset
- Format as ISO 8601 with timezone: `2026-05-07T09:05:00-05:00`
- Pass to `schedule_create` as `fire_at`

### Anchored & Ambiguous Relative Time

Phrases like "at the 45 minute mark", "at the top of the hour", "on the half-hour", "at noon", "20 minutes in", or "when I hit an hour" are **clock-position or anchored relative time** expressions. Do NOT treat them as offsets from now.

**Resolution rules (in priority order):**

1. **Conversation-anchored expressions** - if the user mentioned a start time earlier in conversation ("I got here at 9", "meeting started at 2:10"), interpret offset-style phrases ("the 45 minute mark", "20 minutes in", "when I hit an hour") as `start_time + offset`. This takes precedence because the conversational anchor overrides any wall-clock interpretation.

2. **Clock-position expressions** - when no start time is in context, map directly to a wall-clock time:
   - "top of the hour" / "on the hour" -> next :00 (e.g. 10:00 AM)
   - "the X minute mark" / "at :XX" -> current hour's :XX; if already past, advance one hour
   - "the half-hour mark" / "half past" -> nearest upcoming :30
   - "noon" / "midnight" -> 12:00 PM or 12:00 AM today; if past, tomorrow
   - "quarter past" / "quarter to" -> :15 or :45 of current or next hour

3. **Ask only if truly ambiguous** - if neither rule 1 nor rule 2 resolves, ask: "Do you mean [clock time] or [X minutes from now]?" Never silently default to "from now."

**Examples:**

- "meeting started at 2:10, remind me at the 45 minute mark" -> 2:55 PM (start + 45 min)
- "20 minutes in, I started at 2pm" -> 2:20 PM (start + 20 min)
- "at the 45 min mark" (no start time, now: 9:39) -> 9:45 AM (wall-clock)
- "at the 45 min mark" (no start time, now: 9:50) -> 10:45 AM (wall-clock, next hour)
- "top of the hour" (now: 9:39) -> 10:00 AM
- "at noon" -> 12:00 PM today
- "at the hour mark" with no start time -> ask for clarification

## "Remind me to X" Disambiguation

The word "remind" is ambiguous. Route based on whether a time is specified:

| User says                                   | Time present?   | Action                                                 |
| ------------------------------------------- | --------------- | ------------------------------------------------------ |
| "Remind me to buy milk"                     | No              | bash: `assistant task queue add --title "Buy milk"`    |
| "Remind me to buy milk at 5pm"              | Yes             | `schedule_create` with `fire_at`, `mode: "notify"`     |
| "Remind me in 10 minutes to check the oven" | Yes (relative)  | `schedule_create` with `fire_at`, `mode: "notify"`     |
| "Remind me every morning to take vitamins"  | Yes (recurring) | `schedule_create` with `expression`, `mode: "notify"`  |

## Routing

`schedule_create` supports `routing_intent` and `routing_hints` to control how notify-mode schedules are delivered:

- **`all_channels`** (default) - deliver to every available channel
- **`single_channel`** - deliver to one channel only
- **`multi_channel`** - deliver to a subset of channels

### Routing Defaults

- **Default to `all_channels`** for most reminders. Users usually want to be notified wherever they are, and redundant notifications are less harmful than missed ones.
- **Use `single_channel`** only when the user explicitly specifies a single channel (e.g. "remind me on Telegram").
- **Determine the originating channel** for routing hints using this priority:
  1. **`source_channel`** from `<turn_context>` - use directly if present. This is the authoritative channel name.
  2. **`interface` fallback** - if `source_channel` is absent (common for guardian/direct users), map the `interface` value to a channel name:
     | `interface` value | Channel name |
     | --- | --- |
     | `macos`, `ios` | `vellum` |
     | `telegram` | `telegram` |
     | `slack` | `slack` |
     | `cli` | _(omit -- no routable channel)_ |
  3. If neither field is present or the interface is `cli`, omit `preferred_channels`.

  When a channel is determined, include it as a routing hint:

  ```
  routing_hints: { preferred_channels: ["<resolved channel>"] }
  routing_intent: "all_channels"
  ```

- **Never use `single_channel` as a passive default.** If you have not thought about which channel to use, use `all_channels`.

### Examples

| Scenario                                   | routing_intent   | routing_hints                          |
| ------------------------------------------ | ---------------- | -------------------------------------- |
| `source_channel: telegram` in turn_context | `all_channels`   | `{ preferred_channels: ["telegram"] }` |
| No `source_channel`, `interface: macos`    | `all_channels`   | `{ preferred_channels: ["vellum"] }`   |
| No `source_channel`, `interface: ios`      | `all_channels`   | `{ preferred_channels: ["vellum"] }`   |
| User says "remind me on Telegram"          | `single_channel` | `{ preferred_channels: ["telegram"] }` |
| No `source_channel`, `interface: cli`      | `all_channels`   | `{}`                                   |
| No channel info available                  | `all_channels`   | `{}`                                   |

## Tool Summary

| Tool / Command                                   | Timing                 | Recurrence       | Purpose                                       |
| ------------------------------------------------ | ---------------------- | ---------------- | --------------------------------------------- |
| `schedule_create` with `fire_at`                 | Future time (one-shot) | No               | Timed notification or timed autonomous action |
| `schedule_create` with `expression`              | Recurring pattern      | Yes (cron/RRULE) | Recurring automated jobs                      |
| `assistant notifications send` (bash)            | **Immediate only**     | No               | Alert the user right now                      |
| `assistant task queue add --title "..."` (bash)  | **No time trigger**    | No               | Track work in the task queue                  |
