import type {
  AuthStrategy,
  Connector,
  ConnectorAccount,
  RateLimitPolicy,
  SyncBatch,
  SyncCursor,
} from "../types";
import { buildFixtureItems } from "./fixtures";

/**
 * Seed / sample connector (BUILD_SPEC §4). No network, no auth — it pages
 * deterministically through an in-memory versioned fixture bundle using a
 * `page_token` cursor whose value is the integer offset. This exercises the exact
 * `sync_state` cursor machinery a real connector uses, proving:
 *   - NormalizedItem -> items + domain-table upsert
 *   - cursor persistence + resumability (kill mid-sync, restart, no dupes/gaps)
 *   - the chunk -> embed pipeline end-to-end
 * Disabling it and enabling a real connector is a one-line `sources` change.
 */

/** Stable identity constants — shared with the seed registration. */
export const SAMPLE_CONNECTOR_ID = "sample";
export const SAMPLE_ACCOUNT_ID = "sample";
/** Deterministic `sources.id` so re-seeding never duplicates the sample source. */
export const SAMPLE_SOURCE_ID = "SAMPLESOURCE00000000000001";
export const SAMPLE_DISPLAY_NAME = "Sample Data";

/** Sync-state identity for the single sample resource (one row per source). */
export const SAMPLE_RESOURCE = "sample";
export const SAMPLE_TAP = "manual" as const;
export const SAMPLE_DIRECTION = "backfill" as const;

/** Items returned per `sync()` call — small enough that a full backfill pages. */
const PAGE_SIZE = 5;

export class SampleConnector implements Connector {
  readonly id = SAMPLE_CONNECTOR_ID;
  readonly displayName = SAMPLE_DISPLAY_NAME;
  readonly category = "sample" as const;

  readonly rateLimitPolicy: RateLimitPolicy = {
    strategy: "fixed_window",
    maxRequestsPerWindow: 1000,
    windowMs: 60_000,
    backoff: { kind: "exponential", baseMs: 1000, maxMs: 60_000, jitter: true },
  };

  auth(): AuthStrategy {
    return { kind: "none" };
  }

  async configure(
    accountId: string,
    input: Record<string, unknown>,
  ): Promise<ConnectorAccount> {
    return {
      sourceId: SAMPLE_SOURCE_ID,
      accountId: accountId || SAMPLE_ACCOUNT_ID,
      config: { ...input },
    };
  }

  async testConnection(): Promise<{
    status: "ok" | "stale" | "auth_failed" | "needs_consent" | "tap_unavailable";
    reason?: string;
  }> {
    // No network dependency — the sample source is always healthy.
    return { status: "ok" };
  }

  /**
   * Page through the fixture bundle. `cursor.cursorValue` is the integer offset
   * (as a string); `null`/absent means "from the beginning" (backfill start).
   * Returns `hasMore: true` until the bundle is exhausted.
   */
  async sync(_account: ConnectorAccount, cursor: SyncCursor | null): Promise<SyncBatch> {
    const all = buildFixtureItems(Date.now());
    const total = all.length;

    const offset = parseOffset(cursor?.cursorValue);
    const end = Math.min(offset + PAGE_SIZE, total);
    const items = all.slice(offset, end);
    const hasMore = end < total;

    const nextCursor: SyncCursor = {
      resource: SAMPLE_RESOURCE,
      tap: SAMPLE_TAP,
      direction: SAMPLE_DIRECTION,
      cursorType: "page_token",
      cursorValue: String(end),
    };

    return { items, nextCursor, hasMore };
  }
}

function parseOffset(value: string | null | undefined): number {
  if (!value) return 0;
  const n = Number.parseInt(value, 10);
  return Number.isFinite(n) && n >= 0 ? n : 0;
}

export const sampleConnector = new SampleConnector();
