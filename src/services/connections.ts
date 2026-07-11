import { eq, ne } from "drizzle-orm";
import { db } from "@/db/client";
import { jobs, sources, syncState } from "@/db/schema";

/**
 * Connections service — reads `sources` joined to `sync_state` for the Settings →
 * Connections health list, a rolled-up summary for the TopBar dot, and an
 * enqueue-on-demand `connector_sync` job for "Sync now". BUILD_SPEC §9.
 *
 * The internal app-owned source (`connector_id='app'`) is a home for manually
 * created tasks/notes, NOT a connector, so it is excluded from every read here.
 */

export type HealthStatusDb =
  | "ok"
  | "stale"
  | "auth_failed"
  | "needs_consent"
  | "tap_unavailable";

export interface ConnectionAccount {
  sourceId: string;
  displayName: string;
  category: string;
  connectorId: string;
  tap: string | null;
  status: HealthStatusDb;
  statusReason: string | null;
  lastSyncAt: number | null;
  enabled: boolean;
}

const APP_CONNECTOR_ID = "app";

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

/**
 * One health row per (source × sync_state tap). Sources without any sync_state
 * row still surface a single row using `sources.status`/`last_sync_at`.
 */
export function listConnections(): ConnectionAccount[] {
  const srcs = db
    .select()
    .from(sources)
    .where(ne(sources.connectorId, APP_CONNECTOR_ID))
    .all();

  const out: ConnectionAccount[] = [];
  for (const s of srcs) {
    const states = db.select().from(syncState).where(eq(syncState.sourceId, s.id)).all();
    if (states.length === 0) {
      out.push({
        sourceId: s.id,
        displayName: s.displayName,
        category: s.category,
        connectorId: s.connectorId,
        tap: null,
        status: s.status as HealthStatusDb,
        statusReason: s.statusReason,
        lastSyncAt: ms(s.lastSyncAt),
        enabled: s.enabled,
      });
      continue;
    }
    for (const st of states) {
      out.push({
        sourceId: s.id,
        displayName: s.displayName,
        category: s.category,
        connectorId: s.connectorId,
        tap: st.tap,
        status: (st.status ?? s.status) as HealthStatusDb,
        statusReason: st.statusReason ?? s.statusReason,
        lastSyncAt: ms(st.lastSuccessAt ?? s.lastSyncAt),
        enabled: s.enabled,
      });
    }
  }
  return out;
}

export interface ConnectionsSummary {
  status: HealthStatusDb;
  counts: Record<HealthStatusDb, number>;
  total: number;
}

// Worst-first precedence for the rolled-up TopBar dot.
const STATUS_PRECEDENCE: HealthStatusDb[] = [
  "auth_failed",
  "needs_consent",
  "stale",
  "tap_unavailable",
  "ok",
];

/** Rolled-up worst status across connector sources. */
export function getSummary(): ConnectionsSummary {
  const accounts = listConnections();
  const counts: Record<HealthStatusDb, number> = {
    ok: 0,
    stale: 0,
    auth_failed: 0,
    needs_consent: 0,
    tap_unavailable: 0,
  };
  for (const a of accounts) counts[a.status]++;

  let status: HealthStatusDb = "ok";
  for (const s of STATUS_PRECEDENCE) {
    if (counts[s] > 0) {
      status = s;
      break;
    }
  }
  return { status, counts, total: accounts.length };
}

export interface EnqueueResult {
  ok: boolean;
  jobId?: number;
  error?: string;
}

/** Enqueue an on-demand `connector_sync` job for a source ("Sync now"). */
export function enqueueSyncNow(sourceId: string): EnqueueResult {
  const src = db.select().from(sources).where(eq(sources.id, sourceId)).get();
  if (!src) return { ok: false, error: "not_found" };
  if (src.connectorId === APP_CONNECTOR_ID) return { ok: false, error: "not_syncable" };

  const now = new Date();
  const res = db
    .insert(jobs)
    .values({
      type: "connector_sync",
      status: "queued",
      payload: { sourceId },
      priority: 10,
      runAt: now,
      createdAt: now,
    })
    .run();
  return { ok: true, jobId: Number(res.lastInsertRowid) };
}
