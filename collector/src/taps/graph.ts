/**
 * Microsoft Graph tap (docs/15 §3.4, §4, §5.5, §6.4) — the strategic-primary tap.
 *
 * Pure HTTPS against `graph.microsoft.com` using global `fetch` (no SDK). Implements:
 *   - mail via `/me/messages/delta` with a `deltaLink` cursor (docs/15 §5.3 cursor_type
 *     'delta_link'); a null/absent cursor performs the initial backfill, following
 *     `@odata.nextLink` pages until a `@odata.deltaLink` closes the round.
 *   - calendar via `/me/calendarView` (bounded window => SERVER-SIDE recurrence
 *     expansion; each instance carries `seriesMasterId`) plus `/me/calendarView/delta`
 *     for steady state. Masters are fetched via `/me/events/{seriesMasterId}` and their
 *     `recurrence` object translated to an RFC 5545 RRULE (docs/15 §5.5).
 *   - the DOCUMENTED delta-page dedupe guard (docs/15 §5.5): a calendarView/delta
 *     instance whose start lands on a page boundary can repeat across nextLink pages,
 *     so we upsert on `(seriesMasterId|id, occurrence start)` — a repeat in one cycle
 *     is a no-op.
 *
 * NO webhooks/subscriptions anywhere (docs/15 §9): polling only.
 */

import type { ClassifiedAccount } from "../model.js";
import { TapKind } from "../model.js";
import { getAccessToken } from "../auth/graph-oauth.js";
import { RECURRENCE_WINDOW, BACKFILL_HORIZON_DAYS } from "../config.js";
import { log } from "../log.js";
import type { NormalizedItem, TapItemBatch } from "./types.js";

const GRAPH = "https://graph.microsoft.com/v1.0";

interface GraphMessage {
  id: string;
  internetMessageId?: string;
  subject?: string;
  body?: { content?: string; contentType?: string };
  bodyPreview?: string;
  from?: { emailAddress?: { address?: string; name?: string } };
  toRecipients?: { emailAddress?: { address?: string } }[];
  receivedDateTime?: string;
  sentDateTime?: string;
  isRead?: boolean;
  parentFolderId?: string;
  "@removed"?: { reason: string };
}

interface GraphEvent {
  id: string;
  iCalUId?: string;
  seriesMasterId?: string;
  subject?: string;
  body?: { content?: string };
  location?: { displayName?: string };
  organizer?: { emailAddress?: { address?: string } };
  start?: { dateTime?: string; timeZone?: string };
  end?: { dateTime?: string; timeZone?: string };
  isAllDay?: boolean;
  type?: string; // 'singleInstance' | 'occurrence' | 'exception' | 'seriesMaster'
  recurrence?: GraphRecurrence;
  "@removed"?: { reason: string };
}

interface GraphRecurrence {
  pattern?: {
    type?: string; // daily|weekly|absoluteMonthly|relativeMonthly|absoluteYearly|relativeYearly
    interval?: number;
    daysOfWeek?: string[];
  };
  range?: {
    type?: string; // endDate|noEnd|numbered
    endDate?: string;
    numberOfOccurrences?: number;
  };
}

async function authHeader(account: ClassifiedAccount): Promise<Record<string, string>> {
  const tok = await getAccessToken(account);
  if (!tok.ok) throw new GraphError(tok.error);
  return { authorization: `Bearer ${tok.accessToken}`, accept: "application/json" };
}

export class GraphError extends Error {
  constructor(
    public readonly code: string,
    public readonly retryAfterMs?: number,
  ) {
    super(code);
    this.name = "GraphError";
  }
}

async function graphGet<T>(url: string, headers: Record<string, string>): Promise<T> {
  const res = await fetch(url, { headers });
  if (res.status === 429 || res.status === 503) {
    const retry = Number(res.headers.get("retry-after") ?? "30") * 1000;
    throw new GraphError("rate_limited", retry);
  }
  if (res.status === 401) throw new GraphError("auth_expired");
  if (!res.ok) throw new GraphError(`graph_http_${res.status}`);
  return (await res.json()) as T;
}

interface DeltaPage<T> {
  value: T[];
  "@odata.nextLink"?: string;
  "@odata.deltaLink"?: string;
}

/**
 * Fetch one mail sync round. `cursor` is a Graph deltaLink (or null for backfill).
 * Returns a batch plus the next deltaLink to persist AFTER items commit (docs/05).
 */
export async function syncMail(
  account: ClassifiedAccount,
  cursor: string | null,
): Promise<TapItemBatch> {
  const headers = await authHeader(account);
  let url =
    cursor ??
    `${GRAPH}/me/messages/delta?$select=id,internetMessageId,subject,body,from,toRecipients,receivedDateTime,sentDateTime,isRead,parentFolderId`;

  const items: NormalizedItem[] = [];
  let nextDelta: string | null = cursor;
  let hasMore = false;
  // Follow nextLink pages within this call up to a soft page budget, then yield.
  for (let page = 0; page < 20; page++) {
    const data = await graphGet<DeltaPage<GraphMessage>>(url, headers);
    for (const msg of data.value) items.push(mapMessage(msg));
    if (data["@odata.nextLink"]) {
      url = data["@odata.nextLink"];
      hasMore = true;
      continue;
    }
    if (data["@odata.deltaLink"]) nextDelta = data["@odata.deltaLink"];
    hasMore = false;
    break;
  }
  return { items, nextCursor: nextDelta, hasMore, cursorType: "delta_link" };
}

function mapMessage(msg: GraphMessage): NormalizedItem {
  if (msg["@removed"]) {
    return {
      type: "email",
      externalId: msg.id,
      tap: TapKind.GRAPH,
      canonicalKey: msg.internetMessageId ?? msg.id,
      isDeleted: true,
      rawIdentifiers: { id: msg.id, internetMessageId: msg.internetMessageId ?? null },
    };
  }
  const occurredAt = toEpoch(msg.receivedDateTime ?? msg.sentDateTime);
  return {
    type: "email",
    externalId: msg.id,
    tap: TapKind.GRAPH,
    canonicalKey: msg.internetMessageId ?? msg.id,
    title: msg.subject ?? "",
    body: msg.body?.content ?? msg.bodyPreview ?? "",
    bodyFormat: msg.body?.contentType?.toLowerCase() === "html" ? "html" : "text",
    occurredAt,
    rawIdentifiers: { id: msg.id, internetMessageId: msg.internetMessageId ?? null },
    domainFields: {
      message_id: msg.internetMessageId ?? msg.id,
      from_address: msg.from?.emailAddress?.address ?? null,
      from_name: msg.from?.emailAddress?.name ?? null,
      to_addresses: (msg.toRecipients ?? []).map((r) => r.emailAddress?.address).filter(Boolean),
      folder: msg.parentFolderId ?? "Inbox",
      is_read: Boolean(msg.isRead),
    },
  };
}

/**
 * Fetch one calendar sync round via calendarView(+delta). `cursor` is a deltaLink or
 * null for the initial windowed backfill. Applies the §5.5 page-boundary dedupe guard
 * and resolves each series master's recurrence into an RRULE master item.
 */
export async function syncCalendar(
  account: ClassifiedAccount,
  cursor: string | null,
): Promise<TapItemBatch> {
  const headers = await authHeader(account);
  const now = Date.now();
  const startWindow = new Date(now - RECURRENCE_WINDOW.pastDays * 86_400_000).toISOString();
  const endWindow = new Date(now + RECURRENCE_WINDOW.futureDays * 86_400_000).toISOString();

  let url =
    cursor ??
    `${GRAPH}/me/calendarView/delta?startDateTime=${encodeURIComponent(startWindow)}&endDateTime=${encodeURIComponent(endWindow)}`;

  const items: NormalizedItem[] = [];
  // §5.5 guard: dedupe on (seriesMasterId|id, occurrence start) within this poll cycle.
  const seenOccurrences = new Set<string>();
  const masterIds = new Set<string>();
  let nextDelta: string | null = cursor;
  let hasMore = false;

  for (let page = 0; page < 20; page++) {
    const data = await graphGet<DeltaPage<GraphEvent>>(url, headers);
    for (const ev of data.value) {
      if (ev["@removed"]) {
        items.push({
          type: "event",
          externalId: ev.id,
          tap: TapKind.GRAPH,
          canonicalKey: ev.iCalUId ?? ev.id,
          isDeleted: true,
          rawIdentifiers: { id: ev.id, seriesMasterId: ev.seriesMasterId ?? null },
        });
        continue;
      }
      if (ev.type === "seriesMaster") {
        masterIds.add(ev.id);
        items.push(mapMaster(ev));
        continue;
      }
      const occStart = ev.start?.dateTime ?? "";
      const dedupeKey = `${ev.seriesMasterId ?? ev.id}|${occStart}`;
      if (seenOccurrences.has(dedupeKey)) continue; // page-boundary repeat => no-op
      seenOccurrences.add(dedupeKey);
      if (ev.seriesMasterId) masterIds.add(ev.seriesMasterId);
      items.push(mapInstance(ev));
    }
    if (data["@odata.nextLink"]) {
      url = data["@odata.nextLink"];
      hasMore = true;
      continue;
    }
    if (data["@odata.deltaLink"]) nextDelta = data["@odata.deltaLink"];
    hasMore = false;
    break;
  }

  // Fetch any masters referenced by instances but not seen inline this round.
  for (const masterId of masterIds) {
    if (items.some((i) => i.type === "event_master" && i.externalId === masterId)) continue;
    try {
      const master = await graphGet<GraphEvent>(`${GRAPH}/me/events/${masterId}`, headers);
      items.push(mapMaster(master));
    } catch (err) {
      log.debug("series master fetch failed", { masterId, err: String(err) });
    }
  }

  return { items, nextCursor: nextDelta, hasMore, cursorType: "delta_link" };
}

function mapInstance(ev: GraphEvent): NormalizedItem {
  return {
    type: "event",
    externalId: ev.id,
    tap: TapKind.GRAPH,
    canonicalKey: ev.iCalUId ?? ev.id,
    title: ev.subject ?? "",
    body: ev.body?.content ?? "",
    occurredAt: toEpoch(ev.start?.dateTime),
    rawIdentifiers: { id: ev.id, seriesMasterId: ev.seriesMasterId ?? null, iCalUId: ev.iCalUId ?? null },
    domainFields: {
      calendar_uid: ev.iCalUId ?? ev.id,
      recurrence_master_external_id: ev.seriesMasterId ?? null,
      start_at: toEpoch(ev.start?.dateTime),
      end_at: toEpoch(ev.end?.dateTime),
      all_day: Boolean(ev.isAllDay),
      location: ev.location?.displayName ?? null,
      organizer_email: ev.organizer?.emailAddress?.address ?? null,
    },
  };
}

function mapMaster(ev: GraphEvent): NormalizedItem {
  return {
    type: "event_master",
    externalId: ev.id,
    tap: TapKind.GRAPH,
    canonicalKey: ev.iCalUId ?? ev.id,
    title: ev.subject ?? "",
    body: ev.body?.content ?? "",
    occurredAt: toEpoch(ev.start?.dateTime),
    rawIdentifiers: { id: ev.id, iCalUId: ev.iCalUId ?? null },
    domainFields: {
      calendar_uid: ev.iCalUId ?? ev.id,
      recurrence_rule: ev.recurrence ? graphRecurrenceToRRule(ev.recurrence) : null,
      recurrence_master_external_id: null,
      start_at: toEpoch(ev.start?.dateTime),
      end_at: toEpoch(ev.end?.dateTime),
      all_day: Boolean(ev.isAllDay),
      location: ev.location?.displayName ?? null,
      organizer_email: ev.organizer?.emailAddress?.address ?? null,
    },
  };
}

/** Deterministically translate a Graph recurrence object to an RFC 5545 RRULE (§5.5). */
export function graphRecurrenceToRRule(rec: GraphRecurrence): string | null {
  const p = rec.pattern;
  if (!p?.type) return null;
  const freqMap: Record<string, string> = {
    daily: "DAILY",
    weekly: "WEEKLY",
    absolutemonthly: "MONTHLY",
    relativemonthly: "MONTHLY",
    absoluteyearly: "YEARLY",
    relativeyearly: "YEARLY",
  };
  const freq = freqMap[p.type.toLowerCase()];
  if (!freq) return null;
  const parts = [`FREQ=${freq}`, `INTERVAL=${p.interval ?? 1}`];
  if (p.daysOfWeek?.length) {
    const days = p.daysOfWeek
      .map((d) => d.slice(0, 2).toUpperCase())
      .join(",");
    parts.push(`BYDAY=${days}`);
  }
  const range = rec.range;
  if (range?.type === "numbered" && range.numberOfOccurrences) {
    parts.push(`COUNT=${range.numberOfOccurrences}`);
  } else if (range?.type === "endDate" && range.endDate) {
    parts.push(`UNTIL=${range.endDate.replace(/[-:]/g, "").slice(0, 8)}T000000Z`);
  }
  return parts.join(";");
}

function toEpoch(dt: string | undefined): number | undefined {
  if (!dt) return undefined;
  // Graph returns local-to-timeZone strings without a trailing Z; treat as UTC-ish.
  const t = Date.parse(dt.endsWith("Z") ? dt : `${dt}Z`);
  return Number.isFinite(t) ? t : undefined;
}

/** Horizon marker for backfill (Graph delta backfills naturally from null). */
export const GRAPH_BACKFILL_HORIZON_MS = Date.now() - BACKFILL_HORIZON_DAYS * 86_400_000;
