import { AnySQLiteColumn, index, integer, real, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";
import { items, sources } from "./core";

/**
 * App-owned tables — goals/habits/journal/insights/reviews/decisions plus the
 * jobs queue, settings KV, sync_state and message_identity. From BUILD_SPEC §3.4.
 */

export const goals = sqliteTable("goals", {
  id: text("id").primaryKey(), // ULID
  title: text("title").notNull(),
  description: text("description"),
  category: text("category"),
  status: text("status").notNull().default("active"), // active|paused|completed|abandoned
  targetDate: integer("target_date", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const milestones = sqliteTable(
  "milestones",
  {
    id: text("id").primaryKey(), // ULID
    goalId: text("goal_id")
      .notNull()
      .references(() => goals.id, { onDelete: "cascade" }),
    title: text("title").notNull(),
    targetDate: integer("target_date", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    status: text("status").notNull().default("pending"), // pending|in_progress|done
    sortOrder: integer("sort_order").notNull().default(0),
  },
  (t) => ({
    milestonesGoalIdx: index("milestones_goal_idx").on(t.goalId),
  }),
);

export const habits = sqliteTable("habits", {
  id: text("id").primaryKey(), // ULID
  name: text("name").notNull(),
  cadence: text("cadence").notNull(), // daily|weekly|custom
  cadenceRule: text("cadence_rule"),
  targetCount: integer("target_count").notNull().default(1),
  unit: text("unit"),
  goalId: text("goal_id").references((): AnySQLiteColumn => goals.id),
  active: integer("active", { mode: "boolean" }).notNull().default(true),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});

export const habitLogs = sqliteTable(
  "habit_logs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    habitId: text("habit_id")
      .notNull()
      .references(() => habits.id, { onDelete: "cascade" }),
    loggedAt: integer("logged_at", { mode: "timestamp_ms" }).notNull(),
    count: integer("count").notNull().default(1),
    note: text("note"),
  },
  (t) => ({
    habitLogsHabitLoggedIdx: index("habit_logs_habit_logged_idx").on(t.habitId, t.loggedAt),
  }),
);

export const journalEntries = sqliteTable(
  "journal_entries",
  {
    id: text("id").primaryKey(), // ULID
    entryDate: integer("entry_date", { mode: "timestamp_ms" }).notNull(),
    prompt: text("prompt"),
    content: text("content"),
    mood: text("mood"),
    tags: text("tags", { mode: "json" }).$type<string[]>(),
    linkedItemIds: text("linked_item_ids", { mode: "json" }).$type<string[]>(),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    journalEntryDateIdx: index("journal_entry_date_idx").on(t.entryDate),
  }),
);

export const insights = sqliteTable(
  "insights",
  {
    id: text("id").primaryKey(), // ULID
    kind: text("kind").notNull(), // pattern|anomaly|connection|suggestion
    title: text("title").notNull(),
    body: text("body"),
    confidence: real("confidence"),
    relatedEntityIds: text("related_entity_ids", { mode: "json" }).$type<string[]>(),
    relatedItemIds: text("related_item_ids", { mode: "json" }).$type<string[]>(),
    status: text("status").notNull().default("new"), // new|seen|dismissed|acted
    generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    insightsStatusGeneratedIdx: index("insights_status_generated_idx").on(
      t.status,
      t.generatedAt,
    ),
  }),
);

export const reviews = sqliteTable(
  "reviews",
  {
    id: text("id").primaryKey(), // ULID
    periodType: text("period_type").notNull(), // weekly|monthly
    periodStart: integer("period_start", { mode: "timestamp_ms" }).notNull(),
    periodEnd: integer("period_end", { mode: "timestamp_ms" }).notNull(),
    summary: text("summary"),
    highlights: text("highlights", { mode: "json" }).$type<unknown[]>(),
    generatedAt: integer("generated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    reviewsPeriodUq: uniqueIndex("reviews_period_uq").on(t.periodType, t.periodStart),
  }),
);

export const decisions = sqliteTable("decisions", {
  id: text("id").primaryKey(), // ULID
  title: text("title").notNull(),
  description: text("description"),
  status: text("status").notNull().default("open"), // open|decided|revisited
  options: text("options", { mode: "json" }).$type<Record<string, unknown>[]>(),
  criteria: text("criteria", { mode: "json" }).$type<Record<string, unknown>[]>(),
  recommendation: text("recommendation"),
  confidence: real("confidence"),
  relatedEntityIds: text("related_entity_ids", { mode: "json" }).$type<string[]>(),
  relatedItemIds: text("related_item_ids", { mode: "json" }).$type<string[]>(),
  decidedAt: integer("decided_at", { mode: "timestamp_ms" }),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const jobs = sqliteTable(
  "jobs",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    // connector_sync|pipeline_chunk|pipeline_embed|pipeline_extract|
    // insight_generation|review_generation|maintenance_reembed|
    // maintenance_vacuum|maintenance_fts_rebuild
    type: text("type").notNull(),
    status: text("status").notNull().default("queued"), // queued|running|succeeded|failed
    payload: text("payload", { mode: "json" }).$type<Record<string, unknown>>(),
    priority: integer("priority").notNull().default(0),
    attempts: integer("attempts").notNull().default(0),
    maxAttempts: integer("max_attempts").notNull().default(3),
    runAt: integer("run_at", { mode: "timestamp_ms" }).notNull(),
    startedAt: integer("started_at", { mode: "timestamp_ms" }),
    finishedAt: integer("finished_at", { mode: "timestamp_ms" }),
    error: text("error"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    jobsStatusRunAtIdx: index("jobs_status_run_at_idx").on(t.status, t.runAt),
  }),
);

export const settings = sqliteTable("settings", {
  key: text("key").primaryKey(),
  value: text("value", { mode: "json" }).$type<unknown>(), // value is JSON
  updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
});

export const syncState = sqliteTable(
  "sync_state",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    resource: text("resource").notNull(), // mail|calendar|tasks|contacts|files|repo|channel|feed|...
    tap: text("tap").notNull(), // graph|imap|com|caldav|rss|api|filesystem
    direction: text("direction", { enum: ["backfill", "incremental"] })
      .notNull()
      .default("incremental"),
    cursorType: text("cursor_type"), // delta_link|uidvalidity_uid_modseq|watermark|page_token
    cursorValue: text("cursor_value"),
    status: text("status", {
      enum: ["ok", "stale", "auth_failed", "needs_consent", "tap_unavailable"],
    })
      .notNull()
      .default("ok"),
    statusReason: text("status_reason"),
    lastAttemptAt: integer("last_attempt_at", { mode: "timestamp_ms" }),
    lastSuccessAt: integer("last_success_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    syncStateResourceTapDirectionUq: uniqueIndex("sync_state_resource_tap_direction_uq").on(
      t.sourceId,
      t.resource,
      t.tap,
      t.direction,
    ),
  }),
);

export const messageIdentity = sqliteTable(
  "message_identity",
  {
    messageId: text("message_id").primaryKey(), // RFC 5322 Message-ID (or iCal UID)
    canonicalItemId: text("canonical_item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    contentHash: text("content_hash").notNull(),
    firstSeenTap: text("first_seen_tap").notNull(),
    firstSeenSourceId: text("first_seen_source_id").references(() => sources.id),
    seenTaps: text("seen_taps", { mode: "json" }).$type<string[]>().notNull().default([]),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    messageIdentityCanonicalIdx: index("message_identity_canonical_idx").on(t.canonicalItemId),
    messageIdentityContentHashIdx: index("message_identity_content_hash_idx").on(t.contentHash),
  }),
);
