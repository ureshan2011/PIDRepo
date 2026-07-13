import Database from "better-sqlite3";
import type { NormalizedItem } from "../types";

/**
 * Outlook Collector staging-database access (docs/15 §2, §5.4).
 *
 * The real Outlook Collector is a separate per-user Windows process that owns this
 * SQLite file (WAL mode, single writer). The main app's `outlook-collector` shim
 * connector opens it **read-only** and treats new/changed staging rows exactly like
 * any other connector's `sync()` result. The collector never writes into the main
 * PID database; only the shim's `sync()` (running in the main app's worker) commits
 * into `items` / `sync_state` / `message_identity` / `item_external_ids`.
 *
 * This module provides:
 *   - read-only reads over the staging schema (used by the shim), and
 *   - `createStagingDb` / `stageItem` write helpers that MATERIALIZE the §5.4
 *     schema — used by tests and the dev-demo seed, and equally usable by a real
 *     collector implementation.
 */

/** Row shape of `collector_staging_items` (docs/15 §5.4). */
export interface StagingItemRow {
  handoff_seq: number;
  account_id: string;
  canonical_key: string;
  tap: string;
  external_id: string;
  raw_identifiers: string | null;
  normalized_item: string; // JSON, matches the NormalizedItem shape (docs/05)
  is_deleted: number;
  staged_at: number;
}

/** Row shape of `collector_account_health` (docs/15 §5.4 / §7). */
export interface AccountHealthRow {
  account_id: string;
  resource: string;
  status: string; // ok|stale|auth_failed|needs_consent|tap_unavailable
  status_reason: string | null;
  last_success_at: number | null;
  updated_at: number;
}

/**
 * DDL for the collector-local staging schema (docs/15 §5.4). Verbatim shape of the
 * design's four tables; `IF NOT EXISTS` so `createStagingDb` is idempotent.
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

/**
 * CREATE (or open) a collector staging DB at `path` and materialize the §5.4
 * schema. Opened read-write (WAL) — this is the collector-side / test-side writer.
 * Returns the raw better-sqlite3 handle; caller closes it.
 */
export function createStagingDb(path: string): Database.Database {
  const db = new Database(path);
  db.pragma("journal_mode = WAL");
  db.exec(STAGING_SCHEMA_SQL);
  return db;
}

/** Open an existing staging DB **read-only** (the shim connector's access mode). */
export function openStagingDbReadonly(path: string): Database.Database {
  return new Database(path, { readonly: true, fileMustExist: true });
}

export interface StageItemInput {
  accountId: string;
  canonicalKey: string;
  tap: string;
  externalId: string;
  rawIdentifiers?: Record<string, unknown> | string | null;
  normalizedItem: NormalizedItem;
  isDeleted?: boolean;
  stagedAt?: number;
}

/**
 * Insert one normalized row into `collector_staging_items` and maintain the local
 * pre-dedupe mirror `collector_message_identity` (append seen tap). Note: this does
 * NOT collapse across taps — it stages one row per handoff, faithfully reproducing
 * the case docs/15 §4.2 exists to resolve, where a COM backfill row and a Graph
 * incremental row for the SAME physical message are both handed off and the MAIN
 * app's `sync()` performs the cross-tap collapse. Returns the new `handoff_seq`.
 */
export function stageItem(db: Database.Database, input: StageItemInput): number {
  const stagedAt = input.stagedAt ?? Date.now();
  const raw =
    input.rawIdentifiers === undefined || input.rawIdentifiers === null
      ? null
      : typeof input.rawIdentifiers === "string"
        ? input.rawIdentifiers
        : JSON.stringify(input.rawIdentifiers);

  const info = db
    .prepare(
      `INSERT INTO collector_staging_items
         (account_id, canonical_key, tap, external_id, raw_identifiers,
          normalized_item, is_deleted, staged_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?)`,
    )
    .run(
      input.accountId,
      input.canonicalKey,
      input.tap,
      input.externalId,
      raw,
      JSON.stringify(input.normalizedItem),
      input.isDeleted ? 1 : 0,
      stagedAt,
    );
  const handoffSeq = Number(info.lastInsertRowid);

  const existing = db
    .prepare<[string], { seen_taps: string }>(
      `SELECT seen_taps FROM collector_message_identity WHERE canonical_key = ?`,
    )
    .get(input.canonicalKey);
  if (!existing) {
    db.prepare(
      `INSERT INTO collector_message_identity (canonical_key, handoff_seq, seen_taps)
       VALUES (?, ?, ?)`,
    ).run(input.canonicalKey, handoffSeq, JSON.stringify([input.tap]));
  } else {
    let seen: string[] = [];
    try {
      seen = JSON.parse(existing.seen_taps) as string[];
    } catch {
      seen = [];
    }
    if (!seen.includes(input.tap)) seen.push(input.tap);
    db.prepare(`UPDATE collector_message_identity SET seen_taps = ? WHERE canonical_key = ?`).run(
      JSON.stringify(seen),
      input.canonicalKey,
    );
  }

  return handoffSeq;
}

/** Upsert one `collector_account_health` row (test/collector-side helper). */
export function setAccountHealth(
  db: Database.Database,
  row: Omit<AccountHealthRow, "updated_at"> & { updated_at?: number },
): void {
  db.prepare(
    `INSERT INTO collector_account_health
       (account_id, resource, status, status_reason, last_success_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT(account_id) DO UPDATE SET
       resource = excluded.resource, status = excluded.status,
       status_reason = excluded.status_reason, last_success_at = excluded.last_success_at,
       updated_at = excluded.updated_at`,
  ).run(
    row.account_id,
    row.resource,
    row.status,
    row.status_reason ?? null,
    row.last_success_at ?? null,
    row.updated_at ?? Date.now(),
  );
}

/**
 * Read up to `limit` staged rows with `handoff_seq > watermark`, ordered by
 * `handoff_seq` (the collector's monotonic merged handoff stream, docs/15 §5.4).
 */
export function readStagingItemsAfter(
  db: Database.Database,
  watermark: number,
  limit: number,
): StagingItemRow[] {
  return db
    .prepare<[number, number], StagingItemRow>(
      `SELECT handoff_seq, account_id, canonical_key, tap, external_id, raw_identifiers,
              normalized_item, is_deleted, staged_at
         FROM collector_staging_items
        WHERE handoff_seq > ?
        ORDER BY handoff_seq ASC
        LIMIT ?`,
    )
    .all(watermark, limit);
}

/** Read the account-health row for an account (or the first row if unspecified). */
export function readAccountHealth(
  db: Database.Database,
  accountId?: string,
): AccountHealthRow | undefined {
  if (accountId) {
    return db
      .prepare<[string], AccountHealthRow>(
        `SELECT account_id, resource, status, status_reason, last_success_at, updated_at
           FROM collector_account_health WHERE account_id = ?`,
      )
      .get(accountId);
  }
  return db
    .prepare<[], AccountHealthRow>(
      `SELECT account_id, resource, status, status_reason, last_success_at, updated_at
         FROM collector_account_health ORDER BY account_id ASC LIMIT 1`,
    )
    .get();
}
