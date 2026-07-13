/**
 * Incremental engine (docs/15 §4, §6.4) — steady-state delta / IDLE / poll.
 *
 * Runs one long-lived loop per (account, resource) on the chosen PRIMARY tap, at the
 * per-tap cadence in docs/15 §6.4 (Graph 2 min, IMAP IDLE ~29 min, CalDAV 15 min, COM
 * 5 min). Transient errors back off exponentially with jitter, capped at 30 min, and
 * reset to base cadence on the next success (§6.4). Accounts in `needs_consent` /
 * `auth_failed` are PARKED — excluded from the loop entirely so a dead token never
 * spins (§6.4/§7.2). Steady state starts immediately at setup and does NOT wait for
 * backfill, so nothing arriving after setup is missed (§4.2).
 */

import type { ClassifiedAccount, ResourceKind, TapDecision } from "../model.js";
import { TapKind } from "../model.js";
import { runTap, cadenceKeyFor } from "../taps/dispatch.js";
import { idleOnce } from "../taps/imap.js";
import { collapseByCanonicalKey } from "../staging/dedupe.js";
import { CADENCE_MS, BACKOFF } from "../config.js";
import type { EngineContext } from "./backfill.js";
import { log } from "../log.js";

interface LoopHandle {
  stop: () => void;
}

export class IncrementalEngine {
  private readonly loops = new Map<string, LoopHandle>();

  constructor(private readonly ctx: EngineContext) {}

  private key(accountId: string, resource: ResourceKind): string {
    return `${accountId}:${resource}`;
  }

  /** Start (or restart) steady-state loops for an account per its tap decision. */
  start(account: ClassifiedAccount, decision: TapDecision): void {
    if (decision.mail !== TapKind.NONE) this.startLoop(account, "mail", decision.mail);
    if (decision.calendar !== TapKind.NONE) this.startLoop(account, "calendar", decision.calendar);
  }

  /** Stop a resource loop (e.g. on re-classification that removed the tap). */
  stopLoop(accountId: string, resource: ResourceKind): void {
    const handle = this.loops.get(this.key(accountId, resource));
    handle?.stop();
    this.loops.delete(this.key(accountId, resource));
  }

  stopAll(): void {
    for (const h of this.loops.values()) h.stop();
    this.loops.clear();
  }

  private startLoop(account: ClassifiedAccount, resource: ResourceKind, tap: TapKind): void {
    const key = this.key(account.id, resource);
    this.loops.get(key)?.stop(); // replace any existing loop
    const cadenceKey = cadenceKeyFor(tap);
    const baseCadence = CADENCE_MS[cadenceKey];
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let backoff = 0; // 0 => healthy; >0 => current backoff floor

    const schedule = (delay: number) => {
      if (stopped) return;
      timer = setTimeout(tick, withJitter(delay));
      timer.unref?.();
    };

    const tick = async () => {
      if (stopped) return;
      // Parked accounts are excluded from the loop (docs/15 §6.4).
      if (this.ctx.health.isParked(account.id, resource)) {
        log.debug("account parked; skipping poll", { account: account.address, resource });
        schedule(baseCadence);
        return;
      }
      try {
        // IMAP steady state waits on IDLE push before reconciling via MODSEQ (§6.4).
        if (tap === TapKind.IMAP && resource === "mail") {
          await idleOnce(account, baseCadence);
        }
        let cursor = this.ctx.writer.getCursor(account.id, resource, tap, "incremental");
        // Drain all immediately-available pages this cycle.
        for (let guard = 0; guard < 100; guard++) {
          const batch = await runTap(account, resource, tap, cursor);
          const { collapsed, seenTaps } = collapseByCanonicalKey(batch.items);
          this.ctx.writer.stageBatch(account.id, collapsed, seenTaps);
          this.ctx.writer.setCursor(
            account.id,
            resource,
            tap,
            "incremental",
            batch.cursorType,
            batch.nextCursor,
          );
          cursor = batch.nextCursor;
          if (!batch.hasMore) break;
        }
        this.ctx.health.onSuccess(account.id, resource);
        backoff = 0; // reset to base cadence on success (§6.4)
        schedule(baseCadence);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        const { parked } = this.ctx.health.onError(account.id, resource, message);
        if (parked) {
          // needs_consent / auth_failed: stop the loop until re-consent restarts it.
          log.info("loop parked pending re-consent", { account: account.address, resource });
          schedule(baseCadence); // keep a slow heartbeat so re-consent is noticed
          return;
        }
        backoff = nextBackoff(backoff, baseCadence);
        log.warn("incremental backoff", { account: account.address, resource, backoffMs: backoff });
        schedule(backoff);
      }
    };

    this.loops.set(key, {
      stop: () => {
        stopped = true;
        if (timer) clearTimeout(timer);
      },
    });
    // Start immediately (docs/15 §4.2: steady state does not wait for backfill).
    schedule(0);
  }
}

/** Exponential growth from the base cadence, capped at 30 min (docs/15 §6.4). */
function nextBackoff(current: number, base: number): number {
  const next = current === 0 ? Math.max(BACKOFF.baseMs, base) : current * 2;
  return Math.min(next, BACKOFF.maxMs);
}

/** +/-20% jitter so many accounts don't align their polls (docs/15 §6.4). */
function withJitter(ms: number): number {
  if (ms <= 0) return 0;
  const jitter = ms * 0.2 * (Math.random() * 2 - 1);
  return Math.max(0, Math.round(ms + jitter));
}
