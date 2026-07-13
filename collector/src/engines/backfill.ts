/**
 * Backfill engine (docs/15 §4) — bounded historical pull with dual-tap concurrency.
 *
 * Transcribes §4.2 `runDualTapBackfill` + `onBackfillComplete`: when the primary mail
 * tap is Graph AND Classic Outlook has a live MAPI profile, fire a FAST local COM
 * backfill and the AUTHORITATIVE Graph backfill CONCURRENTLY, each owning its own
 * collector_sync_state row. The persistent cross-tap collapse in StagingWriter is the
 * `onBackfillBatchCommitted` dedupe (§4.2): a physical message landing via both taps
 * yields ONE staged row. When Graph backfill finishes, the COM backfill is marked
 * superseded and further COM polling for the account stops — Graph is authoritative.
 */

import type { ClassifiedAccount, OutlookFlavor, ResourceKind, TapDecision } from "../model.js";
import { TapKind } from "../model.js";
import { OutlookFlavor as Flavor } from "../model.js";
import { runTap } from "../taps/dispatch.js";
import { collapseByCanonicalKey } from "../staging/dedupe.js";
import type { StagingWriter } from "../staging/writer.js";
import type { HealthTracker } from "../health.js";
import { hasLiveMapiProfile } from "../accounts.js";
import { log } from "../log.js";

export interface EngineContext {
  writer: StagingWriter;
  health: HealthTracker;
  flavors: Set<OutlookFlavor>;
}

const MAX_BACKFILL_PAGES = 10_000; // safety cap per (account, resource, tap)

export class BackfillEngine {
  /** Taps marked superseded (COM after Graph caught up) — excluded from further polling. */
  readonly superseded = new Set<string>();

  constructor(private readonly ctx: EngineContext) {}

  private supersedeKey(accountId: string, resource: ResourceKind, tap: TapKind): string {
    return `${accountId}:${resource}:${tap}`;
  }

  isSuperseded(accountId: string, resource: ResourceKind, tap: TapKind): boolean {
    return this.superseded.has(this.supersedeKey(accountId, resource, tap));
  }

  /** docs/15 §4.2 runDualTapBackfill (mail); calendar backfills on the chosen tap. */
  async run(account: ClassifiedAccount, decision: TapDecision): Promise<void> {
    const jobs: Promise<void>[] = [];

    // Mail.
    if (decision.mail !== TapKind.NONE) {
      const dual =
        decision.mail === TapKind.GRAPH &&
        this.ctx.flavors.has(Flavor.CLASSIC_OUTLOOK) &&
        (await hasLiveMapiProfile(account, this.ctx.flavors));
      if (dual) {
        log.info("dual-tap backfill: fast COM + authoritative Graph", { account: account.address });
        // Fast, local — shortens time-to-knowledge-graph.
        jobs.push(this.backfillTap(account, "mail", TapKind.COM));
        // Authoritative — the canonical reconciliation target.
        jobs.push(
          this.backfillTap(account, "mail", TapKind.GRAPH).then(() =>
            this.onBackfillComplete(account, "mail", TapKind.GRAPH),
          ),
        );
      } else {
        jobs.push(this.backfillTap(account, "mail", decision.mail));
      }
    }

    // Calendar (single tap — recurrence handled per §5.5 inside each tap).
    if (decision.calendar !== TapKind.NONE) {
      jobs.push(this.backfillTap(account, "calendar", decision.calendar));
    }

    await Promise.allSettled(jobs);
  }

  /** Drive one tap's backfill to completion, staging each page and advancing the cursor. */
  private async backfillTap(
    account: ClassifiedAccount,
    resource: ResourceKind,
    tap: TapKind,
  ): Promise<void> {
    const logger = log.child({ account: account.address, resource, tap, phase: "backfill" });
    let cursor = this.ctx.writer.getCursor(account.id, resource, tap, "backfill");
    let pages = 0;
    try {
      for (;;) {
        if (this.isSuperseded(account.id, resource, tap)) {
          logger.info("backfill superseded; stopping");
          return;
        }
        const batch = await runTap(account, resource, tap, cursor);
        const { collapsed, seenTaps } = collapseByCanonicalKey(batch.items);
        this.ctx.writer.stageBatch(account.id, collapsed, seenTaps);
        // Persist the cursor AFTER items are staged (crash-safe, docs/05 contract).
        this.ctx.writer.setCursor(
          account.id,
          resource,
          tap,
          "backfill",
          batch.cursorType,
          batch.nextCursor,
        );
        cursor = batch.nextCursor;
        this.ctx.health.onSuccess(account.id, resource);
        if (!batch.hasMore || ++pages >= MAX_BACKFILL_PAGES) break;
      }
      logger.info("backfill complete", { pages });
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      logger.warn("backfill error", { err: message });
      this.ctx.health.onError(account.id, resource, message);
    }
  }

  /**
   * docs/15 §4.2 onBackfillComplete: once the authoritative Graph backfill for a
   * (account, resource) finishes, mark the parallel COM backfill superseded and stop
   * scheduling further COM polls. COM incremental was never started (Graph is steady
   * state from setup) — its staged rows remain, now owned by the canonical dedupe key.
   */
  onBackfillComplete(account: ClassifiedAccount, resource: ResourceKind, tap: TapKind): void {
    if (tap !== TapKind.GRAPH) return;
    const comKey = this.supersedeKey(account.id, resource, TapKind.COM);
    if (this.superseded.has(comKey)) return;
    this.superseded.add(comKey);
    log.info("Graph backfill caught up; COM backfill marked superseded", {
      account: account.address,
      resource,
    });
  }
}
