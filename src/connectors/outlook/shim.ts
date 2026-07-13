import type Database from "better-sqlite3";
import type {
  AuthStrategy,
  Connector,
  ConnectorAccount,
  NormalizedItem,
  RateLimitPolicy,
  SyncBatch,
  SyncCursor,
  Tap,
} from "../types";
import {
  openStagingDbReadonly,
  readAccountHealth,
  readStagingItemsAfter,
  type StagingItemRow,
} from "./staging";

/**
 * `outlook-collector` SHIM CONNECTOR (docs/15 §2). The main-app side of the Outlook
 * Collector design and the only part testable offline: it opens the collector's
 * local staging SQLite database READ-ONLY and commits new/changed staging rows via
 * the ordinary `Connector.sync()` contract. The cross-tap dedupe that collapses the
 * same physical email (seen via two taps) into ONE `items` row happens downstream in
 * `services/ingest.ts`, driven purely by `NormalizedItem.canonicalKey` — this
 * connector's only job is to surface that key on each item.
 *
 * SIMPLIFICATION (docs/15 §4.2 / §5.4): the collector has already merged its taps
 * into ONE monotonic `handoff_seq` stream, so the shim exposes a SINGLE logical sync
 * stream keyed on that watermark rather than one sync_state row per (resource, tap,
 * direction). Per-item tap provenance is preserved on each staged row and flows into
 * `item_external_ids` via ingest. The single `sync_state` row uses a stable tap value
 * of `"graph"` (the collector's strategic-primary tap, docs/15 §3.5); the real
 * per-item taps live on the staged rows, not on this cursor.
 */

export const OUTLOOK_CONNECTOR_ID = "outlook-collector";
export const OUTLOOK_DISPLAY_NAME = "Outlook (collector)";

/** Sync-cursor identity for the single merged handoff stream. */
const STAGING_RESOURCE = "staging";
const STAGING_TAP: Tap = "graph"; // stable sync_state tap; per-item taps live on rows.
const STAGING_DIRECTION = "incremental" as const;

/** Rows mapped per `sync()` call. */
const BATCH_SIZE = 100;

type HealthStatus = "ok" | "stale" | "auth_failed" | "needs_consent" | "tap_unavailable";
const VALID_STATUSES: ReadonlySet<string> = new Set([
  "ok",
  "stale",
  "auth_failed",
  "needs_consent",
  "tap_unavailable",
]);

function stagingDbPathOf(config: Record<string, unknown>): string | undefined {
  const p = config.stagingDbPath;
  return typeof p === "string" && p.length > 0 ? p : undefined;
}

/** Map a staged row's `normalized_item` JSON into a NormalizedItem for ingest. */
function toNormalizedItem(row: StagingItemRow): NormalizedItem {
  const base = JSON.parse(row.normalized_item) as NormalizedItem;
  return {
    ...base,
    // Authoritative cross-tap identity + provenance come from the row columns.
    canonicalKey: row.canonical_key,
    tap: row.tap as Tap,
    externalId: row.external_id,
    isDeleted: row.is_deleted === 1 ? true : base.isDeleted,
    metadata: {
      ...(base.metadata ?? {}),
      rawIdentifiers: row.raw_identifiers ?? undefined,
    },
  };
}

function parseWatermark(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export class OutlookCollectorConnector implements Connector {
  readonly id = OUTLOOK_CONNECTOR_ID;
  readonly displayName = OUTLOOK_DISPLAY_NAME;
  readonly category = "email" as const;

  readonly rateLimitPolicy: RateLimitPolicy = {
    // Local SQLite read — no provider throttling. A gentle fixed window is enough.
    strategy: "fixed_window",
    maxRequestsPerWindow: 600,
    windowMs: 60_000,
    backoff: { kind: "exponential", baseMs: 1000, maxMs: 30_000, jitter: true },
  };

  auth(): AuthStrategy {
    return {
      kind: "file_based",
      description: "Reads the on-device Outlook Collector staging database",
    };
  }

  async configure(accountId: string, input: Record<string, unknown>): Promise<ConnectorAccount> {
    const stagingDbPath = stagingDbPathOf(input);
    if (!stagingDbPath) {
      throw new Error("outlook-collector: configure requires a non-empty `stagingDbPath`");
    }
    return {
      sourceId: "", // assigned by the caller / sources row
      accountId,
      config: { ...input, stagingDbPath },
    };
  }

  async testConnection(account: ConnectorAccount): Promise<{
    status: HealthStatus;
    reason?: string;
  }> {
    const path = stagingDbPathOf(account.config);
    if (!path) {
      return { status: "tap_unavailable", reason: "No stagingDbPath configured" };
    }
    let db: Database.Database | undefined;
    try {
      db = openStagingDbReadonly(path);
      // Mirror collector_account_health.status into the connector status enum.
      const health = readAccountHealth(db, account.accountId);
      if (health && VALID_STATUSES.has(health.status)) {
        return {
          status: health.status as HealthStatus,
          reason: health.status_reason ?? undefined,
        };
      }
      return { status: "ok" };
    } catch (err) {
      return {
        status: "tap_unavailable",
        reason: `Staging DB unreadable: ${err instanceof Error ? err.message : String(err)}`,
      };
    } finally {
      db?.close();
    }
  }

  async sync(account: ConnectorAccount, cursor: SyncCursor | null): Promise<SyncBatch> {
    const path = stagingDbPathOf(account.config);
    if (!path) {
      throw new Error("outlook-collector: sync requires a configured `stagingDbPath`");
    }

    const watermark = parseWatermark(cursor?.cursorValue);
    let db: Database.Database | undefined;
    try {
      db = openStagingDbReadonly(path);
      const rows = readStagingItemsAfter(db, watermark, BATCH_SIZE);
      const items = rows.map(toNormalizedItem);
      const lastSeq = rows.length ? rows[rows.length - 1].handoff_seq : watermark;
      const hasMore = rows.length === BATCH_SIZE;

      const nextCursor: SyncCursor = {
        resource: STAGING_RESOURCE,
        tap: STAGING_TAP,
        direction: STAGING_DIRECTION,
        cursorType: "watermark",
        cursorValue: String(lastSeq),
      };

      return { items, nextCursor, hasMore };
    } finally {
      db?.close();
    }
  }
}

export const outlookCollectorConnector = new OutlookCollectorConnector();
