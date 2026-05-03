import type { InterfaceId } from "../channels/types.js";
import { getConfig } from "../config/loader.js";
import { PROVIDER_CATALOG } from "../providers/model-catalog.js";
import { getConfiguredProviders } from "../providers/provider-availability.js";
import {
  getConversationOverrideProfile,
  setConversationInferenceProfile,
} from "../memory/conversation-crud.js";
import {
  getUsageGroupBreakdown,
  getUsageTotals,
  type UsageTimeRange,
} from "../memory/llm-usage-store.js";

export type SlashResolution =
  | { kind: "passthrough"; content: string }
  | { kind: "unknown"; message: string }
  | { kind: "compact" };

// ── /status command ──────────────────────────────────────────────────

export interface SlashContext {
  messageCount: number;
  inputTokens: number;
  outputTokens: number;
  maxInputTokens: number;
  model: string;
  provider: string;
  estimatedCost: number;
  userMessageInterface?: InterfaceId;
  conversationId?: string;
}

// ── Deprecated model-switching shortcuts ─────────────────────────────

/**
 * Former provider shortcut commands that switched models. These are now
 * removed — model switching lives in Settings. We reject them explicitly
 * so they don't fall through to the LLM as passthrough text.
 */
const DEPRECATED_MODEL_SHORTCUTS = new Set([
  "opus",
  "sonnet",
  "haiku",
  "grok-beta",
  "grok-multi",
]);

// ── /models command ──────────────────────────────────────────────────

async function resolveModelList(): Promise<SlashResolution> {
  const config = getConfig();
  const configuredProviders = new Set<string>(await getConfiguredProviders());

  const lines = ["Available models:\n"];

  for (const {
    id: provider,
    displayName: providerName,
    models,
  } of PROVIDER_CATALOG) {
    const hasKey = configuredProviders.has(provider);
    const status = hasKey ? "✓" : "✗";
    lines.push(`**${providerName}** ${status}`);
    for (const { id, displayName } of models) {
      const isCurrent =
        config.llm.default.provider === provider &&
        config.llm.default.model === id;
      const current = isCurrent ? " **[current]**" : "";
      lines.push(`  - ${displayName} (\`${id}\`)${current}`);
    }
    lines.push("");
  }

  lines.push("✓ = API key configured, ✗ = not configured");
  lines.push("\nTip: Configure a provider with `keys set <provider> <key>`");

  return {
    kind: "unknown",
    message: lines.join("\n"),
  };
}

function resolveStatusCommand(context: SlashContext): SlashResolution {
  const {
    inputTokens,
    maxInputTokens,
    model,
    provider,
    messageCount,
    outputTokens,
    estimatedCost,
  } = context;
  const pct =
    maxInputTokens > 0
      ? Math.min(Math.round((inputTokens / maxInputTokens) * 100), 100)
      : 0;
  const filled = Math.round(pct / 5);
  const bar = "█".repeat(filled) + "░".repeat(20 - filled);
  const fmt = (n: number) => n.toLocaleString("en-US");

  const lines = [
    "Conversation Status\n",
    `Context:  ${bar}  ${pct}%  (${fmt(inputTokens)} / ${fmt(
      maxInputTokens,
    )} tokens)`,
    `Model:    ${model} (${provider})`,
    `Messages: ${fmt(messageCount)}`,
    `Tokens:   ${fmt(inputTokens)} in / ${fmt(outputTokens)} out`,
    `Cost:     $${estimatedCost.toFixed(2)} (estimated)`,
  ];

  return { kind: "unknown", message: lines.join("\n") };
}

function resolveCommandsList(context?: SlashContext): string[] {
  const fallbackLines = [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
    "/models — List all available models",
    "/profiles — List available inference profiles",
    "/profile — Show or switch the current inference profile",
    "/usage — Show LLM usage and cost breakdown",
  ];
  if (context) {
    fallbackLines.push("/status — Show conversation status and context usage");
  }

  if (!context?.userMessageInterface) return fallbackLines;

  if (context.userMessageInterface === "macos") {
    return [
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ];
  }

  if (context.userMessageInterface === "ios") {
    return [
      "/commands — List all available commands",
      "/compact — Force context compaction immediately",
      "/models — List all available models",
      "/status — Show conversation status and context usage",
      "/btw — Ask a side question while the assistant is working",
      "/fork — Fork the current conversation into a new branch",
    ];
  }

  return [
    "/commands — List all available commands",
    "/compact — Force context compaction immediately",
    "/models — List all available models",
    "/status — Show conversation status and context usage",
    "/btw — Ask a side question while the assistant is working",
  ];
}

/**
 * Pure classifier: returns the kind of slash resolution `resolveSlash` would
 * produce for `content`, without triggering any side effects.
 *
 * Queue-drain lookahead (`buildPassthroughBatch`) uses this to decide whether
 * to include a queued message in a contiguous passthrough batch. `resolveSlash`
 * itself may run side effects, so calling it during lookahead and then again
 * in the real drain would execute those side effects twice.
 */
export function classifySlash(
  content: string,
): "passthrough" | "compact" | "unknown" {
  const trimmed = content.trim();
  if (
    trimmed === "/model" ||
    (trimmed.startsWith("/model ") && trimmed !== "/models")
  ) {
    return "unknown";
  }
  const shortcutMatch = trimmed.match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (
    shortcutMatch &&
    DEPRECATED_MODEL_SHORTCUTS.has(shortcutMatch[1].toLowerCase())
  ) {
    return "unknown";
  }
  if (trimmed === "/models") return "unknown";
  if (trimmed === "/compact") return "compact";
  if (trimmed === "/status") return "unknown";
  if (trimmed === "/commands") return "unknown";
  if (trimmed === "/profile" || trimmed.startsWith("/profile "))
    return "unknown";
  if (trimmed === "/profiles") return "unknown";
  if (trimmed === "/usage") return "unknown";
  return "passthrough";
}

// ── Profile descriptions ───────────────────────────────────────────

const PROFILE_DESCRIPTIONS: Record<string, string> = {
  standard: "Gemini 2.5 Flash-Lite — fast, cheap, great for everyday tasks",
  balanced: "Claude Haiku — warm, conversational, human-like responses",
  quality: "Claude Sonnet — deep reasoning, coaching, complex tasks",
  "cost-optimized": "Gemini 2.5 Flash-Lite (low effort) — background tasks",
  analytics: "DeepSeek V3 — structured data analysis",
  "deep-analysis": "DeepSeek R1 — step-by-step reasoning with thinking",
};

function resolveProfileCommand(
  trimmed: string,
  context?: SlashContext,
): SlashResolution {
  if (!context?.conversationId) {
    return {
      kind: "unknown",
      message: "Profile switching is not available in this context.",
    };
  }

  // /profiles — list all profiles (checked before extracting rest)
  if (trimmed === "/profiles") {
    const profiles = getConfig().llm?.profiles ?? {};
    const current = getConversationOverrideProfile(context.conversationId);
    const lines = ["Available inference profiles:\n"];
    for (const name of Object.keys(profiles)) {
      const desc = PROFILE_DESCRIPTIONS[name] ?? "Custom profile";
      const marker = current === name ? " **[current]**" : "";
      lines.push(`- **${name}**${marker} — ${desc}`);
    }
    if (!current) {
      const active = getConfig().llm?.activeProfile ?? "default";
      lines.push(`\nCurrent: **${active}** (workspace default)`);
    }
    lines.push("\nSwitch with `/profile <name>`");
    return { kind: "unknown", message: lines.join("\n") };
  }

  const rest = trimmed.slice("/profile".length).trim();

  // /profile — show current
  if (rest === "") {
    const current = getConversationOverrideProfile(context.conversationId);
    const active = getConfig().llm?.activeProfile ?? "default";
    const profiles = getConfig().llm?.profiles ?? {};
    if (current && profiles[current]) {
      const desc = PROFILE_DESCRIPTIONS[current] ?? "";
      return {
        kind: "unknown",
        message: `Current profile: **${current}** — ${desc}

Switch with \`/profile <name>\`. See all with \`/profiles\`.`,
      };
    }
    const desc = PROFILE_DESCRIPTIONS[active] ?? "";
    return {
      kind: "unknown",
      message: `Current profile: **${active}** (workspace default) — ${desc}

Switch with \`/profile <name>\`. See all with \`/profiles\`.`,
    };
  }

  // /profile <name> — switch
  const profiles = getConfig().llm?.profiles ?? {};
  if (!Object.prototype.hasOwnProperty.call(profiles, rest)) {
    const available = Object.keys(profiles).join(", ");
    return {
      kind: "unknown",
      message: `Unknown profile "${rest}". Available: ${available}`,
    };
  }

  setConversationInferenceProfile(context.conversationId, rest);
  const desc = PROFILE_DESCRIPTIONS[rest] ?? "";
  return {
    kind: "unknown",
    message: `Switched to **${rest}** — ${desc}

This conversation will now use this profile for the main agent. Background tasks continue using their dedicated profiles.`,
  };
}

// ── /usage command ─────────────────────────────────────────────────

function startOfDayUtc(ts: number): number {
  const d = new Date(ts);
  return Date.UTC(d.getUTCFullYear(), d.getUTCMonth(), d.getUTCDate());
}

function fmtCost(n: number): string {
  if (n < 0.01) return `$${(n * 100).toFixed(2)}\u00a2`;
  return `$${n.toFixed(2)}`;
}

function fmtTokens(n: number): string {
  return n.toLocaleString("en-US");
}

function resolveUsageCommand(): SlashResolution {
  const now = Date.now();
  const todayStart = startOfDayUtc(now);
  const dayAgo = now - 24 * 60 * 60 * 1000;

  const todayRange: UsageTimeRange = { from: todayStart, to: now };
  const dayRange: UsageTimeRange = { from: dayAgo, to: now };

  const today = getUsageTotals(todayRange);
  const last24h = getUsageTotals(dayRange);

  const providerBreakdown = getUsageGroupBreakdown(todayRange, "provider");
  const modelBreakdown = getUsageGroupBreakdown(todayRange, "model");

  const lines: string[] = [
    "LLM Usage\n",
    `Today (UTC):   ${fmtTokens(today.totalInputTokens)} in / ${fmtTokens(today.totalOutputTokens)} out  —  ${fmtCost(today.totalEstimatedCostUsd)}`,
    `Last 24h:      ${fmtTokens(last24h.totalInputTokens)} in / ${fmtTokens(last24h.totalOutputTokens)} out  —  ${fmtCost(last24h.totalEstimatedCostUsd)}`,
    `LLM calls:     ${today.eventCount.toLocaleString("en-US")}`,
  ];

  if (providerBreakdown.length > 0) {
    lines.push("\nBy Provider:");
    for (const row of providerBreakdown.slice(0, 8)) {
      lines.push(
        `  ${row.group.padEnd(14)} ${fmtTokens(row.totalInputTokens)} in / ${fmtTokens(row.totalOutputTokens)} out  —  ${fmtCost(row.totalEstimatedCostUsd)}`,
      );
    }
  }

  if (modelBreakdown.length > 0) {
    lines.push("\nBy Model:");
    for (const row of modelBreakdown.slice(0, 8)) {
      lines.push(
        `  ${row.group.padEnd(30)} ${fmtTokens(row.totalInputTokens)} in / ${fmtTokens(row.totalOutputTokens)} out  —  ${fmtCost(row.totalEstimatedCostUsd)}`,
      );
    }
  }

  return { kind: "unknown", message: lines.join("\n") };
}
/**
 * Resolve built-in slash commands (/models, /status, /commands, /compact).
 * Returns `unknown` with a deterministic message, `compact` for forced compaction,
 * or the (possibly rewritten) content as `passthrough`.
 */
export async function resolveSlash(
  content: string,
  context?: SlashContext,
): Promise<SlashResolution> {
  // Handle deprecated model-switching commands — direct users to Settings
  const trimmed = content.trim();
  if (
    trimmed === "/model" ||
    (trimmed.startsWith("/model ") && trimmed !== "/models")
  ) {
    return {
      kind: "unknown",
      message:
        "The `/model` command has been removed. Use **Settings → Models & Services** to change your model and provider.",
    };
  }

  // Reject deprecated provider shortcut commands (/opus, /sonnet, /haiku, etc.)
  const shortcutMatch = trimmed.match(/^\/([a-z0-9-]+)(\s|$)/i);
  if (
    shortcutMatch &&
    DEPRECATED_MODEL_SHORTCUTS.has(shortcutMatch[1].toLowerCase())
  ) {
    return {
      kind: "unknown",
      message: `The \`/${shortcutMatch[1]}\` shortcut has been removed. Use **Settings → Models & Services** to change your model and provider.`,
    };
  }

  // Handle /models command (read-only listing)
  if (trimmed === "/models") {
    return await resolveModelList();
  }

  // Handle /compact command
  if (trimmed === "/compact") {
    return { kind: "compact" };
  }

  // Handle /profile and /profiles commands
  if (
    trimmed === "/profile" ||
    trimmed.startsWith("/profile ") ||
    trimmed === "/profiles"
  ) {
    return resolveProfileCommand(trimmed, context);
  }

  // Handle /usage command
  if (trimmed === "/usage") {
    return resolveUsageCommand();
  }

  // Handle /status command
  if (trimmed === "/status") {
    if (!context) {
      return {
        kind: "unknown",
        message: "Status information is not available in this context.",
      };
    }
    return resolveStatusCommand(context);
  }

  // Handle /commands command
  if (trimmed === "/commands") {
    return {
      kind: "unknown",
      message: resolveCommandsList(context).join("\n"),
    };
  }

  return { kind: "passthrough", content };
}

// ── Provider Ordering Error Detection ────────────────────────────────

const ORDERING_ERROR_PATTERNS = [
  /tool_result.*not immediately after.*tool_use/i,
  /tool_use.*must have.*tool_result/i,
  /tool_use_id.*without.*tool_result/i,
  /tool_result.*tool_use_id.*not found/i,
  /messages.*invalid.*order/i,
];

export function isProviderOrderingError(message: string): boolean {
  return ORDERING_ERROR_PATTERNS.some((pattern) => pattern.test(message));
}
