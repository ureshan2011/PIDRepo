/**
 * Tap selection with fallbacks (docs/15 §3.4) — the heart of the design.
 *
 * `chooseTap` is a faithful transcription of the pseudocode's switch, including EVERY
 * fallback branch (AADSTS90094 -> COM, POP structural COM requirement, on-prem
 * EWS/COM chain) and the cross-cutting New-Outlook overlay that vetoes COM when
 * Classic Outlook is not installed. Probes are injected so the selector is pure and
 * testable; the defaults wire up the real Graph/IMAP/CalDAV/EWS/COM probes.
 */

import {
  AccountFlavor,
  OutlookFlavor,
  TapKind,
  type AuthProbeResult,
  type ClassifiedAccount,
  type TapDecision,
} from "./model.js";
import { hasLiveMapiProfile } from "./accounts.js";
import { tryGraphAuth } from "./auth/graph-oauth.js";
import { tryImapAuth } from "./auth/imap-oauth.js";
import { probeCalDav } from "./taps/caldav.js";
import { probeOnPremEws } from "./taps/ews.js";
import { log } from "./log.js";

export interface TapSelectorDeps {
  tryGraphAuth: (account: ClassifiedAccount) => Promise<AuthProbeResult>;
  tryImapAuth: (
    account: ClassifiedAccount,
    opts: { preferOAuth: boolean; fallback: "app_password" | null },
  ) => Promise<AuthProbeResult>;
  probeCalDav: (account: ClassifiedAccount) => Promise<{ found: boolean }>;
  probeOnPremEws: (account: ClassifiedAccount) => Promise<{ reachable: boolean }>;
  hasLiveMapiProfile: (
    account: ClassifiedAccount,
    flavors: Set<OutlookFlavor>,
  ) => Promise<boolean>;
}

const defaultDeps: TapSelectorDeps = {
  tryGraphAuth,
  tryImapAuth,
  probeCalDav,
  probeOnPremEws,
  hasLiveMapiProfile,
};

export async function chooseTap(
  account: ClassifiedAccount,
  flavors: Set<OutlookFlavor>,
  deps: TapSelectorDeps = defaultDeps,
): Promise<TapDecision> {
  const decision = await evaluate(account, flavors, deps);

  // Cross-cutting New-Outlook overlay (docs/15 §3.4): COM is categorically impossible
  // when Classic Outlook is not installed — nothing for Redemption to log into.
  if (
    (decision.mail === TapKind.COM || decision.calendar === TapKind.COM) &&
    !flavors.has(OutlookFlavor.CLASSIC_OUTLOOK)
  ) {
    return {
      mail: TapKind.NONE,
      calendar: TapKind.NONE,
      status: "tap_unavailable",
      reason: "Account only resolvable via COM, but Classic Outlook is not installed",
    };
  }

  log.info("tap decision", {
    account: account.address ?? account.upn,
    flavor: account.flavor,
    mail: decision.mail,
    calendar: decision.calendar,
    status: decision.status,
    reason: decision.reason,
  });
  return decision;
}

async function evaluate(
  account: ClassifiedAccount,
  flavors: Set<OutlookFlavor>,
  deps: TapSelectorDeps,
): Promise<TapDecision> {
  switch (account.flavor) {
    case AccountFlavor.EXO_ORG: {
      const result = await deps.tryGraphAuth(account);
      if (result.ok) {
        return { mail: TapKind.GRAPH, calendar: TapKind.GRAPH, status: "ok" };
      }
      if (result.error === "AADSTS90094") {
        // Tenant admin-consent wall.
        if (
          flavors.has(OutlookFlavor.CLASSIC_OUTLOOK) &&
          (await deps.hasLiveMapiProfile(account, flavors))
        ) {
          return {
            mail: TapKind.COM,
            calendar: TapKind.COM,
            status: "ok",
            reason: "AADSTS90094 fallback to Classic Outlook COM",
          };
        }
        return {
          mail: TapKind.NONE,
          calendar: TapKind.NONE,
          status: "needs_consent",
          reason: "Tenant admin consent required for Mail.Read/Calendars.Read",
        };
      }
      return {
        mail: TapKind.NONE,
        calendar: TapKind.NONE,
        status: "auth_failed",
        reason: result.error,
      };
    }

    case AccountFlavor.PERSONAL_MSA: {
      // Consumer consent is fully self-service — no tenant admin wall is possible.
      const result = await deps.tryGraphAuth(account);
      if (result.ok) return { mail: TapKind.GRAPH, calendar: TapKind.GRAPH, status: "ok" };
      return {
        mail: TapKind.NONE,
        calendar: TapKind.NONE,
        status: "auth_failed",
        reason: result.error,
      };
    }

    case AccountFlavor.GMAIL_IMAP: {
      // NEVER via New Outlook's local cache (docs/15 §8.3 privacy inversion) — tap Google directly.
      const imap = await deps.tryImapAuth(account, { preferOAuth: true, fallback: "app_password" });
      if (!imap.ok) {
        return { mail: TapKind.NONE, calendar: TapKind.NONE, status: "auth_failed", reason: imap.error };
      }
      const calDav = await deps.probeCalDav(account);
      return {
        mail: TapKind.IMAP,
        calendar: calDav.found ? TapKind.CALDAV : TapKind.NONE,
        status: "ok",
      };
    }

    case AccountFlavor.OTHER_IMAP: {
      const imap = await deps.tryImapAuth(account, { preferOAuth: true, fallback: "app_password" });
      if (!imap.ok) {
        return { mail: TapKind.NONE, calendar: TapKind.NONE, status: "auth_failed", reason: imap.error };
      }
      const calDav = await deps.probeCalDav(account);
      return {
        mail: TapKind.IMAP,
        calendar: calDav.found ? TapKind.CALDAV : TapKind.NONE,
        status: "ok",
        reason: calDav.found ? undefined : "No CalDAV discovered; mail only",
      };
    }

    case AccountFlavor.POP_PST: {
      // Structurally necessary: POP has no cloud calendar tap at all (docs/15 §3.4).
      if (
        !flavors.has(OutlookFlavor.CLASSIC_OUTLOOK) ||
        !(await deps.hasLiveMapiProfile(account, flavors))
      ) {
        return {
          mail: TapKind.NONE,
          calendar: TapKind.NONE,
          status: "tap_unavailable",
          reason: "POP account requires Classic Outlook (COM); none available",
        };
      }
      return { mail: TapKind.COM, calendar: TapKind.COM, status: "ok", mandatory: true };
    }

    case AccountFlavor.ON_PREM_EXCH: {
      const hybrid = await deps.tryGraphAuth(account); // works if hybrid modern auth configured
      if (hybrid.ok) return { mail: TapKind.GRAPH, calendar: TapKind.GRAPH, status: "ok" };
      const onPremEws = await deps.probeOnPremEws(account); // on-prem EWS is NOT sunsetting
      if (onPremEws.reachable) {
        return { mail: TapKind.EWS_ONPREM, calendar: TapKind.EWS_ONPREM, status: "ok" };
      }
      if (
        flavors.has(OutlookFlavor.CLASSIC_OUTLOOK) &&
        (await deps.hasLiveMapiProfile(account, flavors))
      ) {
        return { mail: TapKind.COM, calendar: TapKind.COM, status: "ok" };
      }
      return {
        mail: TapKind.NONE,
        calendar: TapKind.NONE,
        status: "tap_unavailable",
        reason: "No Graph hybrid, no on-prem EWS, no Classic Outlook profile",
      };
    }

    default:
      return {
        mail: TapKind.NONE,
        calendar: TapKind.NONE,
        status: "tap_unavailable",
        reason: "Unclassifiable account",
      };
  }
}
