import { and, eq } from "drizzle-orm";
import { db } from "./client";
import { feeds, jobs, settings, sources } from "./schema";
import { AI_SETTINGS_DEFAULTS } from "@/lib/settings";
import {
  SAMPLE_ACCOUNT_ID,
  SAMPLE_CONNECTOR_ID,
  SAMPLE_DISPLAY_NAME,
  SAMPLE_SOURCE_ID,
} from "@/connectors/sample";
import {
  SAMPLE_FEED_ID,
  SAMPLE_FEED_SITE_URL,
  SAMPLE_FEED_TITLE,
  SAMPLE_FEED_URL,
} from "@/connectors/sample/fixtures";

/**
 * Seeds baseline data into a freshly-migrated database. Currently seeds the
 * `settings` defaults (AI runtime config, BUILD_SPEC §6). Idempotent — existing
 * keys are left untouched so a user's edits survive a re-seed.
 *
 * Invoked via `pnpm db:seed`.
 */

function seedSettingsDefaults(): void {
  const now = new Date();
  const rows = Object.entries(AI_SETTINGS_DEFAULTS).map(([key, value]) => ({
    key,
    value,
    updatedAt: now,
  }));

  db.insert(settings).values(rows).onConflictDoNothing({ target: settings.key }).run();
  console.log(`[seed] settings defaults ensured (${rows.length} keys)`);
}

// ---------------------------------------------------------------------------
// PHASE 1 — sample connector registration (BUILD_SPEC §4 "Seed / sample connector").
//
// Registers the sample connector as a single `sources` row (deterministic id, so
// re-seeding never duplicates it), its backing `feeds` registry row (so sample
// feed_items have a valid FK target), and — on first seed only — an initial
// `connector_sync` job so `pnpm db:seed` primes the ingestion pipeline. The
// connector-sync handler creates the `sync_state` row itself on first run, so no
// sync_state precondition is seeded here.
//
// Disabling the sample source and enabling a real connector is a one-line change
// to this row + registry (no other rework), per the spec.
// ---------------------------------------------------------------------------
function seedSampleSource(): void {
  const now = new Date();

  db.insert(sources)
    .values({
      id: SAMPLE_SOURCE_ID,
      connectorId: SAMPLE_CONNECTOR_ID,
      accountId: SAMPLE_ACCOUNT_ID,
      displayName: SAMPLE_DISPLAY_NAME,
      category: "sample",
      config: {},
      enabled: true,
      status: "ok",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: sources.id })
    .run();

  db.insert(feeds)
    .values({
      id: SAMPLE_FEED_ID,
      sourceId: SAMPLE_SOURCE_ID,
      url: SAMPLE_FEED_URL,
      title: SAMPLE_FEED_TITLE,
      siteUrl: SAMPLE_FEED_SITE_URL,
      pollIntervalMinutes: 60,
    })
    .onConflictDoNothing({ target: feeds.id })
    .run();

  // Enqueue an initial backfill only if no connector_sync job for this source is
  // already pending (keeps re-seeds from piling up duplicate jobs).
  const existingJob = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "connector_sync"), eq(jobs.status, "queued")))
    .all()
    .find((j) => (j.payload as { sourceId?: string } | null)?.sourceId === SAMPLE_SOURCE_ID);

  if (!existingJob) {
    db.insert(jobs)
      .values({
        type: "connector_sync",
        status: "queued",
        payload: { sourceId: SAMPLE_SOURCE_ID },
        runAt: now,
        createdAt: now,
      })
      .run();
    console.log("[seed] enqueued initial connector_sync for sample source");
  }

  console.log(`[seed] sample source ensured (${SAMPLE_SOURCE_ID})`);
}

function seed(): void {
  seedSettingsDefaults();
  seedSampleSource();
  console.log("[seed] done");
}

seed();
