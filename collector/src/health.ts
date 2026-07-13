/**
 * Degrade-loudly health state machine + re-consent triggers (docs/15 §7).
 *
 * Implements the §7.1 transitions over the shared status enum (ok | stale |
 * auth_failed | needs_consent | tap_unavailable) and the §7.2 re-consent logic:
 * transient errors (network/5xx) -> `stale` (keep retrying with backoff); a revoked
 * refresh token (invalid_grant) -> `needs_consent` and STOP polling until the user
 * acts; AADSTS90094 -> `needs_consent` (admin wall). There is no silent state — every
 * account always carries last_success_at + a human-readable reason.
 */

import type { HealthStatus, ResourceKind } from "./model.js";
import type { StagingWriter } from "./staging/writer.js";
import { CADENCE_MS } from "./config.js";
import { log } from "./log.js";

export interface AccountHealth {
  status: HealthStatus;
  reason: string | null;
  lastSuccessAt: number | null;
  /** Accounts in these states are excluded from the poll loop (docs/15 §6.4). */
  parked: boolean;
}

/** Classify a provider error string into the transition it drives (docs/15 §7.2). */
export function classifyError(error: string): "transient" | "needs_consent" | "auth_failed" {
  if (error === "AADSTS90094") return "needs_consent";
  if (error === "invalid_grant") return "needs_consent"; // revoked; will never self-heal
  if (
    /network|timeout|ENOTFOUND|ECONNRESET|EAI_AGAIN|rate_limited|graph_http_5\d\d|503|429|fetch failed/i.test(
      error,
    )
  ) {
    return "transient";
  }
  if (error === "interactive_required") return "auth_failed";
  return "auth_failed";
}

/** True if `lastSuccessAt` is older than ~twice the tap's expected cadence (docs/15 §7.4). */
export function isStale(
  lastSuccessAt: number | null,
  tap: keyof typeof CADENCE_MS,
  now = Date.now(),
): boolean {
  if (lastSuccessAt === null) return true;
  return now - lastSuccessAt > 3 * CADENCE_MS[tap];
}

export class HealthTracker {
  private readonly state = new Map<string, AccountHealth>();

  constructor(private readonly writer: StagingWriter) {}

  private keyOf(accountId: string, resource: ResourceKind): string {
    return `${accountId}:${resource}`;
  }

  get(accountId: string, resource: ResourceKind): AccountHealth {
    return (
      this.state.get(this.keyOf(accountId, resource)) ?? {
        status: "ok",
        reason: null,
        lastSuccessAt: null,
        parked: false,
      }
    );
  }

  isParked(accountId: string, resource: ResourceKind): boolean {
    return this.get(accountId, resource).parked;
  }

  /** Record a successful sync => OK (docs/15 §7.1 STALE/OK -> OK). */
  onSuccess(accountId: string, resource: ResourceKind): void {
    const health: AccountHealth = {
      status: "ok",
      reason: null,
      lastSuccessAt: Date.now(),
      parked: false,
    };
    this.set(accountId, resource, health);
  }

  /** Apply a chosen tap decision's initial status (e.g. tap_unavailable / needs_consent). */
  onDecision(
    accountId: string,
    resource: ResourceKind,
    status: HealthStatus,
    reason: string | undefined,
  ): void {
    const prev = this.get(accountId, resource);
    const parked = status === "needs_consent" || status === "tap_unavailable";
    this.set(accountId, resource, {
      status,
      reason: reason ?? null,
      lastSuccessAt: prev.lastSuccessAt,
      parked,
    });
  }

  /** docs/15 §7.2 onAuthRejected. Returns whether polling should stop for this account. */
  onError(accountId: string, resource: ResourceKind, error: string): { parked: boolean } {
    const prev = this.get(accountId, resource);
    const kind = classifyError(error);
    let health: AccountHealth;
    if (kind === "transient") {
      // keep retrying with backoff — mark stale, still polled
      health = { status: "stale", reason: error, lastSuccessAt: prev.lastSuccessAt, parked: false };
    } else if (kind === "needs_consent") {
      health = {
        status: "needs_consent",
        reason:
          error === "AADSTS90094"
            ? "Your organization hasn't approved mail/calendar access — admin consent required"
            : "Sign-in expired; reconnect required",
        lastSuccessAt: prev.lastSuccessAt,
        parked: true, // stop polling until the user re-consents (docs/15 §6.4/§7.2)
      };
    } else {
      health = {
        status: "auth_failed",
        reason: error,
        lastSuccessAt: prev.lastSuccessAt,
        parked: true,
      };
    }
    this.set(accountId, resource, health);
    return { parked: health.parked };
  }

  /**
   * docs/15 §7.2 onUserClicksReconnect success path: clear the parked state so the next
   * evaluation pass resumes from the LAST DURABLE cursor (never a fresh backfill).
   */
  onReconsented(accountId: string, resource: ResourceKind): void {
    log.info("account re-consented; resuming from durable cursor", { accountId, resource });
    this.onSuccess(accountId, resource);
  }

  private set(accountId: string, resource: ResourceKind, health: AccountHealth): void {
    this.state.set(this.keyOf(accountId, resource), health);
    this.writer.setAccountHealth(
      accountId,
      resource,
      health.status,
      health.reason,
      health.lastSuccessAt,
    );
    if (health.status !== "ok") {
      log.warn("account health degraded", {
        accountId,
        resource,
        status: health.status,
        reason: health.reason,
      });
    }
  }
}
