import { sqlite } from "@/db/client";
import { getHandler, type JobRecord } from "./dispatch";

/**
 * Background worker poll loop (BUILD_SPEC §5). Single process, no external queue:
 * the `jobs` table is the system of record. Claims one job at a time via an
 * atomic UPDATE ... RETURNING (safe under better-sqlite3's own write lock),
 * dispatches by type, and:
 *   - success           -> status='succeeded'
 *   - handler throws     -> attempts++, requeue with backoff, or 'failed' at cap
 *   - unknown job type   -> mark 'failed' (never crash the loop)
 *   - no queued job      -> sleep
 *
 * Phase 0 has NO handlers registered, so every claimed job (there are none in a
 * fresh DB) would be marked failed-unknown; the loop idles cleanly.
 */

const IDLE_SLEEP_MS = 3000;
const BACKOFF_BASE_MS = 5000;
const BACKOFF_MAX_MS = 5 * 60 * 1000;

let running = true;

interface RawJobRow {
  id: number;
  type: string;
  payload: string | null;
  attempts: number;
  max_attempts: number;
}

const claimStmt = sqlite.prepare<[number, number], RawJobRow>(`
  UPDATE jobs SET status = 'running', started_at = ?
  WHERE id = (
    SELECT id FROM jobs
    WHERE status = 'queued' AND run_at <= ?
    ORDER BY priority DESC, run_at ASC
    LIMIT 1
  )
  RETURNING id, type, payload, attempts, max_attempts
`);

const succeedStmt = sqlite.prepare<[number, number]>(
  `UPDATE jobs SET status = 'succeeded', finished_at = ?, error = NULL WHERE id = ?`,
);

const requeueStmt = sqlite.prepare<[number, number, number]>(
  `UPDATE jobs SET status = 'queued', attempts = ?, run_at = ?, started_at = NULL WHERE id = ?`,
);

const failStmt = sqlite.prepare<[number, string, number, number]>(
  `UPDATE jobs SET status = 'failed', finished_at = ?, attempts = ?, error = ? WHERE id = ?`,
);

function backoffMs(attempts: number): number {
  return Math.min(BACKOFF_BASE_MS * 2 ** (attempts - 1), BACKOFF_MAX_MS);
}

function claimNext(): RawJobRow | undefined {
  const now = Date.now();
  return claimStmt.get(now, now);
}

function toJobRecord(row: RawJobRow): JobRecord {
  let payload: Record<string, unknown> | null = null;
  if (row.payload) {
    try {
      payload = JSON.parse(row.payload) as Record<string, unknown>;
    } catch {
      payload = null;
    }
  }
  return {
    id: row.id,
    type: row.type,
    payload,
    attempts: row.attempts,
    maxAttempts: row.max_attempts,
  };
}

async function processJob(row: RawJobRow): Promise<void> {
  const job = toJobRecord(row);
  const handler = getHandler(job.type);

  if (!handler) {
    failStmt.run(Date.now(), `no handler registered for job type "${job.type}"`, job.attempts, job.id);
    console.warn(`[worker] job ${job.id}: unknown type "${job.type}" -> failed`);
    return;
  }

  try {
    await handler(job.payload ?? {}, { job });
    succeedStmt.run(Date.now(), job.id);
  } catch (err) {
    const attempts = job.attempts + 1;
    const message = err instanceof Error ? err.message : String(err);
    if (attempts < job.maxAttempts) {
      requeueStmt.run(attempts, Date.now() + backoffMs(attempts), job.id);
      console.warn(`[worker] job ${job.id} failed (attempt ${attempts}), requeued: ${message}`);
    } else {
      failStmt.run(Date.now(), message, attempts, job.id);
      console.error(`[worker] job ${job.id} failed permanently: ${message}`);
    }
  }
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function loop(): Promise<void> {
  console.log("[worker] started; polling jobs table");
  while (running) {
    let row: RawJobRow | undefined;
    try {
      row = claimNext();
    } catch (err) {
      console.error("[worker] claim query failed:", err);
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    if (!row) {
      await sleep(IDLE_SLEEP_MS);
      continue;
    }

    await processJob(row);
  }
  console.log("[worker] stopped");
}

function shutdown() {
  running = false;
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);

loop().catch((err) => {
  console.error("[worker] fatal:", err);
  process.exit(1);
});
