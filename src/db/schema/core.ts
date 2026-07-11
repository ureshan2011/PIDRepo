import { index, integer, sqliteTable, text, uniqueIndex } from "drizzle-orm/sqlite-core";

/**
 * Core tables — the spine of the system: sources, items and their derived
 * chunks/embeddings. Transcribed from BUILD_SPEC §3.1.
 */

export const sources = sqliteTable(
  "sources",
  {
    id: text("id").primaryKey(), // ULID
    connectorId: text("connector_id").notNull(), // matches Connector.id
    accountId: text("account_id").notNull(),
    displayName: text("display_name").notNull(),
    // email|calendar|tasks|notes|documents|papers|cloud_storage|code|chat|
    // bookmarks|finance|health|travel|photos|contacts|feed|weather|ai_conversation|sample
    category: text("category").notNull(),
    config: text("config", { mode: "json" }).$type<Record<string, unknown>>(),
    enabled: integer("enabled", { mode: "boolean" }).notNull().default(true),
    // ok|stale|auth_failed|needs_consent|tap_unavailable
    status: text("status").notNull().default("ok"),
    statusReason: text("status_reason"),
    lastSyncAt: integer("last_sync_at", { mode: "timestamp_ms" }),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    sourcesConnectorAccountUq: uniqueIndex("sources_connector_account_uq").on(
      t.connectorId,
      t.accountId,
    ),
  }),
);

export const items = sqliteTable(
  "items",
  {
    id: text("id").primaryKey(), // ULID
    // event|email|task|note|document|paper|transaction|health_metric|trip|
    // contact|photo|bookmark|feed_item|ai_conversation
    type: text("type").notNull(),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    externalId: text("external_id").notNull(),
    title: text("title"),
    body: text("body"),
    bodyFormat: text("body_format").notNull().default("text"), // text|markdown|html
    url: text("url"),
    occurredAt: integer("occurred_at", { mode: "timestamp_ms" }),
    contentHash: text("content_hash"),
    metadata: text("metadata", { mode: "json" }).$type<Record<string, unknown>>(),
    isDeleted: integer("is_deleted", { mode: "boolean" }).notNull().default(false),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
    updatedAt: integer("updated_at", { mode: "timestamp_ms" }).notNull(),
    ingestedAt: integer("ingested_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    itemsSourceExternalUq: uniqueIndex("items_source_external_uq").on(t.sourceId, t.externalId),
    itemsTypeIdx: index("items_type_idx").on(t.type),
    itemsOccurredAtIdx: index("items_occurred_at_idx").on(t.occurredAt),
  }),
);

export const itemExternalIds = sqliteTable(
  "item_external_ids",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    sourceId: text("source_id")
      .notNull()
      .references(() => sources.id, { onDelete: "cascade" }),
    tap: text("tap").notNull(), // graph|imap|com|caldav|rss|manual|filesystem|api
    externalId: text("external_id").notNull(),
    rawIdentifiers: text("raw_identifiers", { mode: "json" }).$type<Record<string, unknown>>(),
    firstSeenAt: integer("first_seen_at", { mode: "timestamp_ms" }).notNull(),
    lastSeenAt: integer("last_seen_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    itemExtIdsSourceTapExternalUq: uniqueIndex("item_ext_ids_source_tap_external_uq").on(
      t.sourceId,
      t.tap,
      t.externalId,
    ),
    itemExtIdsItemIdx: index("item_ext_ids_item_idx").on(t.itemId),
  }),
);

export const chunks = sqliteTable(
  "chunks",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    itemId: text("item_id")
      .notNull()
      .references(() => items.id, { onDelete: "cascade" }),
    chunkIndex: integer("chunk_index").notNull(),
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    charStart: integer("char_start"),
    charEnd: integer("char_end"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    chunksItemChunkUq: uniqueIndex("chunks_item_chunk_uq").on(t.itemId, t.chunkIndex),
  }),
);

export const embeddingMeta = sqliteTable("embedding_meta", {
  chunkId: integer("chunk_id")
    .primaryKey()
    .references(() => chunks.id, { onDelete: "cascade" }),
  modelName: text("model_name").notNull(),
  dims: integer("dims").notNull(),
  createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
});
