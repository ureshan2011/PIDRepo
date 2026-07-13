/**
 * Connector interface + all shared types. Transcribed VERBATIM from BUILD_SPEC §4
 * (docs/05). This is the pluggable contract every data source implements; the
 * seed/sample connector is the reference implementation. Do not add app-specific
 * fields here — keep it the neutral integration surface.
 */

export type SourceCategory =
  | "email"
  | "calendar"
  | "tasks"
  | "notes"
  | "documents"
  | "papers"
  | "cloud_storage"
  | "code"
  | "chat"
  | "bookmarks"
  | "finance"
  | "health"
  | "travel"
  | "photos"
  | "contacts"
  | "feed"
  | "weather"
  | "ai_conversation"
  | "sample";

export type Tap = "graph" | "imap" | "com" | "caldav" | "rss" | "api" | "filesystem" | "manual";
export type SyncDirection = "backfill" | "incremental";

export type AuthStrategy =
  | { kind: "oauth2"; authorizationUrl: string; tokenUrl: string; scopes: string[]; pkce: true }
  | { kind: "device_code"; scopes: string[] }
  | { kind: "api_key"; headerName: string }
  | { kind: "file_based"; description: string }
  | { kind: "none" };

export interface ConnectorAccount {
  sourceId: string;
  accountId: string;
  config: Record<string, unknown>; // non-secret; secrets live in OS credential store (docs/06)
}

export interface SyncCursor {
  resource: string; // sync_state.resource
  tap: Tap; // sync_state.tap
  direction: SyncDirection; // sync_state.direction
  cursorType: "delta_link" | "uidvalidity_uid_modseq" | "watermark" | "page_token" | null;
  cursorValue: string | null;
}

export interface NormalizedItem {
  type: string; // items.type
  externalId: string; // items.external_id
  tap: Tap; // -> item_external_ids.tap
  /**
   * Cross-tap canonical identity (docs/15 §5.2): RFC 5322 Message-ID / iCalendar
   * UID, or a normalized content-hash fallback. When set, ingest collapses the
   * same physical message seen via two different taps into ONE `items` row
   * (docs/15 §4.2). Optional + backwards compatible — connectors that don't emit
   * a cross-tap identity (e.g. the sample connector) simply omit it and keep the
   * plain (source_id, external_id) upsert path.
   */
  canonicalKey?: string;
  title?: string;
  body?: string;
  bodyFormat?: "text" | "markdown" | "html";
  url?: string;
  occurredAt?: number; // epoch ms
  contentHash?: string;
  metadata?: Record<string, unknown>;
  domainFields?: Record<string, unknown>; // columns for the matching domain table
  isDeleted?: boolean;
}

export interface SyncBatch {
  items: NormalizedItem[];
  nextCursor: SyncCursor; // persisted to sync_state AFTER items commit
  hasMore: boolean; // true => call sync() again before sleeping
}

export class ConnectorError extends Error {
  constructor(
    public readonly kind:
      | "auth_expired"
      | "auth_denied"
      | "rate_limited"
      | "tap_unavailable"
      | "not_found"
      | "unknown",
    message: string,
    public readonly retryAfterMs?: number,
  ) {
    super(message);
    this.name = "ConnectorError";
  }
}

export interface RateLimitPolicy {
  strategy: "fixed_window" | "token_bucket" | "provider_header_driven";
  maxRequestsPerWindow?: number;
  windowMs?: number;
  backoff: { kind: "exponential"; baseMs: number; maxMs: number; jitter: true };
}

export interface Connector {
  readonly id: string; // matches sources.connector_id
  readonly displayName: string;
  readonly category: SourceCategory;
  readonly rateLimitPolicy: RateLimitPolicy;
  auth(): AuthStrategy;
  configure(accountId: string, input: Record<string, unknown>): Promise<ConnectorAccount>;
  testConnection(account: ConnectorAccount): Promise<{
    status: "ok" | "stale" | "auth_failed" | "needs_consent" | "tap_unavailable";
    reason?: string;
  }>;
  sync(account: ConnectorAccount, cursor: SyncCursor | null): Promise<SyncBatch>;
}
