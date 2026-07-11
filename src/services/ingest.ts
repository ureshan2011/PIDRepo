import { createHash } from "node:crypto";
import type { NormalizedItem } from "@/connectors/types";
import { sqlite } from "@/db/client";
import { newId } from "@/db/ids";

/**
 * Ingest service (BUILD_SPEC §5, MVP done #2/#6). Turns a batch of NormalizedItems
 * from a connector into rows across `items` + the matching domain table, keyed for
 * idempotency:
 *   - `items` upsert via ON CONFLICT (source_id, external_id) DO UPDATE — re-syncing
 *     the same external id updates in place, never duplicates (crash-safe).
 *   - the matching domain-table row upsert keyed on item_id.
 *   - `item_external_ids` upsert keyed on (source_id, tap, external_id).
 * The whole batch runs in ONE better-sqlite3 transaction so it commits atomically;
 * the caller advances the sync cursor only AFTER this returns (post-commit).
 *
 * Returns the item ids that are NEW or whose content_hash CHANGED (excluding
 * deletes), so the caller can enqueue `pipeline_chunk` jobs only for real work.
 *
 * Uses the raw better-sqlite3 handle (not Drizzle) for precise ON CONFLICT / RETURNING
 * control and to treat epoch-ms timestamps as plain integers.
 */

export interface CommitResult {
  /** Number of items processed in the batch. */
  committed: number;
  /** Item ids that are new or content-changed (non-deleted) — enqueue chunking. */
  changedItemIds: string[];
}

/** items.type -> its 1:1 domain table (child-bearing types handled specially). */
const DOMAIN_TABLE: Record<string, string | undefined> = {
  event: "events",
  email: "emails",
  task: "tasks",
  note: "notes",
  document: "documents",
  paper: "papers",
  transaction: "transactions",
  health_metric: "health_metrics",
  contact: "contacts",
  photo: "photos_index",
  bookmark: "bookmarks",
  // trip / ai_conversation / feed_item handled explicitly (child rows / parent FK).
};

type SqlValue = number | bigint | string | Uint8Array | null;

function toBind(v: unknown): SqlValue {
  if (v === null || v === undefined) return null;
  if (typeof v === "boolean") return v ? 1 : 0;
  if (v instanceof Date) return v.getTime();
  if (typeof v === "number" || typeof v === "bigint" || typeof v === "string") return v;
  if (v instanceof Uint8Array) return v;
  return JSON.stringify(v); // arrays / objects -> JSON text
}

/** Normalized content hash over title+body for change detection (§3.1 items.content_hash). */
function contentHashOf(title?: string, body?: string): string {
  const norm = `${title ?? ""}\n${body ?? ""}`.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex");
}

/** Generic upsert: INSERT ... ON CONFLICT(keys) DO UPDATE SET <non-key cols>. */
function upsertRow(table: string, conflictCols: string[], record: Record<string, unknown>): void {
  const cols = Object.keys(record);
  const colList = cols.map((c) => `"${c}"`).join(", ");
  const placeholders = cols.map(() => "?").join(", ");
  const updateCols = cols.filter((c) => !conflictCols.includes(c));
  const conflictList = conflictCols.map((c) => `"${c}"`).join(", ");
  const action = updateCols.length
    ? `DO UPDATE SET ${updateCols.map((c) => `"${c}" = excluded."${c}"`).join(", ")}`
    : "DO NOTHING";
  const sql = `INSERT INTO "${table}" (${colList}) VALUES (${placeholders}) ON CONFLICT(${conflictList}) ${action}`;
  sqlite.prepare(sql).run(...cols.map((c) => toBind(record[c])));
}

const ITEM_COLS = [
  "id",
  "type",
  "source_id",
  "external_id",
  "title",
  "body",
  "body_format",
  "url",
  "occurred_at",
  "content_hash",
  "metadata",
  "is_deleted",
  "created_at",
  "updated_at",
  "ingested_at",
] as const;

// On conflict we keep id / source_id / external_id / created_at; update the rest.
const ITEM_UPDATE_COLS = ITEM_COLS.filter(
  (c) => !["id", "source_id", "external_id", "created_at"].includes(c),
);

const upsertItemSql = `INSERT INTO items (${ITEM_COLS.map((c) => `"${c}"`).join(", ")})
  VALUES (${ITEM_COLS.map(() => "?").join(", ")})
  ON CONFLICT(source_id, external_id) DO UPDATE SET
    ${ITEM_UPDATE_COLS.map((c) => `"${c}" = excluded."${c}"`).join(", ")}
  RETURNING id`;

function ensureFeed(feedId: string, sourceId: string): void {
  // Defensive: the seed normally creates the real feeds row; this guarantees the
  // FK target exists even if a feed_item arrives first. OR IGNORE never clobbers.
  sqlite
    .prepare(
      `INSERT OR IGNORE INTO feeds (id, source_id, url, poll_interval_minutes)
       VALUES (?, ?, ?, 60)`,
    )
    .run(feedId, sourceId, `https://example.invalid/feed/${feedId}`);
}

function commitDomain(itemId: string, sourceId: string, it: NormalizedItem): void {
  const df: Record<string, unknown> = { ...(it.domainFields ?? {}) };

  switch (it.type) {
    case "trip": {
      const segments = df._segments;
      delete df._segments;
      upsertRow("trips", ["item_id"], { item_id: itemId, ...df });
      sqlite.prepare(`DELETE FROM trip_segments WHERE trip_item_id = ?`).run(itemId);
      if (Array.isArray(segments)) {
        const ins = sqlite.prepare(
          `INSERT INTO trip_segments
             (trip_item_id, segment_type, start_at, end_at, confirmation_code, details)
           VALUES (?, ?, ?, ?, ?, ?)`,
        );
        for (const s of segments as Record<string, unknown>[]) {
          ins.run(
            itemId,
            toBind(s.segment_type),
            toBind(s.start_at),
            toBind(s.end_at),
            toBind(s.confirmation_code),
            toBind(s.details),
          );
        }
      }
      return;
    }
    case "ai_conversation": {
      const messages = df._messages;
      delete df._messages;
      upsertRow("ai_conversations", ["item_id"], { item_id: itemId, ...df });
      sqlite
        .prepare(`DELETE FROM ai_conversation_messages WHERE conversation_item_id = ?`)
        .run(itemId);
      if (Array.isArray(messages)) {
        const ins = sqlite.prepare(
          `INSERT INTO ai_conversation_messages
             (conversation_item_id, role, content, token_count, created_at)
           VALUES (?, ?, ?, ?, ?)`,
        );
        for (const m of messages as Record<string, unknown>[]) {
          ins.run(
            itemId,
            toBind(m.role),
            toBind(m.content),
            toBind(m.token_count),
            toBind(m.created_at ?? Date.now()),
          );
        }
      }
      return;
    }
    case "feed_item": {
      const feedId = df.feed_id;
      if (typeof feedId === "string") ensureFeed(feedId, sourceId);
      upsertRow("feed_items", ["item_id"], { item_id: itemId, ...df });
      return;
    }
    default: {
      const table = DOMAIN_TABLE[it.type];
      if (table) upsertRow(table, ["item_id"], { item_id: itemId, ...df });
    }
  }
}

/**
 * Commit a batch of NormalizedItems for a source. Atomic (single transaction).
 * Idempotent — re-committing the same items updates in place without duplicating.
 */
export function commitBatch(sourceId: string, items: NormalizedItem[]): CommitResult {
  const upsertItem = sqlite.prepare(upsertItemSql);
  const selectPrior = sqlite.prepare<[string, string], { id: string; content_hash: string | null }>(
    `SELECT id, content_hash FROM items WHERE source_id = ? AND external_id = ?`,
  );
  const upsertExt = sqlite.prepare(
    `INSERT INTO item_external_ids
       (item_id, source_id, tap, external_id, raw_identifiers, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, NULL, ?, ?)
     ON CONFLICT(source_id, tap, external_id) DO UPDATE SET
       item_id = excluded.item_id, last_seen_at = excluded.last_seen_at`,
  );

  const run = sqlite.transaction((batch: NormalizedItem[]): string[] => {
    const changed: string[] = [];
    for (const it of batch) {
      const now = Date.now();
      const hash = it.contentHash ?? contentHashOf(it.title, it.body);
      const isDeleted = it.isDeleted ? 1 : 0;

      const prior = selectPrior.get(sourceId, it.externalId);
      const generatedId = newId();

      const row = upsertItem.get(
        generatedId,
        it.type,
        sourceId,
        it.externalId,
        it.title ?? null,
        it.body ?? null,
        it.bodyFormat ?? "text",
        it.url ?? null,
        it.occurredAt ?? null,
        hash,
        it.metadata ? JSON.stringify(it.metadata) : null,
        isDeleted,
        now, // created_at (ignored on conflict)
        now, // updated_at
        now, // ingested_at
      ) as { id: string };
      const itemId = row.id;

      upsertExt.run(itemId, sourceId, it.tap, it.externalId, now, now);
      commitDomain(itemId, sourceId, it);

      const isChanged = !prior || prior.content_hash !== hash;
      if (isChanged && !it.isDeleted) changed.push(itemId);
    }
    return changed;
  });

  const changedItemIds = run(items);
  return { committed: items.length, changedItemIds };
}
