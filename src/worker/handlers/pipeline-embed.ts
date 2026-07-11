import { sqlite } from "@/db/client";
import { embed, LMStudioUnavailableError } from "@/services/ai-orchestration";
import { getAiSettings } from "@/lib/settings";
import type { JobHandler } from "../dispatch";

/**
 * `pipeline_embed` handler (BUILD_SPEC §5 / §6). Payload `{ itemId }` or `{ chunkIds }`.
 *
 * Loads the item's chunks that still lack embeddings, batches their text to
 * LM Studio via the AI Orchestration `embed()`, and writes each vector into the
 * `embeddings` vec0 table with `rowid = chunks.id` (raw SQL, sqlite-vec has no
 * Drizzle model) plus an `embedding_meta` row (model_name, dims).
 *
 * CRITICAL degrade-loudly rule: if LM Studio is unavailable
 * ({@link LMStudioUnavailableError}), the job is NEVER marked `failed`. Instead we
 * re-enqueue a fresh `pipeline_embed` job with backoff and return normally, so the
 * worker records this attempt as done while the work drains from the backlog when
 * LM Studio returns. (The worker marks a handler that RETURNS as succeeded and a
 * handler that THROWS as failed-after-max-attempts, so re-enqueue-and-return is the
 * only path that both avoids `failed` AND survives repeated outages.)
 */

interface ChunkRow {
  id: number;
  content: string;
}

const REQUEUE_BASE_MS = 30_000;
const REQUEUE_MAX_MS = 5 * 60 * 1000;

const insertEmbedding = sqlite.prepare(`INSERT INTO embeddings (rowid, embedding) VALUES (?, ?)`);
const insertMeta = sqlite.prepare(
  `INSERT INTO embedding_meta (chunk_id, model_name, dims, created_at)
   VALUES (?, ?, ?, ?)
   ON CONFLICT(chunk_id) DO UPDATE SET model_name = excluded.model_name,
     dims = excluded.dims, created_at = excluded.created_at`,
);
const enqueueEmbed = sqlite.prepare(
  `INSERT INTO jobs (type, status, payload, priority, attempts, max_attempts, run_at, created_at)
   VALUES ('pipeline_embed', 'queued', ?, 0, 0, 3, ?, ?)`,
);

function loadPendingChunks(payload: Record<string, unknown>): ChunkRow[] {
  if (Array.isArray(payload.chunkIds) && payload.chunkIds.length) {
    const ids = payload.chunkIds.map((n) => Number(n)).filter((n) => Number.isFinite(n));
    if (!ids.length) return [];
    const placeholders = ids.map(() => "?").join(", ");
    return sqlite
      .prepare<number[], ChunkRow>(
        `SELECT c.id, c.content FROM chunks c
           LEFT JOIN embedding_meta m ON m.chunk_id = c.id
          WHERE c.id IN (${placeholders}) AND m.chunk_id IS NULL
          ORDER BY c.chunk_index ASC`,
      )
      .all(...ids);
  }

  const itemId = String(payload.itemId ?? "");
  if (!itemId) return [];
  return sqlite
    .prepare<[string], ChunkRow>(
      `SELECT c.id, c.content FROM chunks c
         LEFT JOIN embedding_meta m ON m.chunk_id = c.id
        WHERE c.item_id = ? AND m.chunk_id IS NULL
        ORDER BY c.chunk_index ASC`,
    )
    .all(itemId);
}

export const pipelineEmbed: JobHandler = async (payload) => {
  const chunks = loadPendingChunks(payload);
  if (chunks.length === 0) return; // nothing outstanding — already embedded.

  let vectors: number[][];
  try {
    vectors = await embed(chunks.map((c) => c.content));
  } catch (err) {
    if (err instanceof LMStudioUnavailableError) {
      // Re-enqueue with backoff; NEVER fail. Backlog drains when LM Studio returns.
      const attempt = Number(payload.embedAttempt ?? 0) + 1;
      const delay = Math.min(REQUEUE_BASE_MS * 2 ** (attempt - 1), REQUEUE_MAX_MS);
      const now = Date.now();
      const nextPayload = Array.isArray(payload.chunkIds)
        ? { chunkIds: payload.chunkIds, embedAttempt: attempt }
        : { itemId: payload.itemId, embedAttempt: attempt };
      enqueueEmbed.run(JSON.stringify(nextPayload), now + delay, now);
      console.warn(
        `[pipeline_embed] LM Studio unavailable; re-queued ${chunks.length} chunk(s) in ${delay}ms (attempt ${attempt})`,
      );
      return; // return (not throw) so the worker does not mark this 'failed'.
    }
    throw err; // genuine error -> let the worker apply its retry/backoff.
  }

  const model = getAiSettings()["ai.embeddingModel"];
  const now = Date.now();

  const write = sqlite.transaction(() => {
    for (let i = 0; i < chunks.length; i++) {
      const vec = vectors[i];
      if (!vec) continue;
      insertEmbedding.run(chunks[i].id, JSON.stringify(vec));
      insertMeta.run(chunks[i].id, model, vec.length, now);
    }
  });
  write();
};
