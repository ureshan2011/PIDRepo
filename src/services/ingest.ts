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

/** message_identity row shape (subset) for the canonical dedupe lookup. */
interface MessageIdentityRow {
  canonical_item_id: string;
  seen_taps: string | null;
}

/**
 * Extract `raw_identifiers` (JSON, per item_external_ids.raw_identifiers) for the
 * canonical path. The shim connector places the collector's raw tap identifiers on
 * `metadata.rawIdentifiers` (docs/15 §5.4); it may already be a JSON string or a
 * structured object — `toBind` normalizes both to TEXT.
 */
function rawIdentifiersOf(it: NormalizedItem): SqlValue {
  const raw = it.metadata?.rawIdentifiers;
  return raw === undefined || raw === null ? null : toBind(raw);
}

/**
 * Commit a batch of NormalizedItems for a source. Atomic (single transaction).
 * Idempotent — re-committing the same items updates in place without duplicating.
 *
 * Two dedupe strategies, chosen purely by whether `NormalizedItem.canonicalKey`
 * is present (the connector-sync handler needs NO connector-specific branching):
 *   - canonicalKey ABSENT: the plain (source_id, external_id) upsert (unchanged;
 *     what the sample connector relies on).
 *   - canonicalKey PRESENT: the cross-tap dedupe algorithm from docs/15 §4.2 —
 *     the same physical message seen via two taps collapses to ONE `items` row,
 *     keyed on `message_identity.message_id == canonicalKey`.
 */
export function commitBatch(sourceId: string, items: NormalizedItem[]): CommitResult {
  const upsertItem = sqlite.prepare(upsertItemSql);
  const selectPrior = sqlite.prepare<[string, string], { id: string; content_hash: string | null }>(
    `SELECT id, content_hash FROM items WHERE source_id = ? AND external_id = ?`,
  );
  const upsertExt = sqlite.prepare(
    `INSERT INTO item_external_ids
       (item_id, source_id, tap, external_id, raw_identifiers, first_seen_at, last_seen_at)
     VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT(source_id, tap, external_id) DO UPDATE SET
       item_id = excluded.item_id,
       raw_identifiers = excluded.raw_identifiers,
       last_seen_at = excluded.last_seen_at`,
  );

  // --- Canonical (cross-tap dedupe) statements (docs/15 §4.2 / §5.3) ---
  const selectIdentity = sqlite.prepare<[string], MessageIdentityRow>(
    `SELECT canonical_item_id, seen_taps FROM message_identity WHERE message_id = ?`,
  );
  const selectItemHash = sqlite.prepare<[string], { content_hash: string | null }>(
    `SELECT content_hash FROM items WHERE id = ?`,
  );
  const insertIdentity = sqlite.prepare(
    `INSERT INTO message_identity
       (message_id, canonical_item_id, content_hash, first_seen_tap,
        first_seen_source_id, seen_taps, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
  );
  const updateIdentityTaps = sqlite.prepare(
    `UPDATE message_identity SET seen_taps = ?, updated_at = ? WHERE message_id = ?`,
  );
  const updateItemContent = sqlite.prepare(
    `UPDATE items SET title = ?, body = ?, body_format = ?, url = ?, occurred_at = ?,
        content_hash = ?, metadata = ?, is_deleted = ?, updated_at = ? WHERE id = ?`,
  );

  /**
   * Cross-tap dedupe path for a single canonical-keyed item. Returns the item id
   * that received the write and whether it is NEW or content-CHANGED (so the
   * caller enqueues chunking); a pure duplicate-attach with no content change
   * returns `changed: false` and is NOT enqueued.
   */
  function commitCanonical(it: NormalizedItem, now: number): { itemId: string; changed: boolean } {
    const canonicalKey = it.canonicalKey as string;
    const hash = it.contentHash ?? contentHashOf(it.title, it.body);
    const isDeleted = it.isDeleted ? 1 : 0;
    const existing = selectIdentity.get(canonicalKey);

    if (!existing) {
      // First time this physical message is seen — create the canonical items row.
      const row = upsertItem.get(
        newId(),
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
        now,
        now,
        now,
      ) as { id: string };
      const itemId = row.id;

      insertIdentity.run(canonicalKey, itemId, hash, it.tap, sourceId, JSON.stringify([it.tap]), now, now);
      upsertExt.run(itemId, sourceId, it.tap, it.externalId, rawIdentifiersOf(it), now, now);
      commitDomain(itemId, sourceId, it);
      return { itemId, changed: !it.isDeleted };
    }

    // Same physical message already landed via another tap: NEVER create a second
    // items row. Record that this tap has also seen it + attach its external id.
    const itemId = existing.canonical_item_id;

    let seen: string[] = [];
    try {
      seen = existing.seen_taps ? (JSON.parse(existing.seen_taps) as string[]) : [];
    } catch {
      seen = [];
    }
    if (!seen.includes(it.tap)) seen.push(it.tap);
    // Append tap (deduped) + bump updated_at (docs/15 §4.2 appendSeenTap).
    updateIdentityTaps.run(JSON.stringify(seen), now, canonicalKey);

    upsertExt.run(itemId, sourceId, it.tap, it.externalId, rawIdentifiersOf(it), now, now);

    // Optionally refresh content if it changed (content_hash differs) — but never
    // add a second items row.
    const prior = selectItemHash.get(itemId);
    const contentChanged = !prior || prior.content_hash !== hash;
    if (contentChanged && !it.isDeleted) {
      updateItemContent.run(
        it.title ?? null,
        it.body ?? null,
        it.bodyFormat ?? "text",
        it.url ?? null,
        it.occurredAt ?? null,
        hash,
        it.metadata ? JSON.stringify(it.metadata) : null,
        isDeleted,
        now,
        itemId,
      );
      commitDomain(itemId, sourceId, it);
      return { itemId, changed: true };
    }
    return { itemId, changed: false };
  }

  const run = sqlite.transaction((batch: NormalizedItem[]): string[] => {
    const changed: string[] = [];
    for (const it of batch) {
      const now = Date.now();

      // Canonical cross-tap dedupe path (docs/15 §4.2) when a cross-tap identity
      // is present; otherwise the exact legacy (source_id, external_id) upsert.
      if (it.canonicalKey) {
        const res = commitCanonical(it, now);
        if (res.changed) changed.push(res.itemId);
        continue;
      }

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

      upsertExt.run(itemId, sourceId, it.tap, it.externalId, null, now, now);
      commitDomain(itemId, sourceId, it);

      const isChanged = !prior || prior.content_hash !== hash;
      if (isChanged && !it.isDeleted) changed.push(itemId);
    }
    return changed;
  });

  const changedItemIds = run(items);
  return { committed: items.length, changedItemIds };
}
