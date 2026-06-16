import type { DrizzleDb } from "../db-connection.js";
import { getSqliteFrom } from "../db-connection.js";
import { tableHasColumn } from "./schema-introspection.js";

/**
 * Add cache_creation_5m_tokens and cache_creation_1h_tokens columns to
 * llm_usage_events so each row can record the Anthropic prompt-cache write
 * breakdown by TTL tier (5-minute writes bill at 1.25x base, 1-hour writes at
 * 2x base). The single cache_creation_input_tokens counter cannot distinguish
 * the two tiers, so the pricing layer assumes 100% 5m when no breakdown is
 * present, underpricing 1h writes.
 *
 * Both columns are nullable INTEGER — existing rows default to NULL, which the
 * pricing/aggregation layer treats as "no explicit breakdown available" and
 * falls back to the cache_creation_input_tokens total. Additive and
 * idempotent (guarded by tableHasColumn), so safe to re-run on every startup;
 * per the migration registry convention, pure ALTER TABLE ADD COLUMN
 * migrations do not need a checkpoint entry.
 */
export function migrateUsageCacheCreationTtlSplit(database: DrizzleDb): void {
  const raw = getSqliteFrom(database);
  if (
    !tableHasColumn(database, "llm_usage_events", "cache_creation_5m_tokens")
  ) {
    raw.exec(
      /*sql*/ `ALTER TABLE llm_usage_events ADD COLUMN cache_creation_5m_tokens INTEGER`,
    );
  }
  if (
    !tableHasColumn(database, "llm_usage_events", "cache_creation_1h_tokens")
  ) {
    raw.exec(
      /*sql*/ `ALTER TABLE llm_usage_events ADD COLUMN cache_creation_1h_tokens INTEGER`,
    );
  }
}
