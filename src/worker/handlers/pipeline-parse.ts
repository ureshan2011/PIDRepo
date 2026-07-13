import { createHash } from "node:crypto";
import { sqlite } from "@/db/client";
import { parseFile } from "@/ingestion/parse";
import type { JobHandler } from "../dispatch";

/**
 * `pipeline_parse` handler (BUILD_SPEC Phase 2 slice). Payload `{ itemId }`.
 *
 * Loads a document item + its `documents` row, extracts text from the stored file
 * (PDF/DOCX/PPTX/txt/md via `ingestion/parse`), then:
 *   - updates `items.body` / `body_format` / `content_hash` with the extracted text,
 *   - sets `documents.page_count` where the format exposes one,
 *   - enqueues `pipeline_chunk` (which chains to `pipeline_embed`).
 *
 * A missing file or parse failure THROWS with a clear message so the worker marks
 * the job failed (after retries) — it never crashes the poll loop. Feeds the exact
 * same chunk -> embed pipeline the connector path uses.
 */

interface DocRow {
  id: string;
  is_deleted: number;
  file_path: string | null;
  mime_type: string | null;
}

const enqueueChunk = sqlite.prepare(
  `INSERT INTO jobs (type, status, payload, priority, attempts, max_attempts, run_at, created_at)
   VALUES ('pipeline_chunk', 'queued', ?, 0, 0, 3, ?, ?)`,
);

/** Normalized content hash over title+body, matching services/ingest. */
function contentHashOf(title: string | null, body: string): string {
  const norm = `${title ?? ""}\n${body}`.toLowerCase().replace(/\s+/g, " ").trim();
  return createHash("sha256").update(norm).digest("hex");
}

export const pipelineParse: JobHandler = async (payload) => {
  const itemId = String(payload.itemId ?? "");
  if (!itemId) throw new Error("pipeline_parse: missing itemId in payload");

  const row = sqlite
    .prepare<[string], DocRow>(
      `SELECT i.id, i.is_deleted, d.file_path, d.mime_type
         FROM items i JOIN documents d ON d.item_id = i.id
        WHERE i.id = ?`,
    )
    .get(itemId);
  if (!row) throw new Error(`pipeline_parse: document item ${itemId} not found`);
  if (row.is_deleted) return; // tombstoned — nothing to parse.
  if (!row.file_path) throw new Error(`pipeline_parse: document ${itemId} has no file_path`);

  const parsed = await parseFile(row.file_path, row.mime_type);
  const text = parsed.text ?? "";

  const title = sqlite
    .prepare<[string], { title: string | null }>(`SELECT title FROM items WHERE id = ?`)
    .get(itemId);
  const isMarkdown = row.file_path.toLowerCase().endsWith(".md");
  const now = Date.now();

  const write = sqlite.transaction(() => {
    sqlite
      .prepare(
        `UPDATE items SET body = ?, body_format = ?, content_hash = ?, updated_at = ? WHERE id = ?`,
      )
      .run(text, isMarkdown ? "markdown" : "text", contentHashOf(title?.title ?? null, text), now, itemId);
    if (parsed.pageCount != null) {
      sqlite.prepare(`UPDATE documents SET page_count = ? WHERE item_id = ?`).run(parsed.pageCount, itemId);
    }
    enqueueChunk.run(JSON.stringify({ itemId }), now, now);
  });
  write();
};
