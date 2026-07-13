/**
 * Redemption RDO (Extended MAPI) store logon + COM tap (docs/15 §3.2, §3.4, §5.5).
 *
 * This is the ONLY local-mailbox read path in the design: NOT raw COM Automation
 * (the Object Model Guard is deliberately avoided, docs/15 §9), NOT .ost/.pst
 * scraping, NOT the New-Outlook cache. We drive the Dimastr Redemption library's RDO
 * object model through `winax` (late-bound COM). The Guard does not police Redemption,
 * so `RDOSession.LogonWithProfile` raises no security prompt and needs no admin rights
 * (docs/15 §3.2). Requires Classic Outlook installed with a loaded MAPI profile and an
 * interactive desktop session (docs/15 §6.3) — hence Windows-only, user-validated.
 *
 * Native `winax` is imported lazily so Linux typecheck/install (where the
 * optionalDependency is skipped) is unaffected. Every Redemption member called below
 * is cited to docs/15 §5.1 / §5.5; where an exact signature is uncertain it is noted.
 */

import { assertWindows } from "./native.js";
import { RECURRENCE_WINDOW } from "../config.js";
import { log } from "../log.js";

/** Native identifiers for a MAPI item (docs/15 §5.1). */
export interface MapiIdentifiers {
  entryId: string;
  storeId: string;
  /** PR_SEARCH_KEY — more move-resistant than EntryID (docs/15 §5.1). */
  searchKey: string;
}

export interface RedemptionStore {
  storeId: string;
  displayName: string;
  /** RDOStore.ExchangeMailboxType — "Exchange" | "IMAP" | "POP3" | null (docs/15 §3.2). */
  accountType: "Exchange" | "IMAP" | "POP3" | null;
  serverHost: string | null;
  /** Opaque handle to the live RDOStore COM object. */
  handle: unknown;
}

export interface RedemptionMail {
  ids: MapiIdentifiers;
  /** RFC 5322 Message-ID header (canonical cross-tap key, docs/15 §5.2). */
  messageId: string | null;
  subject: string;
  bodyText: string;
  fromAddress: string | null;
  fromName: string | null;
  toAddresses: string[];
  folder: string;
  isRead: boolean;
  sentAt: number | null;
  isDeleted?: boolean;
}

export interface RedemptionRecurrenceMaster {
  ids: MapiIdentifiers;
  calendarUid: string;
  subject: string;
  bodyText: string;
  location: string | null;
  organizerEmail: string | null;
  /** RFC 5545 RRULE derived from GetRecurrencePattern() (docs/15 §5.5). */
  rrule: string | null;
  startAt: number;
  endAt: number | null;
}

export interface RedemptionEventInstance {
  ids: MapiIdentifiers;
  calendarUid: string;
  masterUid: string | null;
  subject: string;
  bodyText: string;
  location: string | null;
  organizerEmail: string | null;
  startAt: number;
  endAt: number | null;
  isAllDay: boolean;
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Com = any;

/** Lazily load winax. Throws WindowsOnlyError off-Windows before the import runs. */
async function loadWinax(): Promise<typeof import("winax")> {
  assertWindows("Redemption/COM tap");
  return import("winax");
}

/**
 * Log on to the default MAPI profile with Redemption and return a live RDOSession.
 * docs/15 §3.2: `Redemption.RDOSession.LogonWithProfile(defaultProfile)` — no prompts.
 */
export async function logonDefaultProfile(): Promise<Com> {
  const winax = await loadWinax();
  const session: Com = new winax.Object("Redemption.RDOSession");
  // Empty profile name => the default Outlook profile; no dialog, no new session.
  // (NewSession=false, ShowDialog=false — the documented no-prompt overload.)
  session.LogonWithProfile("", "", false, false);
  return session;
}

/** Enumerate the session's stores as candidate accounts (docs/15 §3.2). */
export async function enumerateStores(session: Com): Promise<RedemptionStore[]> {
  const stores: RedemptionStore[] = [];
  const collection: Com = session.Stores;
  const count: number = collection.Count;
  for (let i = 1; i <= count; i++) {
    // RDOStores is 1-based (MAPI convention).
    const store: Com = collection.Item(i);
    stores.push({
      storeId: String(store.StoreID),
      displayName: String(store.Name ?? store.DisplayName ?? ""),
      accountType: normalizeMailboxType(store.ExchangeMailboxType),
      serverHost: safeString(store.ServerName),
      handle: store,
    });
  }
  return stores;
}

function normalizeMailboxType(v: unknown): "Exchange" | "IMAP" | "POP3" | null {
  const s = safeString(v);
  if (!s) return null;
  if (/exchange/i.test(s)) return "Exchange";
  if (/imap/i.test(s)) return "IMAP";
  if (/pop/i.test(s)) return "POP3";
  return null;
}

function safeString(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  const s = String(v);
  return s.length ? s : null;
}

/**
 * Read mail from a store's inbox subtree changed since `sinceMs` (0 => full backfill).
 * Uses `RDOFolder.Items` with `Sort("[ReceivedTime]", true)` then a bounded
 * `Restrict("[ReceivedTime] >= ...")`. EntryID + StoreID + PR_SEARCH_KEY are captured
 * per item (docs/15 §5.1). `Message-ID` comes from PR_INTERNET_MESSAGE_ID
 * (0x1035001F) via `item.Fields[...]` — the move-resistant canonical key (§5.2).
 */
export async function readMail(
  store: RedemptionStore,
  sinceMs: number,
  limit = 500,
): Promise<RedemptionMail[]> {
  const rdoStore = store.handle as Com;
  const inbox: Com = rdoStore.IPMRootFolder; // walk the IPM subtree from the root
  const out: RedemptionMail[] = [];
  collectMailFromFolder(inbox, sinceMs, limit, out);
  return out;
}

const PR_INTERNET_MESSAGE_ID = 0x1035001f;
const PR_SEARCH_KEY = 0x300b0102;

function collectMailFromFolder(folder: Com, sinceMs: number, limit: number, out: RedemptionMail[]): void {
  if (out.length >= limit) return;
  try {
    const items: Com = folder.Items;
    items.Sort("[ReceivedTime]", true); // desc; required before bounded reads
    if (sinceMs > 0) {
      const restrict = `[ReceivedTime] >= '${formatMapiDate(sinceMs)}'`;
      items.Restrict(restrict);
    }
    const count: number = items.Count;
    for (let i = 1; i <= count && out.length < limit; i++) {
      const item: Com = items.Item(i);
      if (item.MessageClass && !String(item.MessageClass).startsWith("IPM.Note")) continue;
      out.push(mapMail(item, String(folder.Name ?? "")));
    }
  } catch (err) {
    log.debug("folder mail read skipped", { err: String(err) });
  }
  // Recurse subfolders (bounded by the overall `limit`).
  try {
    const subs: Com = folder.Folders;
    const c: number = subs.Count;
    for (let i = 1; i <= c && out.length < limit; i++) {
      collectMailFromFolder(subs.Item(i), sinceMs, limit, out);
    }
  } catch {
    /* leaf folder */
  }
}

function mapMail(item: Com, folderName: string): RedemptionMail {
  const recipients: string[] = [];
  try {
    const recips: Com = item.Recipients;
    const rc: number = recips.Count;
    for (let i = 1; i <= rc; i++) {
      const addr = safeString(recips.Item(i).SMTPAddress ?? recips.Item(i).Address);
      if (addr) recipients.push(addr);
    }
  } catch {
    /* no recipients accessible */
  }
  return {
    ids: readIds(item),
    messageId: readNamedField(item, PR_INTERNET_MESSAGE_ID),
    subject: safeString(item.Subject) ?? "",
    bodyText: safeString(item.Body) ?? "",
    fromAddress: safeString(item.SenderEmailAddress),
    fromName: safeString(item.SenderName),
    toAddresses: recipients,
    folder: folderName,
    isRead: Boolean(item.UnRead) === false,
    sentAt: toEpoch(item.SentOn ?? item.ReceivedTime),
  };
}

/**
 * Read calendar with IncludeRecurrences expansion (docs/15 §5.5): after `Sort("[Start]")`
 * and a bounded `Restrict("[Start] >= ? AND [Start] <= ?")`, set `IncludeRecurrences=true`.
 * Returns each master (from `GetRecurrencePattern()` -> RRULE) plus its windowed instances.
 */
export async function readCalendar(
  store: RedemptionStore,
  windowStartMs = Date.now() - RECURRENCE_WINDOW.pastDays * 86_400_000,
  windowEndMs = Date.now() + RECURRENCE_WINDOW.futureDays * 86_400_000,
  limit = 2000,
): Promise<{ masters: RedemptionRecurrenceMaster[]; instances: RedemptionEventInstance[] }> {
  const rdoStore = store.handle as Com;
  const masters: RedemptionRecurrenceMaster[] = [];
  const instances: RedemptionEventInstance[] = [];
  try {
    const calendar: Com = rdoStore.GetDefaultFolder(9); // 9 = olFolderCalendar
    const items: Com = calendar.Items;
    // docs/15 §5.5: sort by [Start] BEFORE enabling IncludeRecurrences, then bound.
    items.Sort("[Start]", false);
    items.IncludeRecurrences = true;
    items.Restrict(
      `[Start] >= '${formatMapiDate(windowStartMs)}' AND [Start] <= '${formatMapiDate(windowEndMs)}'`,
    );
    const seenMasters = new Set<string>();
    const count: number = items.Count;
    for (let i = 1; i <= count && instances.length < limit; i++) {
      const appt: Com = items.Item(i);
      const uid = readCalendarUid(appt);
      const isRecurring = Boolean(appt.IsRecurring);
      if (isRecurring) {
        const master = readMaster(appt);
        if (master && !seenMasters.has(master.calendarUid)) {
          seenMasters.add(master.calendarUid);
          masters.push(master);
        }
        instances.push(mapInstance(appt, uid, master?.calendarUid ?? null));
      } else {
        instances.push(mapInstance(appt, uid, null));
      }
    }
  } catch (err) {
    log.debug("calendar read skipped", { store: store.displayName, err: String(err) });
  }
  return { masters, instances };
}

function readMaster(appt: Com): RedemptionRecurrenceMaster | null {
  try {
    const pattern: Com = appt.GetRecurrencePattern();
    const rrule = recurrencePatternToRRule(pattern);
    return {
      ids: readIds(appt),
      calendarUid: readCalendarUid(appt),
      subject: safeString(appt.Subject) ?? "",
      bodyText: safeString(appt.Body) ?? "",
      location: safeString(appt.Location),
      organizerEmail: safeString(appt.Organizer),
      rrule,
      startAt: toEpoch(appt.Start) ?? Date.now(),
      endAt: toEpoch(appt.End),
    };
  } catch {
    return null;
  }
}

/**
 * Translate an RDORecurrencePattern into an RFC 5545 RRULE (docs/15 §5.5: interval,
 * day-of-week mask, start/end/no-end). Exceptions in the pattern become their own
 * windowed instance rows upstream; here we emit only the master rule.
 */
function recurrencePatternToRRule(pattern: Com): string | null {
  try {
    // RecurrenceType: 0=Daily 1=Weekly 2=Monthly 3=MonthNth 5=Yearly 6=YearNth (Outlook enum).
    const type: number = Number(pattern.RecurrenceType);
    const interval: number = Number(pattern.Interval) || 1;
    const freq = ["DAILY", "WEEKLY", "MONTHLY", "MONTHLY", "", "YEARLY", "YEARLY"][type] ?? "DAILY";
    const parts = [`FREQ=${freq}`, `INTERVAL=${interval}`];
    if (type === 1) {
      const mask: number = Number(pattern.DayOfWeekMask);
      const days = maskToByday(mask);
      if (days) parts.push(`BYDAY=${days}`);
    }
    if (!pattern.NoEndDate) {
      const occ = Number(pattern.Occurrences);
      if (occ > 0) parts.push(`COUNT=${occ}`);
      else {
        const until = toEpoch(pattern.PatternEndDate);
        if (until) parts.push(`UNTIL=${toRRuleDate(until)}`);
      }
    }
    return parts.join(";");
  } catch {
    return null;
  }
}

function maskToByday(mask: number): string {
  // Outlook OlDaysOfWeek bit flags: Su1 Mo2 Tu4 We8 Th16 Fr32 Sa64.
  const map: [number, string][] = [
    [1, "SU"],
    [2, "MO"],
    [4, "TU"],
    [8, "WE"],
    [16, "TH"],
    [32, "FR"],
    [64, "SA"],
  ];
  return map
    .filter(([bit]) => (mask & bit) !== 0)
    .map(([, d]) => d)
    .join(",");
}

function mapInstance(appt: Com, uid: string, masterUid: string | null): RedemptionEventInstance {
  return {
    ids: readIds(appt),
    calendarUid: uid,
    masterUid,
    subject: safeString(appt.Subject) ?? "",
    bodyText: safeString(appt.Body) ?? "",
    location: safeString(appt.Location),
    organizerEmail: safeString(appt.Organizer),
    startAt: toEpoch(appt.Start) ?? Date.now(),
    endAt: toEpoch(appt.End),
    isAllDay: Boolean(appt.AllDayEvent),
  };
}

function readIds(item: Com): MapiIdentifiers {
  return {
    entryId: String(item.EntryID),
    storeId: safeString(item.Parent?.StoreID) ?? "",
    searchKey: readNamedField(item, PR_SEARCH_KEY) ?? "",
  };
}

/** Read a MAPI property tag via Redemption's `Fields[tag]` accessor (docs/15 §5.1). */
function readNamedField(item: Com, tag: number): string | null {
  try {
    const v = item.Fields(tag);
    return safeString(v);
  } catch {
    return null;
  }
}

/** Read the iCal UID (calendar_uid, docs/15 §5.2). Redemption exposes `GlobalAppointmentID`. */
function readCalendarUid(appt: Com): string {
  return safeString(appt.GlobalAppointmentID) ?? String(appt.EntryID);
}

function toEpoch(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  const d = v instanceof Date ? v : new Date(String(v));
  const t = d.getTime();
  return Number.isFinite(t) ? t : null;
}

/** MAPI Restrict() date literal, e.g. "07/13/2026 00:00". */
function formatMapiDate(ms: number): string {
  const d = new Date(ms);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${pad(d.getMonth() + 1)}/${pad(d.getDate())}/${d.getFullYear()} ${pad(d.getHours())}:${pad(d.getMinutes())}`;
}

/** RFC 5545 UTC date-time, e.g. 20260713T000000Z. */
function toRRuleDate(ms: number): string {
  return new Date(ms).toISOString().replace(/[-:]/g, "").replace(/\.\d{3}/, "");
}

/** Release the session/log off cleanly. */
export async function logoff(session: Com): Promise<void> {
  try {
    session?.Logoff?.();
  } catch {
    /* best effort */
  }
}
