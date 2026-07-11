import { db } from "./client";
import { settings } from "./schema";
import { AI_SETTINGS_DEFAULTS } from "@/lib/settings";

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
// PHASE 1 EXTENSION POINT — sample `sources` row registration.
//
// A later agent (Phase 1 ingestion) will register the sample connector as a
// `sources` row here: connector_id='sample', category='sample', one account,
// enabled. Do NOT add the sample source in Phase 0. When implemented, insert it
// idempotently (onConflictDoNothing against the connector_id/account_id unique
// index) so re-seeding stays safe. See BUILD_SPEC §4 "Seed / sample connector".
//
// function seedSampleSource(): void { /* TODO(phase-1): register sample source */ }
// ---------------------------------------------------------------------------

function seed(): void {
  seedSettingsDefaults();
  // seedSampleSource(); // TODO(phase-1): enable once SampleConnector lands.
  console.log("[seed] done");
}

seed();
