/**
 * Tap dispatcher — routes a (resource, tap) to the concrete tap implementation.
 *
 * Keeps the engines (backfill/incremental) tap-agnostic: they ask for "the next batch
 * for this account/resource/tap given this cursor" and the dispatcher picks graph /
 * imap / caldav / com. EWS_ONPREM has no steady-state reader in the primary tap set
 * (docs/15 §9 / taps/ews.ts) — it returns an empty parked batch so the account is
 * surfaced, never silently dropped.
 */

import type { ClassifiedAccount } from "../model.js";
import { TapKind } from "../model.js";
import type { ResourceKind, TapItemBatch } from "./types.js";
import * as graph from "./graph.js";
import * as imap from "./imap.js";
import * as caldav from "./caldav.js";
import * as com from "./com.js";
import { log } from "../log.js";

export async function runTap(
  account: ClassifiedAccount,
  resource: ResourceKind,
  tap: TapKind,
  cursor: string | null,
): Promise<TapItemBatch> {
  switch (tap) {
    case TapKind.GRAPH:
      return resource === "mail" ? graph.syncMail(account, cursor) : graph.syncCalendar(account, cursor);
    case TapKind.IMAP:
      if (resource === "mail") return imap.syncMail(account, cursor);
      // IMAP has no calendar; calendar rides CALDAV. Empty batch keeps the cursor.
      return { items: [], nextCursor: cursor, hasMore: false, cursorType: "uidvalidity_uid_modseq" };
    case TapKind.CALDAV:
      return caldav.syncCalendar(account, cursor);
    case TapKind.COM:
      return resource === "mail" ? com.syncMail(account, cursor) : com.syncCalendar(account, cursor);
    case TapKind.EWS_ONPREM:
      log.warn("on-prem EWS steady-state reader not implemented; account parked", {
        account: account.address,
        resource,
      });
      return { items: [], nextCursor: cursor, hasMore: false, cursorType: "watermark" };
    default:
      return { items: [], nextCursor: cursor, hasMore: false, cursorType: "watermark" };
  }
}

/** Map a TapKind to its cadence bucket for backoff/staleness (docs/15 §6.4). */
export function cadenceKeyFor(tap: TapKind): "graph" | "imap" | "caldav" | "com" {
  switch (tap) {
    case TapKind.IMAP:
      return "imap";
    case TapKind.CALDAV:
      return "caldav";
    case TapKind.COM:
    case TapKind.EWS_ONPREM:
      return "com";
    default:
      return "graph";
  }
}
