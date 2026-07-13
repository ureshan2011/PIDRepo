/**
 * Candidate-account enumeration (docs/15 §3.2), classification (§3.3), and the
 * one-time user-configured account store (§3.2 loadUserConfiguredAccounts).
 *
 * `enumerateCandidateAccounts` and `classify` are faithful transcriptions of the
 * pseudocode. Enumeration pulls from three sources — MAPI stores (Classic only, via
 * Redemption), the WAM broker cache, and the persisted setup wizard store — then
 * dedupes by address. Classification resolves each raw account into one of the six
 * AccountFlavors, using an Autodiscover v2 probe to separate EXO_ORG from ON_PREM_EXCH.
 */

import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { z } from "zod";
import { ulid } from "ulid";
import {
  AccountFlavor,
  CONSUMER_TENANT,
  OutlookFlavor,
  type ClassifiedAccount,
  type RawAccount,
} from "./model.js";
import { accountsStorePath } from "./config.js";
import { log } from "./log.js";
import { cachedAccounts } from "./platform/wam.js";
import { logonDefaultProfile, enumerateStores, logoff } from "./platform/redemption.js";

/** Non-secret user-configured account descriptor persisted by the setup wizard. */
const UserAccountSchema = z.object({
  id: z.string(),
  address: z.string(),
  displayName: z.string().optional(),
  accountType: z.enum(["Exchange", "IMAP", "POP3"]).nullable().optional(),
  serverHost: z.string().optional(),
  imapHost: z.string().optional(),
  imapPort: z.number().optional(),
  caldavUrl: z.string().optional(),
  oauthIssuer: z.string().optional(),
  authKind: z.enum(["oauth", "app_password"]).optional(),
  /** Opaque DPAPI reference (docs/15 §8.1). NEVER a secret. */
  tokenRef: z.string().optional(),
});
export type UserAccount = z.infer<typeof UserAccountSchema>;
const UserAccountsFileSchema = z.object({ accounts: z.array(UserAccountSchema) });

/** Load the persisted, non-secret one-time-configured accounts (never re-prompted). */
export function loadUserConfiguredAccounts(): UserAccount[] {
  const path = accountsStorePath();
  if (!existsSync(path)) return [];
  try {
    const parsed = UserAccountsFileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
    return parsed.accounts;
  } catch (err) {
    log.warn("accounts store unreadable/invalid; treating as empty", { err: String(err) });
    return [];
  }
}

/** Persist the account store (used by the setup wizard). tokenRef only — no secrets. */
export function saveUserConfiguredAccounts(accounts: UserAccount[]): void {
  writeFileSync(accountsStorePath(), JSON.stringify({ accounts }, null, 2), "utf8");
}

/** docs/15 §3.2 — enumerate candidates across MAPI + WAM + user-configured, then dedupe. */
export async function enumerateCandidateAccounts(
  flavors: Set<OutlookFlavor>,
): Promise<RawAccount[]> {
  const accounts: RawAccount[] = [];

  if (flavors.has(OutlookFlavor.CLASSIC_OUTLOOK)) {
    // Redemption RDO store logon — NOT raw COM (docs/15 §3.2): no prompts, no admin.
    let session: unknown;
    try {
      session = await logonDefaultProfile();
      const stores = await enumerateStores(session);
      for (const store of stores) {
        accounts.push({
          source: "mapi",
          storeId: store.storeId,
          displayName: store.displayName,
          address: store.displayName, // best-effort; refined by classify/dedupe
          accountType: store.accountType,
          serverHost: store.serverHost ?? undefined,
        });
      }
    } catch (err) {
      log.warn("MAPI enumeration failed; skipping COM candidates", { err: String(err) });
    } finally {
      if (session) await logoff(session);
    }
  }

  // WAM-cached Microsoft identity accounts (both flavors register into the OS broker).
  for (const wa of await cachedAccounts()) {
    accounts.push({ source: "wam", upn: wa.upn, address: wa.upn, tenantId: wa.tenantId });
  }

  // Accounts with no OS-level discovery path (a bare Gmail/IMAP under New Outlook) —
  // added exactly once via the setup wizard, never re-prompted (docs/15 §3.2).
  for (const ua of loadUserConfiguredAccounts()) {
    accounts.push({
      source: "user_configured",
      address: ua.address,
      displayName: ua.displayName,
      accountType: ua.accountType ?? null,
      serverHost: ua.serverHost,
      imapHost: ua.imapHost,
      imapPort: ua.imapPort,
      caldavUrl: ua.caldavUrl,
      oauthIssuer: ua.oauthIssuer,
      authKind: ua.authKind,
    });
  }

  return dedupeByAddress(accounts);
}

/** Collapse candidates that resolve to the same address, preferring richer sources. */
export function dedupeByAddress(accounts: RawAccount[]): RawAccount[] {
  const byKey = new Map<string, RawAccount>();
  const sourceRank: Record<RawAccount["source"], number> = {
    user_configured: 3, // richest (host/oauth/caldav) — highest priority
    wam: 2,
    mapi: 1,
  };
  for (const acc of accounts) {
    const key = (acc.address ?? acc.upn ?? acc.storeId ?? ulid()).toLowerCase();
    const existing = byKey.get(key);
    if (!existing) {
      byKey.set(key, acc);
      continue;
    }
    // Merge: keep the higher-ranked source's fields, filling gaps from the other.
    const primary = sourceRank[acc.source] >= sourceRank[existing.source] ? acc : existing;
    const secondary = primary === acc ? existing : acc;
    byKey.set(key, { ...secondary, ...primary });
  }
  return [...byKey.values()];
}

/** docs/15 §3.3 — classify one raw account into an AccountFlavor. */
export async function classify(account: RawAccount): Promise<AccountFlavor> {
  if (account.accountType === "POP3") {
    return AccountFlavor.POP_PST; // calendar lives ONLY in the local PST
  }

  if (account.accountType === "IMAP") {
    if (
      (account.serverHost && /(^|\.)imap\.gmail\.com$/i.test(account.serverHost)) ||
      (account.imapHost && /(^|\.)imap\.gmail\.com$/i.test(account.imapHost)) ||
      account.oauthIssuer === "accounts.google.com"
    ) {
      return AccountFlavor.GMAIL_IMAP;
    }
    return AccountFlavor.OTHER_IMAP;
  }

  if (account.accountType === "Exchange" || account.source === "wam") {
    const upn = (account.upn ?? account.address ?? "").toLowerCase();
    if (
      /@(outlook|hotmail|live)\.com$/.test(upn) &&
      (account.tenantId === CONSUMER_TENANT || account.tenantId === undefined)
    ) {
      // Consumer MSA; if we lack a tenantId, the domain match is authoritative enough.
      if (account.tenantId === CONSUMER_TENANT || account.tenantId === undefined) {
        return AccountFlavor.PERSONAL_MSA;
      }
    }
    const autodiscover = await probeAutodiscover(upn);
    if (
      autodiscover.host &&
      (/\.outlook\.office365\.com$/i.test(autodiscover.host) || /\.outlook\.com$/i.test(autodiscover.host))
    ) {
      return AccountFlavor.EXO_ORG;
    }
    return AccountFlavor.ON_PREM_EXCH; // on-prem, hybrid, or unresolvable
  }

  return AccountFlavor.OTHER_IMAP; // conservative default; never silently drop
}

/** Classify every candidate and attach a stable collector-local id. */
export async function classifyAll(accounts: RawAccount[]): Promise<ClassifiedAccount[]> {
  const out: ClassifiedAccount[] = [];
  for (const acc of accounts) {
    const flavor = await classify(acc);
    out.push({ ...acc, flavor, id: stableId(acc) });
    log.info("classified account", { address: acc.address ?? acc.upn, flavor });
  }
  return out;
}

/** Deterministic id from address so the same account keeps its id across runs. */
function stableId(acc: RawAccount): string {
  const seed = (acc.address ?? acc.upn ?? acc.storeId ?? "unknown").toLowerCase();
  return `acct:${seed}`;
}

/**
 * Autodiscover v2 probe (docs/15 §3.3): distinguishes EXO_ORG from ON_PREM_EXCH by the
 * returned mailbox host. Uses the public Autodiscover v2 JSON endpoint; a network
 * failure yields `{ host: null }` so classify() conservatively falls to ON_PREM_EXCH.
 */
export async function probeAutodiscover(email: string): Promise<{ host: string | null }> {
  if (!email.includes("@")) return { host: null };
  try {
    const url =
      `https://autodiscover-s.outlook.com/autodiscover/autodiscover.json` +
      `?Email=${encodeURIComponent(email)}&Protocol=Autodiscoverv1`;
    const res = await fetch(url, { redirect: "follow" });
    if (!res.ok) return { host: null };
    // v2 returns the EXO autodiscover host in a `Url` field; presence of *.outlook.*
    // resolves EXO. On-prem tenants either fail this or return their own host.
    const body = (await res.json()) as { Url?: string; Protocol?: string };
    if (body.Url) {
      const host = new URL(body.Url).host;
      return { host };
    }
    return { host: null };
  } catch (err) {
    log.debug("autodiscover probe failed; treating as on-prem", { email, err: String(err) });
    return { host: null };
  }
}

/** docs/15 §3.4/§4.2 — is Classic Outlook logged into a live MAPI profile for this account? */
export async function hasLiveMapiProfile(
  account: RawAccount,
  flavors: Set<OutlookFlavor>,
): Promise<boolean> {
  if (!flavors.has(OutlookFlavor.CLASSIC_OUTLOOK)) return false;
  let session: unknown;
  try {
    session = await logonDefaultProfile();
    const stores = await enumerateStores(session);
    const addr = (account.address ?? account.upn ?? "").toLowerCase();
    return stores.some(
      (s) =>
        s.storeId === account.storeId ||
        s.displayName.toLowerCase() === addr ||
        s.displayName.toLowerCase().includes(addr),
    );
  } catch {
    return false;
  } finally {
    if (session) await logoff(session);
  }
}
