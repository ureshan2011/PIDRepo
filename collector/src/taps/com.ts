/**
 * COM (Redemption) tap wrapper (docs/15 §3.4 fallback, §4.1 fast local backfill, §5.5).
 *
 * Thin adapter over platform/redemption.ts that produces the same NormalizedItem /
 * TapItemBatch shape as the Graph and IMAP taps. Cursor is a simple `watermark`
 * timestamp (docs/15 §5.3 cursor_type 'watermark') — the last ReceivedTime we read.
 * This is the ONLY local-mailbox path; it is Redemption RDO (never raw COM / Object
 * Model Guard, never .ost/.pst scraping, never New Outlook cache — docs/15 §9), and it
 * runs entirely without network egress (docs/15 §8.2). Windows-only; user-validated.
 */

import type { ClassifiedAccount } from "../model.js";
import { TapKind } from "../model.js";
import {
  logonDefaultProfile,
  enumerateStores,
  readMail,
  readCalendar,
  logoff,
  type RedemptionStore,
} from "../platform/redemption.js";
import { contentHashFallback } from "../staging/dedupe.js";
import { log } from "../log.js";
import type { NormalizedItem, TapItemBatch } from "./types.js";

async function resolveStore(account: ClassifiedAccount): Promise<{ session: unknown; store: RedemptionStore } | null> {
  const session = await logonDefaultProfile();
  const stores = await enumerateStores(session);
  const addr = (account.address ?? account.upn ?? "").toLowerCase();
  const store =
    stores.find((s) => s.storeId === account.storeId) ??
    stores.find((s) => s.displayName.toLowerCase().includes(addr)) ??
    stores[0];
  if (!store) {
    await logoff(session);
    return null;
  }
  return { session, store };
}

/** One mail round. `cursor` is a watermark ms (0/null => full local backfill). */
export async function syncMail(
  account: ClassifiedAccount,
  cursor: string | null,
  opts: { limit?: number } = {},
): Promise<TapItemBatch> {
  const sinceMs = cursor ? Number(cursor) || 0 : 0;
  const resolved = await resolveStore(account);
  if (!resolved) return { items: [], nextCursor: cursor, hasMore: false, cursorType: "watermark" };
  const items: NormalizedItem[] = [];
  let maxSent = sinceMs;
  try {
    const mails = await readMail(resolved.store, sinceMs, opts.limit ?? 500);
    for (const m of mails) {
      const canonicalKey =
        m.messageId ??
        contentHashFallback({
          from: m.fromAddress ?? "",
          to: m.toAddresses.join(","),
          subject: m.subject,
          sentAt: m.sentAt ?? 0,
          body: m.bodyText,
        });
      items.push({
        type: "email",
        externalId: m.ids.entryId,
        tap: TapKind.COM,
        canonicalKey,
        title: m.subject,
        body: m.bodyText,
        bodyFormat: "text",
        occurredAt: m.sentAt ?? undefined,
        isDeleted: m.isDeleted,
        rawIdentifiers: { entryId: m.ids.entryId, storeId: m.ids.storeId, searchKey: m.ids.searchKey },
        domainFields: {
          message_id: m.messageId ?? canonicalKey,
          from_address: m.fromAddress,
          from_name: m.fromName,
          to_addresses: m.toAddresses,
          folder: m.folder,
          is_read: m.isRead,
        },
      });
      if (m.sentAt && m.sentAt > maxSent) maxSent = m.sentAt;
    }
  } catch (err) {
    log.warn("COM mail read failed", { account: account.address, err: String(err) });
  } finally {
    await logoff(resolved.session);
  }
  return {
    items,
    nextCursor: String(maxSent),
    hasMore: items.length >= (opts.limit ?? 500),
    cursorType: "watermark",
  };
}

/** One calendar round: masters (RRULE from GetRecurrencePattern) + windowed instances. */
export async function syncCalendar(
  account: ClassifiedAccount,
  _cursor: string | null,
): Promise<TapItemBatch> {
  const resolved = await resolveStore(account);
  if (!resolved) return { items: [], nextCursor: null, hasMore: false, cursorType: "watermark" };
  const items: NormalizedItem[] = [];
  try {
    const { masters, instances } = await readCalendar(resolved.store);
    for (const master of masters) {
      items.push({
        type: "event_master",
        externalId: master.ids.entryId,
        tap: TapKind.COM,
        canonicalKey: master.calendarUid,
        title: master.subject,
        body: master.bodyText,
        occurredAt: master.startAt,
        rawIdentifiers: {
          entryId: master.ids.entryId,
          storeId: master.ids.storeId,
          searchKey: master.ids.searchKey,
        },
        domainFields: {
          calendar_uid: master.calendarUid,
          recurrence_rule: master.rrule,
          recurrence_master_external_id: null,
          start_at: master.startAt,
          end_at: master.endAt,
          all_day: false,
          location: master.location,
          organizer_email: master.organizerEmail,
        },
      });
    }
    for (const inst of instances) {
      items.push({
        type: "event",
        externalId: inst.ids.entryId,
        tap: TapKind.COM,
        canonicalKey: inst.calendarUid,
        title: inst.subject,
        body: inst.bodyText,
        occurredAt: inst.startAt,
        rawIdentifiers: {
          entryId: inst.ids.entryId,
          storeId: inst.ids.storeId,
          searchKey: inst.ids.searchKey,
        },
        domainFields: {
          calendar_uid: inst.calendarUid,
          recurrence_master_external_id: inst.masterUid,
          recurrence_rule: null,
          start_at: inst.startAt,
          end_at: inst.endAt,
          all_day: inst.isAllDay,
          location: inst.location,
          organizer_email: inst.organizerEmail,
        },
      });
    }
  } catch (err) {
    log.warn("COM calendar read failed", { account: account.address, err: String(err) });
  } finally {
    await logoff(resolved.session);
  }
  return { items, nextCursor: String(Date.now()), hasMore: false, cursorType: "watermark" };
}
