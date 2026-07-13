/**
 * Collector-internal normalized item + tap batch shapes.
 *
 * `NormalizedItem` is a superset of the main app's docs/05 `NormalizedItem` (mirrored
 * in src/connectors/types.ts): the extra `rawIdentifiers` carries the per-tap native
 * ids (docs/15 §5.1) that the staging writer lifts into the `raw_identifiers` column,
 * and `tap` is the collector's `TapKind`. When the writer serializes `normalized_item`
 * it emits exactly the docs/05 fields, so the main app's shim reads a byte-compatible
 * JSON payload (see staging/writer.ts).
 */

import type { TapKind } from "../model.js";

export interface NormalizedItem {
  /** items.type — 'email' | 'event' | 'event_master'. */
  type: string;
  /** items.external_id — the tap-native id. */
  externalId: string;
  tap: TapKind;
  /** Cross-tap canonical identity (docs/15 §5.2). */
  canonicalKey?: string;
  title?: string;
  body?: string;
  bodyFormat?: "text" | "markdown" | "html";
  url?: string;
  occurredAt?: number;
  contentHash?: string;
  metadata?: Record<string, unknown>;
  domainFields?: Record<string, unknown>;
  isDeleted?: boolean;
  /** Per-tap native identifiers -> collector_staging_items.raw_identifiers (docs/15 §5.1). */
  rawIdentifiers?: Record<string, unknown>;
}

export type CursorType = "delta_link" | "uidvalidity_uid_modseq" | "watermark" | "page_token";

export interface TapItemBatch {
  items: NormalizedItem[];
  /** Opaque cursor to persist AFTER items commit (docs/05 / docs/15 §5.3). */
  nextCursor: string | null;
  /** true => call the tap again before sleeping. */
  hasMore: boolean;
  cursorType: CursorType;
}

export type ResourceKind = "mail" | "calendar";
