import { AnySQLiteColumn, index, integer, real, sqliteTable, text } from "drizzle-orm/sqlite-core";
import { items, sources } from "./core";
import { entities } from "./graph";

/**
 * Domain tables — 1:1 extensions of `items` (PK == item_id, CASCADE from items),
 * plus a few registry tables with their own PKs (trip_segments, feeds, feed_items,
 * ai_conversation_messages). Transcribed from BUILD_SPEC §3.3.
 */

const itemPk = () =>
  text("item_id")
    .primaryKey()
    .references((): AnySQLiteColumn => items.id, { onDelete: "cascade" });

export const events = sqliteTable(
  "events",
  {
    itemId: itemPk(),
    startAt: integer("start_at", { mode: "timestamp_ms" }).notNull(),
    endAt: integer("end_at", { mode: "timestamp_ms" }),
    allDay: integer("all_day", { mode: "boolean" }).notNull().default(false),
    location: text("location"),
    organizerEmail: text("organizer_email"),
    attendees: text("attendees", { mode: "json" }).$type<unknown[]>(),
    status: text("status"),
    responseStatus: text("response_status"),
    recurrenceRule: text("recurrence_rule"),
    recurrenceMasterItemId: text("recurrence_master_item_id").references(
      (): AnySQLiteColumn => items.id,
    ),
    calendarUid: text("calendar_uid"),
  },
  (t) => ({
    eventsStartAtIdx: index("events_start_at_idx").on(t.startAt),
    eventsMasterIdx: index("events_master_idx").on(t.recurrenceMasterItemId),
  }),
);

export const emails = sqliteTable(
  "emails",
  {
    itemId: itemPk(),
    messageId: text("message_id").notNull(),
    threadId: text("thread_id"),
    fromAddress: text("from_address"),
    fromName: text("from_name"),
    toAddresses: text("to_addresses", { mode: "json" }).$type<string[]>(),
    ccAddresses: text("cc_addresses", { mode: "json" }).$type<string[]>(),
    folder: text("folder"),
    isRead: integer("is_read", { mode: "boolean" }).notNull().default(false),
    hasAttachments: integer("has_attachments", { mode: "boolean" }).notNull().default(false),
    importance: text("importance"),
  },
  (t) => ({
    emailsMessageIdIdx: index("emails_message_id_idx").on(t.messageId),
    emailsThreadIdIdx: index("emails_thread_id_idx").on(t.threadId),
  }),
);

export const tasks = sqliteTable(
  "tasks",
  {
    itemId: itemPk(),
    status: text("status").notNull().default("open"), // open|in_progress|done|cancelled
    priority: text("priority"), // low|medium|high
    dueAt: integer("due_at", { mode: "timestamp_ms" }),
    completedAt: integer("completed_at", { mode: "timestamp_ms" }),
    project: text("project"),
    recurrenceRule: text("recurrence_rule"),
  },
  (t) => ({
    tasksDueStatusIdx: index("tasks_due_status_idx").on(t.dueAt, t.status),
  }),
);

export const notes = sqliteTable("notes", {
  itemId: itemPk(),
  notebook: text("notebook"),
  tags: text("tags", { mode: "json" }).$type<string[]>(),
  pinned: integer("pinned", { mode: "boolean" }).notNull().default(false),
});

export const documents = sqliteTable("documents", {
  itemId: itemPk(),
  filePath: text("file_path"),
  mimeType: text("mime_type"),
  fileSizeBytes: integer("file_size_bytes"),
  pageCount: integer("page_count"),
  checksum: text("checksum"),
});

export const papers = sqliteTable(
  "papers",
  {
    itemId: itemPk(),
    authors: text("authors", { mode: "json" }).$type<string[]>(),
    venue: text("venue"),
    year: integer("year"),
    doi: text("doi"),
    arxivId: text("arxiv_id"),
    citationCount: integer("citation_count"),
    abstract: text("abstract"),
  },
  (t) => ({
    papersDoiIdx: index("papers_doi_idx").on(t.doi),
  }),
);

export const transactions = sqliteTable(
  "transactions",
  {
    itemId: itemPk(),
    amountCents: integer("amount_cents").notNull(),
    currency: text("currency").notNull().default("USD"),
    account: text("account"),
    category: text("category"),
    merchant: text("merchant"),
    transactionDate: integer("transaction_date", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    transactionsDateIdx: index("transactions_date_idx").on(t.transactionDate),
    transactionsCategoryIdx: index("transactions_category_idx").on(t.category),
  }),
);

export const healthMetrics = sqliteTable(
  "health_metrics",
  {
    itemId: itemPk(),
    metricType: text("metric_type").notNull(),
    value: real("value").notNull(),
    unit: text("unit"),
    recordedAt: integer("recorded_at", { mode: "timestamp_ms" }).notNull(),
    sourceDevice: text("source_device"),
  },
  (t) => ({
    healthMetricsTypeRecordedIdx: index("health_metrics_type_recorded_idx").on(
      t.metricType,
      t.recordedAt,
    ),
  }),
);

export const trips = sqliteTable("trips", {
  itemId: itemPk(),
  destination: text("destination"),
  startDate: integer("start_date", { mode: "timestamp_ms" }),
  endDate: integer("end_date", { mode: "timestamp_ms" }),
  status: text("status"), // planned|booked|in_progress|completed|cancelled
});

export const tripSegments = sqliteTable(
  "trip_segments",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    tripItemId: text("trip_item_id")
      .notNull()
      .references(() => trips.itemId, { onDelete: "cascade" }),
    segmentType: text("segment_type").notNull(), // flight|hotel|car|train|other
    startAt: integer("start_at", { mode: "timestamp_ms" }),
    endAt: integer("end_at", { mode: "timestamp_ms" }),
    confirmationCode: text("confirmation_code"),
    details: text("details", { mode: "json" }).$type<Record<string, unknown>>(),
  },
  (t) => ({
    tripSegmentsTripIdx: index("trip_segments_trip_idx").on(t.tripItemId),
  }),
);

export const contacts = sqliteTable("contacts", {
  itemId: itemPk(),
  displayName: text("display_name").notNull(),
  emails: text("emails", { mode: "json" }).$type<string[]>(),
  phones: text("phones", { mode: "json" }).$type<string[]>(),
  company: text("company"),
  entityId: text("entity_id").references(() => entities.id),
});

export const photosIndex = sqliteTable(
  "photos_index",
  {
    itemId: itemPk(),
    filePath: text("file_path").notNull(),
    takenAt: integer("taken_at", { mode: "timestamp_ms" }),
    gpsLat: real("gps_lat"),
    gpsLon: real("gps_lon"),
    cameraModel: text("camera_model"),
    width: integer("width"),
    height: integer("height"),
    perceptualHash: text("perceptual_hash"),
  },
  (t) => ({
    photosTakenAtIdx: index("photos_taken_at_idx").on(t.takenAt),
  }),
);

export const bookmarks = sqliteTable("bookmarks", {
  itemId: itemPk(),
  url: text("url").notNull(),
  folderPath: text("folder_path"),
  faviconUrl: text("favicon_url"),
});

export const feeds = sqliteTable("feeds", {
  id: text("id").primaryKey(), // ULID
  sourceId: text("source_id")
    .notNull()
    .references(() => sources.id, { onDelete: "cascade" }),
  url: text("url").notNull(),
  title: text("title"),
  siteUrl: text("site_url"),
  etag: text("etag"),
  lastModified: text("last_modified"),
  pollIntervalMinutes: integer("poll_interval_minutes").notNull().default(60),
  lastPolledAt: integer("last_polled_at", { mode: "timestamp_ms" }),
});

export const feedItems = sqliteTable(
  "feed_items",
  {
    itemId: itemPk(),
    feedId: text("feed_id")
      .notNull()
      .references(() => feeds.id, { onDelete: "cascade" }),
    url: text("url"),
    publishedAt: integer("published_at", { mode: "timestamp_ms" }),
    author: text("author"),
  },
  (t) => ({
    feedItemsFeedIdx: index("feed_items_feed_idx").on(t.feedId),
  }),
);

export const aiConversations = sqliteTable("ai_conversations", {
  itemId: itemPk(),
  modelName: text("model_name"),
  startedAt: integer("started_at", { mode: "timestamp_ms" }),
  endedAt: integer("ended_at", { mode: "timestamp_ms" }),
  messageCount: integer("message_count").notNull().default(0),
});

export const aiConversationMessages = sqliteTable(
  "ai_conversation_messages",
  {
    id: integer("id").primaryKey({ autoIncrement: true }),
    conversationItemId: text("conversation_item_id")
      .notNull()
      .references(() => aiConversations.itemId, { onDelete: "cascade" }),
    role: text("role").notNull(), // user|assistant|system|tool
    content: text("content").notNull(),
    tokenCount: integer("token_count"),
    createdAt: integer("created_at", { mode: "timestamp_ms" }).notNull(),
  },
  (t) => ({
    aiConvMessagesConvIdx: index("ai_conv_messages_conv_idx").on(t.conversationItemId),
  }),
);
