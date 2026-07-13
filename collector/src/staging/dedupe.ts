/**
 * Canonical cross-tap key + cross-tap collapse (docs/15 §5.2, §4.2).
 *
 * Primary key: the RFC 5322 Message-ID (email) or the iCalendar UID (calendar).
 * Fallback: a normalized content hash, used only when Message-ID is missing/malformed
 * (some internal Exchange system messages, a minority of IMAP servers). Per docs/15
 * §5.2 the fallback is intentionally coarser than items.content_hash — its job is
 * cross-tap IDENTITY, not change detection.
 */

import { createHash } from "node:crypto";
import type { NormalizedItem } from "../taps/types.js";

/** sha256(normalize(from)+normalize(to)+subject+floor(sentAt,1min)+sha256(bodyText)) — docs/15 §5.2. */
export function contentHashFallback(parts: {
  from: string;
  to: string;
  subject: string;
  sentAt: number;
  body: string;
}): string {
  const norm = (s: string) => s.trim().toLowerCase();
  const minute = Math.floor((parts.sentAt || 0) / 60_000);
  const bodyHash = createHash("sha256").update(parts.body ?? "").digest("hex");
  return (
    "ch:" +
    createHash("sha256")
      .update(norm(parts.from) + "|" + norm(parts.to) + "|" + parts.subject + "|" + minute + "|" + bodyHash)
      .digest("hex")
  );
}

/** Resolve an item's canonical key: explicit canonicalKey, else derive from fields. */
export function canonicalKeyOf(item: NormalizedItem): string {
  if (item.canonicalKey) return item.canonicalKey;
  const df = (item.domainFields ?? {}) as Record<string, unknown>;
  const messageId = typeof df.message_id === "string" ? df.message_id : undefined;
  const calendarUid = typeof df.calendar_uid === "string" ? df.calendar_uid : undefined;
  if (messageId) return messageId;
  if (calendarUid) return calendarUid;
  return contentHashFallback({
    from: String(df.from_address ?? ""),
    to: Array.isArray(df.to_addresses) ? df.to_addresses.join(",") : String(df.to_addresses ?? ""),
    subject: item.title ?? "",
    sentAt: item.occurredAt ?? 0,
    body: item.body ?? "",
  });
}

/**
 * Collapse a batch so two taps racing inside the SAME collector pass (docs/15 §4.2
 * dual backfill) contribute at most one staged row per canonical key. The FIRST
 * occurrence wins as the canonical row; the loser's tap is recorded on the winner's
 * `seenTaps` so provenance survives (the writer persists it to
 * collector_message_identity, and item_external_ids downstream). Deletions always pass
 * through so a tombstone is never suppressed by an earlier live row.
 */
export function collapseByCanonicalKey(
  items: NormalizedItem[],
): { collapsed: NormalizedItem[]; seenTaps: Map<string, Set<string>> } {
  const winners = new Map<string, NormalizedItem>();
  const seenTaps = new Map<string, Set<string>>();
  const collapsed: NormalizedItem[] = [];
  for (const item of items) {
    const key = canonicalKeyOf(item);
    const taps = seenTaps.get(key) ?? new Set<string>();
    taps.add(String(item.tap));
    seenTaps.set(key, taps);
    if (item.isDeleted) {
      collapsed.push({ ...item, canonicalKey: key });
      continue;
    }
    if (!winners.has(key)) {
      const canonical = { ...item, canonicalKey: key };
      winners.set(key, canonical);
      collapsed.push(canonical);
    }
    // else: duplicate live row within this pass — dropped; its tap is on seenTaps.
  }
  return { collapsed, seenTaps };
}
