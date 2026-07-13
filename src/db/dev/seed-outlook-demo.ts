import { existsSync, rmSync } from "node:fs";
import { join } from "node:path";
import { and, eq } from "drizzle-orm";
import { db } from "../client";
import { jobs, sources } from "../schema";
import type { NormalizedItem } from "@/connectors/types";
import { OUTLOOK_CONNECTOR_ID } from "@/connectors/outlook/shim";
import { createStagingDb, setAccountHealth, stageItem } from "@/connectors/outlook/staging";

/**
 * DEV-ONLY demo seed for the `outlook-collector` shim connector. NOT wired into
 * `pnpm db:seed` (there is no real collector in this environment). It:
 *   1. builds a fake collector staging DB (§5.4 schema) with a realistic dual-tap
 *      scenario — the SAME physical email staged under a `com` backfill row AND a
 *      `graph` incremental row (same canonical_key) — plus distinct emails and a
 *      calendar event keyed on its calendar_uid,
 *   2. registers an `outlook-collector` source row pointing at that staging DB, and
 *   3. enqueues a `connector_sync` job so a developer can exercise the whole path.
 *
 * Idempotent: rebuilds the staging file fresh, upserts the source, and only enqueues
 * a sync job when none is already pending. Run with:
 *   PID_DB_PATH=./pid.sqlite tsx src/db/dev/seed-outlook-demo.ts
 * (or `pnpm db:seed:outlook`). Optional PID_OUTLOOK_DEMO_STAGING overrides the path.
 */

const DEMO_ACCOUNT_ID = "demo-outlook-account";
const DEMO_SOURCE_ID = "OUTLOOKDEMOSOURCE0000000001"; // deterministic; re-seed safe.
const STAGING_PATH =
  process.env.PID_OUTLOOK_DEMO_STAGING ?? join(process.cwd(), "outlook-demo-staging.sqlite");

/** Build the fake staging DB with the dual-tap dedupe scenario. */
export function buildDemoStaging(path: string, accountId: string): void {
  for (const suffix of ["", "-wal", "-shm"]) {
    if (existsSync(path + suffix)) rmSync(path + suffix);
  }

  const staging = createStagingDb(path);
  try {
    const email = (
      externalId: string,
      messageId: string,
      subject: string,
      body: string,
    ): NormalizedItem => ({
      type: "email",
      externalId,
      tap: "graph",
      title: subject,
      body,
      bodyFormat: "text",
      occurredAt: Date.now(),
      domainFields: {
        message_id: messageId,
        from_address: "sender@example.com",
        from_name: "Example Sender",
        to_addresses: ["me@example.com"],
        folder: "Inbox",
        is_read: false,
      },
    });

    const sharedMsgId = "<dual-tap-001@example.com>";

    // Same physical email via COM backfill...
    stageItem(staging, {
      accountId,
      canonicalKey: sharedMsgId,
      tap: "com",
      externalId: "com-entryid-AAA",
      rawIdentifiers: { entryId: "AAA", storeId: "STORE1", searchKey: "SK1" },
      normalizedItem: {
        ...email("com-entryid-AAA", sharedMsgId, "Quarterly planning", "Body of the planning email."),
        tap: "com",
      },
    });
    // ...and again via Graph incremental (must collapse to ONE items row).
    stageItem(staging, {
      accountId,
      canonicalKey: sharedMsgId,
      tap: "graph",
      externalId: "graph-msgid-BBB",
      rawIdentifiers: { id: "BBB", internetMessageId: sharedMsgId },
      normalizedItem: {
        ...email("graph-msgid-BBB", sharedMsgId, "Quarterly planning", "Body of the planning email."),
        tap: "graph",
      },
    });

    // Two other distinct emails.
    stageItem(staging, {
      accountId,
      canonicalKey: "<distinct-002@example.com>",
      tap: "graph",
      externalId: "graph-msgid-CCC",
      rawIdentifiers: { id: "CCC", internetMessageId: "<distinct-002@example.com>" },
      normalizedItem: email("graph-msgid-CCC", "<distinct-002@example.com>", "Lunch?", "Free at noon?"),
    });
    stageItem(staging, {
      accountId,
      canonicalKey: "<distinct-003@example.com>",
      tap: "graph",
      externalId: "graph-msgid-DDD",
      rawIdentifiers: { id: "DDD", internetMessageId: "<distinct-003@example.com>" },
      normalizedItem: email("graph-msgid-DDD", "<distinct-003@example.com>", "Invoice", "See attached."),
    });

    // One calendar event keyed on its calendar_uid.
    const calUid = "event-uid-777@example.com";
    stageItem(staging, {
      accountId,
      canonicalKey: calUid,
      tap: "graph",
      externalId: "graph-event-EEE",
      rawIdentifiers: { id: "EEE", seriesMasterId: null },
      normalizedItem: {
        type: "event",
        externalId: "graph-event-EEE",
        tap: "graph",
        title: "Team sync",
        body: "Weekly team sync.",
        occurredAt: Date.now() + 86_400_000,
        domainFields: {
          start_at: Date.now() + 86_400_000,
          end_at: Date.now() + 90_000_000,
          all_day: false,
          calendar_uid: calUid,
        },
      },
    });

    setAccountHealth(staging, {
      account_id: accountId,
      resource: "mail",
      status: "ok",
      status_reason: null,
      last_success_at: Date.now(),
    });
  } finally {
    staging.close();
  }
}

function seedOutlookDemo(): void {
  buildDemoStaging(STAGING_PATH, DEMO_ACCOUNT_ID);
  console.log(`[seed:outlook] built demo staging DB at ${STAGING_PATH}`);

  const now = new Date();
  db.insert(sources)
    .values({
      id: DEMO_SOURCE_ID,
      connectorId: OUTLOOK_CONNECTOR_ID,
      accountId: DEMO_ACCOUNT_ID,
      displayName: "Outlook (collector) — demo",
      category: "email",
      config: { stagingDbPath: STAGING_PATH },
      enabled: true,
      status: "ok",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoUpdate({
      target: sources.id,
      set: { config: { stagingDbPath: STAGING_PATH }, updatedAt: now },
    })
    .run();
  console.log(`[seed:outlook] outlook-collector source ensured (${DEMO_SOURCE_ID})`);

  const existingJob = db
    .select()
    .from(jobs)
    .where(and(eq(jobs.type, "connector_sync"), eq(jobs.status, "queued")))
    .all()
    .find((j) => (j.payload as { sourceId?: string } | null)?.sourceId === DEMO_SOURCE_ID);

  if (!existingJob) {
    db.insert(jobs)
      .values({
        type: "connector_sync",
        status: "queued",
        payload: { sourceId: DEMO_SOURCE_ID },
        runAt: now,
        createdAt: now,
      })
      .run();
    console.log("[seed:outlook] enqueued connector_sync for demo outlook source");
  }

  console.log("[seed:outlook] done — run `pnpm worker` to process the sync");
}

seedOutlookDemo();
