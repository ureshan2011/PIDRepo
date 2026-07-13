/**
 * Shared domain model for the Outlook Collector (docs/15 §3–§7).
 *
 * These enums and record shapes are the vocabulary every other module speaks:
 * detector -> classifier -> tap-selector -> engines -> staging/health. They are a
 * faithful transcription of the pseudocode types in docs/15 (OutlookFlavor,
 * AccountFlavor, the tap kinds, TapDecision, and the health-status enum shared with
 * the main app's `sources.status` / `sync_state.status`).
 */

/** docs/15 §3.1 — both flavors can be installed simultaneously in 2026. */
export enum OutlookFlavor {
  NEW_OUTLOOK = "NEW_OUTLOOK",
  CLASSIC_OUTLOOK = "CLASSIC_OUTLOOK",
}

/** docs/15 §3.3 — the six account flavors the classifier resolves. */
export enum AccountFlavor {
  EXO_ORG = "EXO_ORG",
  PERSONAL_MSA = "PERSONAL_MSA",
  GMAIL_IMAP = "GMAIL_IMAP",
  OTHER_IMAP = "OTHER_IMAP",
  POP_PST = "POP_PST",
  ON_PREM_EXCH = "ON_PREM_EXCH",
}

/**
 * The legal tap values. `graph` | `imap` | `com` are the three named in docs/15 §5.3
 * for `sync_state.tap`; `caldav` and `ews_onprem` are additional taps the selector
 * can pick (docs/15 §3.4) — calendar/on-prem paths that ride alongside a mail tap.
 * `NONE` means "no tap resolvable for this resource".
 */
export enum TapKind {
  GRAPH = "graph",
  IMAP = "imap",
  CALDAV = "caldav",
  COM = "com",
  EWS_ONPREM = "ews_onprem",
  NONE = "none",
}

export type ResourceKind = "mail" | "calendar";
export type SyncDirection = "backfill" | "incremental";

/** docs/15 §7.1 — exact enum shared with `sources.status` / `sync_state.status`. */
export type HealthStatus = "ok" | "stale" | "auth_failed" | "needs_consent" | "tap_unavailable";

/** The consumer (personal Microsoft account) tenant id — docs/15 §3.3. */
export const CONSUMER_TENANT = "9188040d-6c67-4c5b-b112-36a304b66dad";

/** docs/15 §3.2 — a candidate account before classification. */
export interface RawAccount {
  /** Where this candidate was discovered. */
  source: "mapi" | "wam" | "user_configured";
  /** Stable-ish identity used for dedupe and as the collector `account_id`. */
  address?: string;
  displayName?: string;
  /** MAPI store dimensions (COM tap). */
  storeId?: string;
  serverHost?: string;
  /** "Exchange" | "IMAP" | "POP3" | null — from `RDOStore.ExchangeMailboxType`. */
  accountType?: "Exchange" | "IMAP" | "POP3" | null;
  /** WAM dimensions (Microsoft identity broker). */
  upn?: string;
  tenantId?: string;
  /** OAuth issuer, when known from user setup (drives Gmail classification). */
  oauthIssuer?: string;
  /** User-configured extras (host/port/oauth) persisted once during setup. */
  imapHost?: string;
  imapPort?: number;
  caldavUrl?: string;
  authKind?: "oauth" | "app_password";
}

/** docs/15 §3.3 output — a raw account plus its resolved flavor. */
export interface ClassifiedAccount extends RawAccount {
  /** Canonical collector-local id (stable across runs). */
  id: string;
  flavor: AccountFlavor;
}

/** docs/15 §3.4 — the per-resource tap choice with status + reason. */
export interface TapDecision {
  mail: TapKind;
  calendar: TapKind;
  status: HealthStatus;
  reason?: string;
  /** POP is structurally mandatory-COM (docs/15 §3.4 POP_PST). */
  mandatory?: boolean;
}

/** Result of an auth attempt (Graph / IMAP), used by the tap selector. */
export interface AuthProbeResult {
  ok: boolean;
  /** e.g. "AADSTS90094", "invalid_grant", or a transient network/5xx message. */
  error?: string;
  /** Present only in-memory; NEVER persisted to staging/config/logs (docs/15 §8.1). */
  accountRef?: string;
}
