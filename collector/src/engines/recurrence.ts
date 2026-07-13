/**
 * RRULE expansion helper (docs/15 §5.5 — shared by the CalDAV and IMAP taps).
 *
 * CalDAV returns raw VEVENTs with an `RRULE` directly (no server-side expansion), so
 * the collector performs its OWN bounded expansion here to converge on the uniform
 * master-plus-instances shape the Graph and COM taps produce via server/Redemption
 * expansion. This is a deliberately compact RFC 5545 evaluator covering the common
 * FREQ/INTERVAL/COUNT/UNTIL/BYDAY cases; unrecognized parts degrade to "master only"
 * so an exotic rule is never silently dropped.
 */

import { RECURRENCE_WINDOW } from "../config.js";

export interface ExpandedInstance {
  startAt: number;
  endAt: number | null;
}

interface ParsedRRule {
  freq: "DAILY" | "WEEKLY" | "MONTHLY" | "YEARLY";
  interval: number;
  count?: number;
  until?: number;
  byday?: number[]; // 0=SU..6=SA
}

const DAY_INDEX: Record<string, number> = { SU: 0, MO: 1, TU: 2, WE: 3, TH: 4, FR: 5, SA: 6 };

export function parseRRule(rrule: string): ParsedRRule | null {
  const map = new Map<string, string>();
  for (const part of rrule.replace(/^RRULE:/i, "").split(";")) {
    const [k, v] = part.split("=");
    if (k && v) map.set(k.toUpperCase(), v.toUpperCase());
  }
  const freq = map.get("FREQ");
  if (freq !== "DAILY" && freq !== "WEEKLY" && freq !== "MONTHLY" && freq !== "YEARLY") return null;
  const parsed: ParsedRRule = {
    freq,
    interval: Math.max(1, Number(map.get("INTERVAL") ?? "1") || 1),
  };
  if (map.has("COUNT")) parsed.count = Number(map.get("COUNT"));
  if (map.has("UNTIL")) parsed.until = parseICalDate(map.get("UNTIL"));
  if (map.has("BYDAY")) {
    parsed.byday = map
      .get("BYDAY")!
      .split(",")
      .map((d) => DAY_INDEX[d.replace(/^[+-]?\d/, "")])
      .filter((n): n is number => n !== undefined);
  }
  return parsed;
}

/** Parse an iCal date/datetime (e.g. 20260713T090000Z or 20260713) to epoch ms. */
export function parseICalDate(value: string | undefined): number | undefined {
  if (!value) return undefined;
  const m = /^(\d{4})(\d{2})(\d{2})(?:T(\d{2})(\d{2})(\d{2})(Z)?)?$/.exec(value.trim());
  if (!m) {
    const t = Date.parse(value);
    return Number.isFinite(t) ? t : undefined;
  }
  const [, y, mo, d, hh = "00", mm = "00", ss = "00", z] = m;
  const iso = `${y}-${mo}-${d}T${hh}:${mm}:${ss}${z ? "Z" : "Z"}`;
  const t = Date.parse(iso);
  return Number.isFinite(t) ? t : undefined;
}

/**
 * Expand a master event's RRULE into bounded windowed instances (docs/15 §5.5 rolling
 * window). `durationMs` preserves each instance's length. Caller supplies EXDATEs to
 * subtract. Hard-capped so a runaway rule can't blow memory.
 */
export function expandRRule(
  rrule: string,
  dtStart: number,
  durationMs: number,
  opts: {
    windowStart?: number;
    windowEnd?: number;
    exdates?: number[];
    maxInstances?: number;
  } = {},
): ExpandedInstance[] {
  const parsed = parseRRule(rrule);
  if (!parsed) return []; // master-only fallback (caller keeps the master row)
  const windowStart = opts.windowStart ?? Date.now() - RECURRENCE_WINDOW.pastDays * 86_400_000;
  const windowEnd = opts.windowEnd ?? Date.now() + RECURRENCE_WINDOW.futureDays * 86_400_000;
  const maxInstances = opts.maxInstances ?? 2000;
  const exdates = new Set((opts.exdates ?? []).map((e) => Math.floor(e / 60_000)));

  const out: ExpandedInstance[] = [];
  let cursor = dtStart;
  let emitted = 0;
  let iterations = 0;
  const hardIterationCap = maxInstances * 10;

  while (iterations++ < hardIterationCap) {
    if (parsed.until && cursor > parsed.until) break;
    if (parsed.count && emitted >= parsed.count) break;
    if (cursor > windowEnd) break;

    const candidates = parsed.byday && parsed.freq === "WEEKLY"
      ? weekdayOccurrences(cursor, parsed.byday)
      : [cursor];

    for (const start of candidates) {
      if (parsed.count && emitted >= parsed.count) break;
      if (parsed.until && start > parsed.until) break;
      emitted++; // COUNT counts every occurrence, in or out of window
      if (start < windowStart || start > windowEnd) continue;
      if (exdates.has(Math.floor(start / 60_000))) continue;
      out.push({ startAt: start, endAt: durationMs > 0 ? start + durationMs : null });
      if (out.length >= maxInstances) return out;
    }
    cursor = advance(cursor, parsed);
  }
  return out;
}

function weekdayOccurrences(weekStart: number, byday: number[]): number[] {
  // Emit each requested weekday within the ISO week beginning at `weekStart`'s week.
  const base = new Date(weekStart);
  const sunday = new Date(base);
  sunday.setDate(base.getDate() - base.getDay());
  return byday
    .map((dow) => {
      const d = new Date(sunday);
      d.setDate(sunday.getDate() + dow);
      d.setHours(base.getHours(), base.getMinutes(), base.getSeconds(), 0);
      return d.getTime();
    })
    .sort((a, b) => a - b);
}

function advance(cursor: number, parsed: ParsedRRule): number {
  const d = new Date(cursor);
  switch (parsed.freq) {
    case "DAILY":
      d.setDate(d.getDate() + parsed.interval);
      break;
    case "WEEKLY":
      d.setDate(d.getDate() + 7 * parsed.interval);
      break;
    case "MONTHLY":
      d.setMonth(d.getMonth() + parsed.interval);
      break;
    case "YEARLY":
      d.setFullYear(d.getFullYear() + parsed.interval);
      break;
  }
  return d.getTime();
}
