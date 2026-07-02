#!/usr/bin/env bun
/**
 * Flags snake_case tokens in tool descriptions/instructions that look like
 * tool names but aren't in the current tool registry: (a) backtick-quoted
 * tokens in always-injected workspace docs (NOW.md, SOUL.md, IDENTITY.md,
 * HEARTBEAT.md, VAL-CUSTOM-PATCHES.md), and (b) any snake_case token
 * (fenced or not -- tool descriptions rarely use backticks) inside each
 * skill's own TOOLS.json `description` fields and SKILL.md body.
 *
 * These are hand-edited free text with no type system, so nothing stops a
 * tool rename/removal from leaving a stale reference behind that the model
 * will dutifully try to call and fail on every single time. Two real
 * incidents this would have caught: `task_list_add` in NOW.md, and the same
 * dead tool name baked into schedule/TOOLS.json's own description fields
 * and schedule/SKILL.md's Tips section -- one file away from where the
 * first fix landed, because the first pass of this script only scanned
 * top-level workspace docs.
 *
 * This is a coarse heuristic, not a type-checker: it flags every
 * unrecognized token for a human to eyeball, on the assumption that a short
 * manual scan beats another multi-week silent failure. To keep noise down
 * without hand-listing every parameter name, each TOOLS.json's own object
 * keys and string values (its "schema vocabulary" -- param names, enum
 * values, meta fields) are auto-excluded, since those are legitimately
 * snake_case and not tool names.
 *
 * Usage:
 *   cd assistant && VELLUM_WORKSPACE_DIR=<path> bun run scripts/check-tool-references.ts
 *   (run manually after editing NOW.md/SOUL.md/a skill's TOOLS.json or
 *   SKILL.md, or after renaming/removing a tool; VELLUM_WORKSPACE_DIR
 *   defaults to this box's single local assistant instance)
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

const TOP_LEVEL_DOCS = [
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
  // Client capability tags (`assistant clients list --capability X`), not
  // tool names.
  "host_cu",
  "host_app_control",
  // Gmail search-query syntax token in an example string, not a param name.
  "newer_than",
  // app_open's own `open_mode` parameter -- not in this skill's own
  // TOOLS.json (app-builder's SKILL.md documents a different skill's tool).
  "open_mode",
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

const SNAKE_CASE = /^[a-z][a-z0-9]*(?:_[a-z0-9]+)+$/;

interface SkillManifest {
  dir: string;
  toolsJsonPath: string;
  skillMdPath: string | undefined;
  parsed: unknown;
}

function findSkillManifests(): SkillManifest[] {
  const manifests: SkillManifest[] = [];
  for (const skillsRoot of [BUNDLED_SKILLS, WORKSPACE_SKILLS]) {
    if (!existsSync(skillsRoot)) continue;
    for (const dir of readdirSync(skillsRoot, { withFileTypes: true })) {
      if (!dir.isDirectory()) continue;
      const toolsJsonPath = join(skillsRoot, dir.name, "TOOLS.json");
      if (!existsSync(toolsJsonPath)) continue;
      const skillMdCandidate = join(skillsRoot, dir.name, "SKILL.md");
      let parsed: unknown;
      try {
        parsed = JSON.parse(readFileSync(toolsJsonPath, "utf-8"));
      } catch (err) {
        console.error(`  ! failed to parse ${toolsJsonPath}: ${err}`);
        continue;
      }
      manifests.push({
        dir: join(skillsRoot, dir.name),
        toolsJsonPath,
        skillMdPath: existsSync(skillMdCandidate)
          ? skillMdCandidate
          : undefined,
        parsed,
      });
    }
  }
  return manifests;
}

function collectRegisteredToolNames(manifests: SkillManifest[]): Set<string> {
  const names = new Set<string>();
  for (const { parsed } of manifests) {
    const tools = Array.isArray(parsed)
      ? parsed
      : (parsed as { tools?: unknown[] })?.tools;
    for (const t of tools ?? []) {
      const name = (t as { name?: unknown })?.name;
      if (typeof name === "string") names.add(name);
    }
  }
  return names;
}

/** Recursively collect every object key and snake_case string value -- a
 * manifest's own "schema vocabulary" (param names, enum values, meta
 * fields), auto-excluded from the drift check instead of hand-listed. */
function collectSchemaVocabulary(value: unknown, into: Set<string>): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaVocabulary(item, into);
    return;
  }
  if (value !== null && typeof value === "object") {
    for (const [key, val] of Object.entries(value)) {
      into.add(key);
      collectSchemaVocabulary(val, into);
    }
    return;
  }
  if (typeof value === "string" && SNAKE_CASE.test(value)) {
    into.add(value);
  }
}

function extractBacktickTokens(content: string): string[] {
  const matches = content.matchAll(/`([a-z][a-z0-9_]*)`/g);
  return [...matches].map((m) => m[1]);
}

function extractAllSnakeCaseTokens(content: string): string[] {
  const matches = content.matchAll(/\b[a-z][a-z0-9]*(?:_[a-z0-9]+)+\b/g);
  return [...matches].map((m) => m[0]);
}

// SKILL.md is free-form prose describing enum values, state names, JSON
// payload fields, etc. -- scanning EVERY snake_case token there is too noisy
// to be useful (tested at 88 flags across bundled skills, almost all false
// positives). Both real incidents were "use/call X instead" redirect
// sentences, so scope SKILL.md to that specific, much higher-signal pattern
// instead (tested at ~35 raw matches, nearly all genuine tool names that the
// registry check then clears automatically).
function extractRedirectPhraseTokens(content: string): string[] {
  const matches = content.matchAll(
    /\b(?:use|call|invoke)s?\s+`?([a-z][a-z0-9]*(?:_[a-z0-9]+)+)`?/gi,
  );
  return [...matches].map((m) => m[1].toLowerCase());
}

function report(
  label: string,
  tokens: Set<string>,
  known: Set<string>,
): number {
  const unknown = [...tokens].filter((t) => !known.has(t));
  if (unknown.length === 0) return 0;
  console.log(`\n${label}`);
  for (const t of unknown.sort()) {
    console.log(
      `  ? \`${t}\` — not a registered tool. Verify: renamed/removed tool, native tool (check src/tools/), or add to KNOWN_NON_TOOLS if it's a param/skill-id.`,
    );
  }
  return unknown.length;
}

function main() {
  const manifests = findSkillManifests();
  const registeredTools = collectRegisteredToolNames(manifests);
  for (const t of KNOWN_NATIVE_TOOLS) registeredTools.add(t);
  console.log(
    `Registered skill + known-native tool names: ${registeredTools.size}`,
  );

  const knownForTopLevelDocs = new Set([
    ...registeredTools,
    ...KNOWN_NON_TOOLS,
  ]);

  let flaggedCount = 0;

  for (const docPath of TOP_LEVEL_DOCS) {
    if (!existsSync(docPath)) continue;
    const content = readFileSync(docPath, "utf-8");
    const tokens = new Set(
      extractBacktickTokens(content).filter((t) => t.includes("_")),
    );
    flaggedCount += report(docPath, tokens, knownForTopLevelDocs);
  }

  for (const { toolsJsonPath, skillMdPath, parsed } of manifests) {
    // Per-skill known set: global registry/allowlist + this manifest's own
    // schema vocabulary (so a param name declared in this TOOLS.json never
    // has to be hand-added to KNOWN_NON_TOOLS).
    const schemaVocab = new Set<string>();
    collectSchemaVocabulary(parsed, schemaVocab);
    const knownForSkill = new Set([
      ...registeredTools,
      ...KNOWN_NON_TOOLS,
      ...schemaVocab,
    ]);

    const toolsJsonContent = readFileSync(toolsJsonPath, "utf-8");
    const toolsJsonTokens = new Set(
      extractAllSnakeCaseTokens(toolsJsonContent),
    );
    flaggedCount += report(toolsJsonPath, toolsJsonTokens, knownForSkill);

    if (skillMdPath) {
      const skillMdContent = readFileSync(skillMdPath, "utf-8");
      const skillMdTokens = new Set(
        extractRedirectPhraseTokens(skillMdContent),
      );
      flaggedCount += report(skillMdPath, skillMdTokens, knownForSkill);
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
