/**
 * Collector configuration, paths, and constants (docs/15 §2, §5.4, §6).
 *
 * All filesystem locations live under the per-user profile so the collector runs
 * entirely inside the logged-on user's security context (docs/15 §6.1). Nothing here
 * holds a secret — refresh tokens live only in DPAPI / Credential Manager (§8.1); the
 * config store persists only the NON-secret account descriptors from one-time setup.
 */

import { homedir, platform } from "node:os";
import { join } from "node:path";
import { mkdirSync } from "node:fs";

/** True only on Windows — gates every native (COM/WAM/DPAPI) code path. */
export const IS_WINDOWS = platform() === "win32";

/** Base data directory: `%LOCALAPPDATA%\PID\Collector` on Windows, else a dev fallback. */
export function dataDir(): string {
  const base =
    process.env.PID_COLLECTOR_HOME ??
    process.env.LOCALAPPDATA ??
    join(homedir(), ".pid-collector");
  const dir = join(base, "PID", "Collector");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * Path to the WAL staging SQLite the main app's shim reads read-only. The main app's
 * `outlook-collector` source must point `config.stagingDbPath` at THIS file (see README).
 */
export function stagingDbPath(): string {
  return process.env.PID_COLLECTOR_STAGING_DB ?? join(dataDir(), "collector-staging.sqlite");
}

/** JSON store of the NON-secret, one-time-configured accounts (docs/15 §3.2 loadUserConfiguredAccounts). */
export function accountsStorePath(): string {
  return join(dataDir(), "accounts.json");
}

/** Single-instance lock file (docs/15 §6.2). */
export function lockFilePath(): string {
  return join(dataDir(), "collector.lock");
}

/** Log file directory (rotated by day); logs NEVER contain secrets (docs/15 §8.1). */
export function logDir(): string {
  const dir = join(dataDir(), "logs");
  mkdirSync(dir, { recursive: true });
  return dir;
}

/**
 * OAuth client registration. These are PUBLIC client ids (native/loopback PKCE) — not
 * secrets. Overridable via env so a deployer can supply their own app registration.
 */
export const OAUTH = {
  /** Azure AD app (multi-tenant + consumers) for Graph mail/calendar. */
  graphClientId: process.env.PID_GRAPH_CLIENT_ID ?? "00000000-0000-0000-0000-000000000000",
  graphAuthority: process.env.PID_GRAPH_AUTHORITY ?? "https://login.microsoftonline.com",
  graphScopes: [
    "offline_access",
    "https://graph.microsoft.com/Mail.Read",
    "https://graph.microsoft.com/Calendars.Read",
  ],
  /** Google OAuth (IMAP XOAUTH2 + CalDAV) for Gmail. */
  googleClientId: process.env.PID_GOOGLE_CLIENT_ID ?? "",
  googleClientSecret: process.env.PID_GOOGLE_CLIENT_SECRET ?? "", // native-app "secret", not confidential
  googleScopes: ["https://mail.google.com/", "https://www.googleapis.com/auth/calendar.readonly"],
  /** Loopback redirect port range for the PKCE flow. */
  loopbackHost: "127.0.0.1",
} as const;

/** docs/15 §6.2 lock timing. */
export const LOCK_STALE_THRESHOLD_MS = 90_000;
export const HEARTBEAT_INTERVAL_MS = 30_000;

/** docs/15 §3 — re-run detect/classify/select every 30 min (and on session unlock). */
export const RECLASSIFY_INTERVAL_MS = 30 * 60_000;

/** docs/15 §6.4 — per-tap steady-state poll cadences (ms). */
export const CADENCE_MS = {
  graph: 2 * 60_000, // 1–5 min, default 2
  imap: 29 * 60_000, // IDLE re-issue near RFC 2177 server timeout
  caldav: 15 * 60_000,
  com: 5 * 60_000,
} as const;

/** docs/15 §6.4 backoff — exponential + jitter, capped at 30 min. */
export const BACKOFF = { baseMs: 5_000, maxMs: 30 * 60_000 } as const;

/** docs/15 §5.5 — rolling recurrence-expansion window (days). */
export const RECURRENCE_WINDOW = { pastDays: 90, futureDays: 365 } as const;

/** Bounded historical backfill horizon (days) for the initial pull (docs/15 §4). */
export const BACKFILL_HORIZON_DAYS = Number(process.env.PID_BACKFILL_DAYS ?? "3650"); // ~10y
