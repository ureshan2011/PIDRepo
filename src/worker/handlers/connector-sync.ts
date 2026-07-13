import { getConnector } from "@/connectors/registry";
import { ConnectorError, type ConnectorAccount, type SyncCursor } from "@/connectors/types";
import { sqlite } from "@/db/client";
import { commitBatch } from "@/services/ingest";
import type { JobHandler } from "../dispatch";

/**
 * `connector_sync` handler (BUILD_SPEC §5). Payload `{ sourceId }`.
 *
 * Loads the Connector from the registry by `sources.connector_id`, resumes from the
 * durable `sync_state` cursor (missing row => null cursor => backfill from start),
 * and loops `sync()` until `hasMore === false`. For each batch:
 *   1. commit items atomically via `ingest.commitBatch` (idempotent upsert),
 *   2. THEN persist `nextCursor` + `last_success_at` to `sync_state` — cursor
 *      advances ONLY post-commit, so a crash/kill mid-sync re-fetches from the last
 *      committed position and re-upserts harmlessly (no dupes / no gaps).
 *   3. enqueue `pipeline_chunk` for new/changed item ids.
 * On success sets `sources.status='ok'` + `last_sync_at`. On ConnectorError sets
 * `sources`/`sync_state` status WITHOUT advancing the cursor, then rethrows so the
 * worker applies its retry/backoff.
 *
 * Assumes a single sync_state row per source (true for the sample connector). The
 * cursor identity (resource/tap/direction) comes from the connector's nextCursor.
 */

interface SourceRow {
  id: string;
  connector_id: string;
  account_id: string;
  category: string;
  config: string | null;
}

interface SyncStateRow {
  resource: string;
  tap: string;
  direction: string;
  cursor_type: string | null;
  cursor_value: string | null;
}

const MAX_BATCHES = 10_000; // hard stop against a misbehaving connector.

const enqueueChunk = sqlite.prepare(
  `INSERT INTO jobs (type, status, payload, priority, attempts, max_attempts, run_at, created_at)
   VALUES ('pipeline_chunk', 'queued', ?, 0, 0, 3, ?, ?)`,
);

const upsertSyncState = sqlite.prepare(
  `INSERT INTO sync_state
     (source_id, resource, tap, direction, cursor_type, cursor_value,
      status, status_reason, last_attempt_at, last_success_at, created_at, updated_at)
   VALUES (?, ?, ?, ?, ?, ?, 'ok', NULL, ?, ?, ?, ?)
   ON CONFLICT(source_id, resource, tap, direction) DO UPDATE SET
     cursor_type = excluded.cursor_type,
     cursor_value = excluded.cursor_value,
     status = 'ok',
     status_reason = NULL,
     last_attempt_at = excluded.last_attempt_at,
     last_success_at = excluded.last_success_at,
     updated_at = excluded.updated_at`,
);

function statusForConnectorError(kind: ConnectorError["kind"]): string {
  switch (kind) {
    case "auth_expired":
      return "auth_failed";
    case "auth_denied":
      return "needs_consent";
    case "tap_unavailable":
      return "tap_unavailable";
    default:
      return "stale";
  }
}

export const connectorSync: JobHandler = async (payload) => {
  const sourceId = String(payload.sourceId ?? "");
  if (!sourceId) throw new Error("connector_sync: missing sourceId in payload");

  const source = sqlite
    .prepare<[string], SourceRow>(
      `SELECT id, connector_id, account_id, category, config FROM sources WHERE id = ?`,
    )
    .get(sourceId);
  if (!source) throw new Error(`connector_sync: source ${sourceId} not found`);

  const connector = getConnector(source.connector_id);
  if (!connector) {
    sqlite
      .prepare(`UPDATE sources SET status='tap_unavailable', status_reason=?, updated_at=? WHERE id=?`)
      .run(`no connector registered for "${source.connector_id}"`, Date.now(), sourceId);
    throw new Error(`connector_sync: no connector registered for "${source.connector_id}"`);
  }

  const account: ConnectorAccount = {
    sourceId,
    accountId: source.account_id,
    config: source.config ? (JSON.parse(source.config) as Record<string, unknown>) : {},
  };

  // Resume from the existing durable cursor if present (single row per source).
  const existing = sqlite
    .prepare<[string], SyncStateRow>(
      `SELECT resource, tap, direction, cursor_type, cursor_value
         FROM sync_state WHERE source_id = ? ORDER BY id ASC LIMIT 1`,
    )
    .get(sourceId);

  let cursor: SyncCursor | null = existing
    ? {
        resource: existing.resource,
        tap: existing.tap as SyncCursor["tap"],
        direction: existing.direction as SyncCursor["direction"],
        cursorType: existing.cursor_type as SyncCursor["cursorType"],
        cursorValue: existing.cursor_value,
      }
    : null;

  try {
    for (let i = 0; i < MAX_BATCHES; i++) {
      const batch = await connector.sync(account, cursor);

      // (1) Commit items atomically FIRST.
      const { changedItemIds } = commitBatch(sourceId, batch.items);

      // (2) THEN advance the cursor (post-commit; crash-safe).
      const now = Date.now();
      const c = batch.nextCursor;
      upsertSyncState.run(
        sourceId,
        c.resource,
        c.tap,
        c.direction,
        c.cursorType,
        c.cursorValue,
        now,
        now,
        now,
        now,
      );

      // (3) Enqueue chunking for new/changed items.
      for (const itemId of changedItemIds) {
        enqueueChunk.run(JSON.stringify({ itemId }), now, now);
      }

      cursor = c;
      if (!batch.hasMore) break;
    }

    sqlite
      .prepare(`UPDATE sources SET status='ok', status_reason=NULL, last_sync_at=?, updated_at=? WHERE id=?`)
      .run(Date.now(), Date.now(), sourceId);
  } catch (err) {
    const now = Date.now();
    if (err instanceof ConnectorError) {
      const status = statusForConnectorError(err.kind);
      sqlite
        .prepare(`UPDATE sources SET status=?, status_reason=?, updated_at=? WHERE id=?`)
        .run(status, err.message, now, sourceId);
      // Mark sync_state status too, WITHOUT touching the cursor.
      sqlite
        .prepare(
          `UPDATE sync_state SET status=?, status_reason=?, last_attempt_at=?, updated_at=? WHERE source_id=?`,
        )
        .run(status, err.message, now, now, sourceId);
    } else {
      sqlite
        .prepare(`UPDATE sources SET status='stale', status_reason=?, updated_at=? WHERE id=?`)
        .run(err instanceof Error ? err.message : String(err), now, sourceId);
    }
    throw err; // let the worker apply retry/backoff.
  }
};
