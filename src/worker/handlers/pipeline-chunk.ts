import { sqlite } from "@/db/client";
import { itemText, splitIntoChunks } from "@/ingestion/pipeline";
import type { JobHandler } from "../dispatch";

/**
 * `pipeline_chunk` handler (BUILD_SPEC §5). Payload `{ itemId }`.
 *
 * Splits the item's title+body into ~512-token passages (approx by chars) and
 * writes `chunks` rows (>=1 per non-empty item). Re-chunking is idempotent: the
 * item's existing chunks (and their embeddings/meta) are cleared first so a re-run
 * after an edit produces a clean set. Then enqueues `pipeline_embed` for the item.
 * No AI dependency — chunking always proceeds even when LM Studio is down.
 */

interface ItemRow {
  id: string;
  title: string | null;
  body: string | null;
  is_deleted: number;
}

const enqueueEmbed = sqlite.prepare(
  `INSERT INTO jobs (type, status, payload, priority, attempts, max_attempts, run_at, created_at)
   VALUES ('pipeline_embed', 'queued', ?, 0, 0, 3, ?, ?)`,
);

export const pipelineChunk: JobHandler = async (payload) => {
  const itemId = String(payload.itemId ?? "");
  if (!itemId) throw new Error("pipeline_chunk: missing itemId in payload");

  const item = sqlite
    .prepare<[string], ItemRow>(`SELECT id, title, body, is_deleted FROM items WHERE id = ?`)
    .get(itemId);
  if (!item) throw new Error(`pipeline_chunk: item ${itemId} not found`);
  if (item.is_deleted) return; // nothing to index for a tombstoned item.

  const text = itemText(item.title, item.body);
  const passages = splitIntoChunks(text);
  if (passages.length === 0) return; // blank item — no chunks.

  const now = Date.now();

  const rechunk = sqlite.transaction(() => {
    // Clear old chunks + their vectors (vec0 has no FK) + meta, then re-insert.
    const oldIds = sqlite
      .prepare<[string], { id: number }>(`SELECT id FROM chunks WHERE item_id = ?`)
      .all(itemId)
      .map((r) => r.id);
    if (oldIds.length) {
      const del = sqlite.prepare(`DELETE FROM embeddings WHERE rowid = ?`);
      for (const id of oldIds) del.run(id);
    }
    sqlite.prepare(`DELETE FROM chunks WHERE item_id = ?`).run(itemId); // cascades embedding_meta

    const ins = sqlite.prepare(
      `INSERT INTO chunks (item_id, chunk_index, content, token_count, char_start, char_end, created_at)
       VALUES (?, ?, ?, ?, ?, ?, ?)`,
    );
    for (const p of passages) {
      ins.run(itemId, p.chunkIndex, p.content, p.tokenCount, p.charStart, p.charEnd, now);
    }
  });
  rechunk();

  enqueueEmbed.run(JSON.stringify({ itemId }), now, now);
};
