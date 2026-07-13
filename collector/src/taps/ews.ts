/**
 * On-prem EWS reachability probe (docs/15 §3.4 ON_PREM_EXCH, §9).
 *
 * Cloud (Exchange Online) EWS is sunsetting and is DELIBERATELY not built on (docs/15
 * §9). On-prem EWS is unaffected and remains a legitimate fallback for ON_PREM_EXCH
 * only. This module provides just the selector's reachability probe — it checks that
 * the org's own on-prem EWS endpoint answers — so the tap-selector can prefer it over
 * the COM fallback. A full on-prem EWS steady-state reader is out of scope for the
 * primary taps (graph/imap/caldav/com); when EWS_ONPREM is chosen the engines log that
 * the account is parked pending an on-prem EWS reader, rather than silently dropping it.
 */

import type { ClassifiedAccount } from "../model.js";
import { log } from "../log.js";

function ewsUrlFor(account: ClassifiedAccount): string | null {
  const host = account.serverHost;
  if (!host) return null;
  return `https://${host}/EWS/Exchange.asmx`;
}

/** True if the on-prem EWS endpoint responds (200/401 both count as "reachable"). */
export async function probeOnPremEws(account: ClassifiedAccount): Promise<{ reachable: boolean }> {
  const url = ewsUrlFor(account);
  if (!url) return { reachable: false };
  try {
    // An unauthenticated GET to a live EWS endpoint returns 401 (challenge) — that is
    // still proof the service is reachable. Only a network/DNS failure means "no EWS".
    const res = await fetch(url, { method: "GET" });
    const reachable = res.status === 401 || res.status === 200 || res.status === 403;
    log.debug("on-prem EWS probe", { url, status: res.status, reachable });
    return { reachable };
  } catch (err) {
    log.debug("on-prem EWS unreachable", { url, err: String(err) });
    return { reachable: false };
  }
}
