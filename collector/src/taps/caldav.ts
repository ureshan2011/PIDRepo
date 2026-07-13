/**
 * CalDAV tap via tsdav (docs/15 §3.4 calendar branch, §5.5).
 *
 * A CalDAV `calendar-query` REPORT returns raw `VEVENT` components including the
 * `RRULE` directly — NO server-side expansion (docs/15 §5.5). The collector performs
 * its OWN bounded RRULE expansion (engines/recurrence.ts, same rolling window as the
 * Graph case) so all three taps converge on the uniform master-plus-instances shape.
 * Auth is OAuth (Bearer) for Google or Basic (app password) otherwise. `probeCalDav`
 * is the selector's discovery probe; `syncCalendar` produces the batch.
 */

import { createDAVClient } from "tsdav";
import type { ClassifiedAccount } from "../model.js";
import { TapKind } from "../model.js";
import { getImapCredentials } from "../auth/imap-oauth.js";
import { RECURRENCE_WINDOW } from "../config.js";
import { expandRRule, parseICalDate } from "../engines/recurrence.js";
import { log } from "../log.js";
import type { NormalizedItem, TapItemBatch } from "./types.js";

/** Google's modern CalDAV base; other providers supply their own via account.caldavUrl. */
const GOOGLE_CALDAV = "https://apidata.googleusercontent.com/caldav/v2/";

function serverUrlFor(account: ClassifiedAccount): string {
  if (account.caldavUrl) return account.caldavUrl;
  return `${GOOGLE_CALDAV}${encodeURIComponent(account.address ?? "")}/events`;
}

async function makeClient(account: ClassifiedAccount): Promise<ReturnType<typeof createDAVClient> extends Promise<infer T> ? T : never> {
  const creds = await getImapCredentials(account);
  const serverUrl = serverUrlFor(account);
  if (creds.kind === "oauth") {
    return createDAVClient({
      serverUrl,
      credentials: { accessToken: creds.accessToken },
      authMethod: "Oauth",
      defaultAccountType: "caldav",
    });
  }
  if (creds.kind === "password") {
    return createDAVClient({
      serverUrl,
      credentials: { username: creds.user, password: creds.pass },
      authMethod: "Basic",
      defaultAccountType: "caldav",
    });
  }
  throw new Error("no CalDAV credentials");
}

/** Selector probe (docs/15 §3.4): does this account expose a reachable CalDAV calendar? */
export async function probeCalDav(account: ClassifiedAccount): Promise<{ found: boolean }> {
  try {
    const client = await makeClient(account);
    const calendars = await client.fetchCalendars();
    return { found: Array.isArray(calendars) && calendars.length > 0 };
  } catch (err) {
    log.debug("CalDAV probe failed", { account: account.address, err: String(err) });
    return { found: false };
  }
}

/**
 * One calendar sync round. CalDAV has no delta/push standard (docs/15 §6.4: plain
 * 15-min poll), so the cursor is a simple watermark timestamp; each round re-reads the
 * rolling window and re-expands recurrence. Returns masters + expanded instances.
 */
export async function syncCalendar(
  account: ClassifiedAccount,
  _cursor: string | null,
): Promise<TapItemBatch> {
  const now = Date.now();
  const windowStart = now - RECURRENCE_WINDOW.pastDays * 86_400_000;
  const windowEnd = now + RECURRENCE_WINDOW.futureDays * 86_400_000;
  const items: NormalizedItem[] = [];

  try {
    const client = await makeClient(account);
    const calendars = await client.fetchCalendars();
    for (const calendar of calendars) {
      const objects = await client.fetchCalendarObjects({
        calendar,
        timeRange: {
          start: new Date(windowStart).toISOString(),
          end: new Date(windowEnd).toISOString(),
        },
      });
      for (const obj of objects) {
        const ical = typeof obj.data === "string" ? obj.data : "";
        const vevent = parseVEvent(ical);
        if (!vevent) continue;
        emitEvent(items, account, vevent, windowStart, windowEnd);
      }
    }
  } catch (err) {
    log.warn("CalDAV sync failed", { account: account.address, err: String(err) });
  }

  return {
    items,
    nextCursor: String(now),
    hasMore: false,
    cursorType: "watermark",
  };
}

interface VEvent {
  uid: string;
  summary: string;
  description: string;
  location: string | null;
  organizer: string | null;
  dtStart: number;
  dtEnd: number | null;
  rrule: string | null;
  exdates: number[];
}

/** Minimal VEVENT extractor — pulls the fields §5.5 needs; ignores VALARM/VTIMEZONE. */
export function parseVEvent(ical: string): VEvent | null {
  const block = /BEGIN:VEVENT([\s\S]*?)END:VEVENT/.exec(ical);
  if (!block) return null;
  const body = unfold(block[1]!);
  const get = (name: string): string | null => {
    const re = new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "im");
    const m = re.exec(body);
    return m ? m[1]!.trim() : null;
  };
  const dtStart = parseICalDate(stripParams(rawLine(body, "DTSTART")));
  if (dtStart === undefined) return null;
  const exdates: number[] = [];
  for (const line of body.split(/\r?\n/)) {
    if (/^EXDATE/i.test(line)) {
      for (const v of line.split(":")[1]?.split(",") ?? []) {
        const t = parseICalDate(v.trim());
        if (t !== undefined) exdates.push(t);
      }
    }
  }
  return {
    uid: get("UID") ?? `caldav-${dtStart}`,
    summary: get("SUMMARY") ?? "",
    description: get("DESCRIPTION") ?? "",
    location: get("LOCATION"),
    organizer: (get("ORGANIZER") ?? "").replace(/^mailto:/i, "") || null,
    dtStart,
    dtEnd: parseICalDate(stripParams(rawLine(body, "DTEND"))) ?? null,
    rrule: get("RRULE"),
    exdates,
  };
}

function rawLine(body: string, name: string): string | undefined {
  const re = new RegExp(`^${name}(?:;[^:]*)?:(.*)$`, "im");
  const m = re.exec(body);
  return m ? m[1]!.trim() : undefined;
}

function stripParams(value: string | undefined): string | undefined {
  return value;
}

/** Unfold RFC 5545 line continuations (a leading space/tab continues the prior line). */
function unfold(s: string): string {
  return s.replace(/\r?\n[ \t]/g, "");
}

function emitEvent(
  items: NormalizedItem[],
  account: ClassifiedAccount,
  ve: VEvent,
  windowStart: number,
  windowEnd: number,
): void {
  const durationMs = ve.dtEnd ? ve.dtEnd - ve.dtStart : 0;
  const commonDomain = {
    location: ve.location,
    organizer_email: ve.organizer,
  };
  if (ve.rrule) {
    // Master row (recurrence_rule set, recurrence_master_* null) — docs/15 §5.5.
    items.push({
      type: "event_master",
      externalId: ve.uid,
      tap: TapKind.CALDAV,
      canonicalKey: ve.uid,
      title: ve.summary,
      body: ve.description,
      occurredAt: ve.dtStart,
      rawIdentifiers: { uid: ve.uid, href: account.caldavUrl ?? null },
      domainFields: {
        calendar_uid: ve.uid,
        recurrence_rule: ve.rrule,
        recurrence_master_external_id: null,
        start_at: ve.dtStart,
        end_at: ve.dtEnd,
        all_day: false,
        ...commonDomain,
      },
    });
    // Our OWN bounded expansion into windowed instance rows (docs/15 §5.5).
    const instances = expandRRule(ve.rrule, ve.dtStart, durationMs, {
      windowStart,
      windowEnd,
      exdates: ve.exdates,
    });
    let n = 0;
    for (const inst of instances) {
      const instanceUid = `${ve.uid}#${inst.startAt}`;
      items.push({
        type: "event",
        externalId: instanceUid,
        tap: TapKind.CALDAV,
        canonicalKey: instanceUid,
        title: ve.summary,
        body: ve.description,
        occurredAt: inst.startAt,
        rawIdentifiers: { uid: ve.uid, occurrence: inst.startAt },
        domainFields: {
          calendar_uid: instanceUid,
          recurrence_master_external_id: ve.uid,
          recurrence_rule: null,
          start_at: inst.startAt,
          end_at: inst.endAt,
          all_day: false,
          ...commonDomain,
        },
      });
      if (++n >= 2000) break;
    }
  } else {
    // Single event.
    items.push({
      type: "event",
      externalId: ve.uid,
      tap: TapKind.CALDAV,
      canonicalKey: ve.uid,
      title: ve.summary,
      body: ve.description,
      occurredAt: ve.dtStart,
      rawIdentifiers: { uid: ve.uid },
      domainFields: {
        calendar_uid: ve.uid,
        recurrence_master_external_id: null,
        recurrence_rule: null,
        start_at: ve.dtStart,
        end_at: ve.dtEnd,
        all_day: false,
        ...commonDomain,
      },
    });
  }
}
