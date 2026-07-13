/**
 * Collector staging DB writer (docs/15 §5.4).
 *
 * THE SINGLE WRITER of the WAL staging SQLite the main app's `outlook-collector` shim
 * reads read-only. Its four tables and the `normalized_item` JSON shape MUST stay in
 * LOCKSTEP with src/connectors/outlook/staging.ts in the main repo — the DDL below is
 * copied VERBATIM from that file (the shim's contract). If you change one, change both.
 *
 * Responsibilities (docs/15 §5.4):
 *   (a) resume across the collector's own crashes without re-fetching (collector_sync_state);
 *   (b) pre-dedupe across the collector's concurrent taps BEFORE handoff, so the shim's
 *       sync() sees a clean incremental batch — persistent cross-tap collapse via
 *       collector_message_identity (docs/15 §4.2 local mirror of message_identity);
 *   (c) mirror per-account health for the shim's testConnection() (collector_account_health).
 */

import DatabaseConstructor from "better-sqlite3";
import type { Database } from "better-sqlite3";
import type { HealthStatus, ResourceKind, SyncDirection, TapKind } from "../model.js";
import type { NormalizedItem } from "../taps/types.js";
import { canonicalKeyOf } from "./dedupe.js";

/**
 * VERBATIM from src/connectors/outlook/staging.ts (docs/15 §5.4). Keep in lockstep.
 * `IF NOT EXISTS` so materialization is idempotent.
 */
const STAGING_SCHEMA_SQL = `
CREATE TABLE IF NOT EXISTS collector_sync_state (
    account_id    TEXT NOT NULL,
    resource      TEXT NOT NULL,
    tap           TEXT NOT NULL,
    direction     TEXT NOT NULL,
    cursor_type   TEXT,
    cursor_value  TEXT,
    updated_at    INTEGER NOT NULL,
    PRIMARY KEY (account_id, resource, tap, direction)
);

CREATE TABLE IF NOT EXISTS collector_staging_items (
    handoff_seq     INTEGER PRIMARY KEY AUTOINCREMENT,
    account_id      TEXT NOT NULL,
    canonical_key   TEXT NOT NULL,
    tap             TEXT NOT NULL,
    external_id     TEXT NOT NULL,
    raw_identifiers TEXT,
    normalized_item TEXT NOT NULL,
    is_deleted      INTEGER NOT NULL DEFAULT 0,
    staged_at       INTEGER NOT NULL
);
CREATE INDEX IF NOT EXISTS collector_staging_canonical_idx
    ON collector_staging_items(canonical_key);

CREATE TABLE IF NOT EXISTS collector_message_identity (
    canonical_key   TEXT PRIMARY KEY,
    handoff_seq     INTEGER NOT NULL REFERENCES collector_staging_items(handoff_seq),
    seen_taps       TEXT NOT NULL DEFAULT '[]'
);

CREATE TABLE IF NOT EXISTS collector_account_health (
    account_id      TEXT PRIMARY KEY,
    resource        TEXT NOT NULL,
    status          TEXT NOT NULL,
    status_reason   TEXT,
    last_success_at INTEGER,
    updated_at      INTEGER NOT NULL
);
`;

export class StagingWriter {
  private readonly db: Database;

  constructor(path: string) {
    this.db = new DatabaseConstructor(path);
    this.db.pragma("journal_mode = WAL");
    this.db.exec(STAGING_SCHEMA_SQL);
  }

  close(): void {
    this.db.close();
  }

  /**
   * Stage a batch for one (account, resource). Performs the PERSISTENT cross-tap
   * collapse (docs/15 §5.4b / §4.2): if a canonical key already has a staged row, the
   * new tap is appended to that row's `seen_taps` and NO duplicate staging row is
   * created — the main app therefore never sees the same physical message twice.
   * Deletions always stage a tombstone row so a removal is never suppressed.
   * Returns the number of NEW staging rows written (i.e. after collapse).
   */
  stageBatch(
    accountId: string,
    items: NormalizedItem[],
    seenTaps?: Map<string, Set<string>>,
  ): number {
    const insertItem = this.db.prepare(
      `INSERT INTO collector_staging_items
         (account_id, canonical_key, tap, external_id, raw_identifiers,
          normalized_item, is_deleted, staged_at)
       VALUES (@account_id, @canonical_key, @tap, @external_id, @raw_identifiers,
               @normalized_item, @is_deleted, @staged_at)`,
    );
    const selIdentity = this.db.prepare<[string], { seen_taps: string }>(
      `SELECT seen_taps FROM collector_message_identity WHERE canonical_key = ?`,
    );
    const insIdentity = this.db.prepare(
      `INSERT INTO collector_message_identity (canonical_key, handoff_seq, seen_taps)
       VALUES (?, ?, ?)`,
    );
    const updIdentity = this.db.prepare(
      `UPDATE collector_message_identity SET seen_taps = ? WHERE canonical_key = ?`,
    );

    const tx = this.db.transaction((batch: NormalizedItem[]) => {
      let written = 0;
      for (const item of batch) {
        const key = canonicalKeyOf(item);
        const existing = selIdentity.get(key);
        const passTaps = seenTaps?.get(key);

        if (existing && !item.isDeleted) {
          // Already staged via another tap/pass — record provenance, skip duplicate row.
          const taps = mergeTaps(existing.seen_taps, String(item.tap), passTaps);
          updIdentity.run(JSON.stringify(taps), key);
          continue;
        }

        const info = insertItem.run({
          account_id: accountId,
          canonical_key: key,
          tap: String(item.tap),
          external_id: item.externalId,
          raw_identifiers: item.rawIdentifiers ? JSON.stringify(item.rawIdentifiers) : null,
          normalized_item: JSON.stringify(toStoredNormalizedItem(item, key)),
          is_deleted: item.isDeleted ? 1 : 0,
          staged_at: Date.now(),
        });
        written++;
        const handoffSeq = Number(info.lastInsertRowid);
        if (existing) {
          const taps = mergeTaps(existing.seen_taps, String(item.tap), passTaps);
          updIdentity.run(JSON.stringify(taps), key);
        } else {
          const taps = mergeTaps("[]", String(item.tap), passTaps);
          insIdentity.run(key, handoffSeq, JSON.stringify(taps));
        }
      }
      return written;
    });

    return tx(items);
  }

  /** Upsert the collector's own watermark for a (account, resource, tap, direction). */
  setCursor(
    accountId: string,
    resource: ResourceKind,
    tap: TapKind,
    direction: SyncDirection,
    cursorType: string | null,
    cursorValue: string | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO collector_sync_state
           (account_id, resource, tap, direction, cursor_type, cursor_value, updated_at)
         VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id, resource, tap, direction) DO UPDATE SET
           cursor_type = excluded.cursor_type,
           cursor_value = excluded.cursor_value,
           updated_at = excluded.updated_at`,
      )
      .run(accountId, resource, String(tap), direction, cursorType, cursorValue, Date.now());
  }

  /** Read the collector's stored cursor for resume-after-crash (docs/15 §5.4a). */
  getCursor(
    accountId: string,
    resource: ResourceKind,
    tap: TapKind,
    direction: SyncDirection,
  ): string | null {
    const row = this.db
      .prepare<[string, string, string, string], { cursor_value: string | null }>(
        `SELECT cursor_value FROM collector_sync_state
          WHERE account_id = ? AND resource = ? AND tap = ? AND direction = ?`,
      )
      .get(accountId, resource, String(tap), direction);
    return row?.cursor_value ?? null;
  }

  /** Mirror per-account health for the shim's testConnection() (docs/15 §5.4 / §7). */
  setAccountHealth(
    accountId: string,
    resource: ResourceKind,
    status: HealthStatus,
    statusReason: string | null,
    lastSuccessAt: number | null,
  ): void {
    this.db
      .prepare(
        `INSERT INTO collector_account_health
           (account_id, resource, status, status_reason, last_success_at, updated_at)
         VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT(account_id) DO UPDATE SET
           resource = excluded.resource,
           status = excluded.status,
           status_reason = excluded.status_reason,
           last_success_at = COALESCE(excluded.last_success_at, collector_account_health.last_success_at),
           updated_at = excluded.updated_at`,
      )
      .run(accountId, resource, status, statusReason, lastSuccessAt, Date.now());
  }
}

/** Merge tap provenance JSON with a new tap (and any same-pass taps). */
function mergeTaps(existingJson: string, tap: string, passTaps?: Set<string>): string[] {
  let taps: string[] = [];
  try {
    taps = JSON.parse(existingJson) as string[];
  } catch {
    taps = [];
  }
  const set = new Set(taps);
  set.add(tap);
  if (passTaps) for (const t of passTaps) set.add(t);
  return [...set];
}

/**
 * Project the collector-internal item down to the EXACT docs/05 NormalizedItem shape
 * the shim expects in `normalized_item` (src/connectors/types.ts). `tap`/`externalId`/
 * `canonicalKey`/`rawIdentifiers` are carried in dedicated columns, but we also keep a
 * compatible `tap`/`externalId` here so the JSON round-trips cleanly.
 */
function toStoredNormalizedItem(item: NormalizedItem, canonicalKey: string): Record<string, unknown> {
  return {
    type: item.type,
    externalId: item.externalId,
    tap: String(item.tap),
    canonicalKey,
    title: item.title,
    body: item.body,
    bodyFormat: item.bodyFormat,
    url: item.url,
    occurredAt: item.occurredAt,
    contentHash: item.contentHash,
    metadata: item.metadata,
    domainFields: item.domainFields,
    isDeleted: item.isDeleted ?? false,
  };
}
