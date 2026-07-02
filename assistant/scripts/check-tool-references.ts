#!/usr/bin/env bun
/**
 * Flags backtick-quoted, snake_case tokens in always-injected workspace docs
 * (NOW.md, SOUL.md, IDENTITY.md, HEARTBEAT.md, VAL-CUSTOM-PATCHES.md) that
 * look like tool names but aren't in the current tool registry.
 *
 * These docs are hand-edited free text with no type system, so nothing stops
 * a tool rename/removal from leaving a stale reference behind that the model
 * will dutifully try to call and fail on every single time (e.g. `task_list_add`,
 * `list_emails` — both real incidents). This is a coarse heuristic, not a
 * type-checker: it flags every unrecognized token for a human to eyeball, on
 * the assumption that a short manual scan beats another multi-week silent
 * failure. Expect some noise (parameter names, skill ids) — that's fine.
 *
 * Usage:
 *   cd assistant && VELLUM_WORKSPACE_DIR=<path> bun run scripts/check-tool-references.ts
 *   (run manually after editing NOW.md/SOUL.md, or renaming/removing a tool;
 *   VELLUM_WORKSPACE_DIR defaults to this box's single local assistant instance)
 */

import { existsSync, readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";

const WORKSPACE =
  process.env.VELLUM_WORKSPACE_DIR ??
  "/home/mainadmin/.local/share/vellum/assistants/vellum/.vellum/workspace";
const BUNDLED_SKILLS = join(
  import.meta.dirname,
  "../src/config/bundled-skills",
);
const WORKSPACE_SKILLS = join(WORKSPACE, "skills");

const DOCS_TO_CHECK = [
  join(WORKSPACE, "NOW.md"),
  join(WORKSPACE, "SOUL.md"),
  join(WORKSPACE, "IDENTITY.md"),
  join(WORKSPACE, "HEARTBEAT.md"),
  join(WORKSPACE, "VAL-CUSTOM-PATCHES.md"),
];

// Tokens that legitimately look like tool names but aren't (parameter names,
// skill ids referenced in prose, etc). Extend this as false positives show up.
const KNOWN_NON_TOOLS = new Set([
  "activity",
  "description",
  "due_date",
  "goal_id",
  "notes",
  "priority",
  "required_tools",
  "title",
  "gmail",
  "messaging",
  "n8n",
  "schedule",
  "tasks",
  "system",
  "provider",
  "profile",
  "speed",
  "balanced",
  "cache_control",
  "unpriced",
  "cache_creation_1h_tokens",
  "cache_creation_5m_tokens",
  "llm_usage_events",
  // Intentional negative references ("there is NO X tool, use Y instead") --
  // these are meant to name a tool that doesn't exist, so they'll always
  // fail the registry check. Leave documented here rather than silently
  // dropping the check for the doc.
  "list_emails",
  // MCP tools aren't in the skill/native scan (loaded dynamically per MCP
  // server config); add ones referenced in docs here as they come up.
  "mcp__exa__web_fetch_exa",
  "mcp__exa__web_search_exa",
]);

// Native (hand-coded, non-skill) tools have no single manifest to read at
// script time -- best-effort static list from `grep -rn 'name: "' src/tools`.
// A native tool renamed without updating this list will show up as a false
// positive here (annoying, not dangerous) rather than a false negative.
// Extend when adding/renaming a native tool.
const KNOWN_NATIVE_TOOLS = new Set([
  "ask_question",
  "bash",
  "computer_use_click",
  "computer_use_done",
  "computer_use_drag",
  "computer_use_key",
  "computer_use_observe",
  "computer_use_open_app",
  "computer_use_respond",
  "computer_use_run_applescript",
  "computer_use_scroll",
  "computer_use_type_text",
  "computer_use_wait",
  "file_edit",
  "file_list",
  "file_read",
  "file_write",
  "host_bash",
  "host_file_edit",
  "host_file_read",
  "host_file_transfer",
  "host_file_write",
  "make_authenticated_request",
  "notify_parent",
  "recall",
  "remember",
  "request_system_permission",
  "run_authenticated_command",
  "skill_execute",
  "skill_load",
  "ui_dismiss",
  "ui_show",
  "ui_update",
  "web_fetch",
  "web_search",
  "app_open",
]);

function collectRegisteredToolNames(): Set<string> {
  const names = new Set<string>();
  for (const skillsRoot of [BUNDLED_SKILLS, WORKSPACE_SKILLS]) {
    if (!existsSync(skillsRoot)) continue;
    for (const dir of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const toolsJsonPath = join(skillsRoot, dir.name, "TOOLS.json");
      if (!existsSync(toolsJsonPath)) continue;
      try {
        const parsed = JSON.parse(readFileSync(toolsJsonPath, "utf-8"));
        const tools = Array.isArray(parsed) ? parsed : parsed.tools;
        for (const t of tools ?? []) {
          if (typeof t?.name === "string") names.add(t.name);
        }
      } catch (err) {
        console.error(`  ! failed to parse ${toolsJsonPath}: ${err}`);
      }
    }
  }
  return names;
}

function extractBacktickTokens(content: string): string[] {
  const matches = content.matchAll(/`([a-z][a-z0-9_]*)`/g);
  return [...matches].map((m) => m[1]);
}

function main() {
  const registered = collectRegisteredToolNames();
  for (const t of KNOWN_NATIVE_TOOLS) registered.add(t);
  console.log(`Registered skill + known-native tool names: ${registered.size}`);

  let flaggedCount = 0;
  for (const docPath of DOCS_TO_CHECK) {
    if (!existsSync(docPath)) continue;
    const content = readFileSync(docPath, "utf-8");
    const tokens = new Set(extractBacktickTokens(content));
    const unknown = [...tokens].filter(
      (t) => !registered.has(t) && !KNOWN_NON_TOOLS.has(t) && t.includes("_"),
    );
    if (unknown.length === 0) continue;
    console.log(`\n${docPath}`);
    for (const t of unknown.sort()) {
      console.log(
        `  ? \`${t}\` — not a registered skill tool. Verify: renamed/removed tool, native tool (check src/tools/), or add to KNOWN_NON_TOOLS if it's a param/skill-id.`,
      );
      flaggedCount++;
    }
  }

  if (flaggedCount === 0) {
    console.log("\nNo unrecognized tool-name-shaped references found.");
  } else {
    console.log(
      `\n${flaggedCount} token(s) flagged for manual review (this does not fail CI — it's a scan aid).`,
    );
  }
}

main();
