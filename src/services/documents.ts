import { createHash } from "node:crypto";
import { mkdir, unlink, writeFile } from "node:fs/promises";
import { extname, isAbsolute, join, resolve } from "node:path";
import { sqlite } from "@/db/client";
import { newId } from "@/db/ids";
import { ensureAppSource } from "./tasks";

/**
 * Documents service (BUILD_SPEC Phase 2 slice). Owns local file storage plus the
 * `items` (type='document') + `documents` domain-row write/read/delete paths and
 * the `pipeline_parse` job enqueue. Uploaded bytes live under `PID_UPLOADS_DIR`
 * (default `./uploads`); the saved path + sha256 checksum + size are recorded on
 * the `documents` row. Parsing (text extraction) happens later in the worker's
 * `pipeline_parse` handler, which fills `items.body` and `documents.page_count`.
 *
 * Server-only (imports db + fs directly). Uses the raw better-sqlite3 handle to
 * mix item/domain inserts, job enqueue, and vec-row deletes in one transaction,
 * matching the ingest + pipeline handlers' style.
 */

/** Absolute path to the uploads directory (created lazily on first save). */
export function uploadsDir(): string {
  const configured = process.env.PID_UPLOADS_DIR ?? "./uploads";
  return isAbsolute(configured) ? configured : resolve(process.cwd(), configured);
}

/** Extensions accepted by the upload API, and their canonical MIME types. */
export const ALLOWED_EXTENSIONS = [".pdf", ".docx", ".pptx", ".txt", ".md"] as const;
export const MAX_UPLOAD_BYTES = 25 * 1024 * 1024; // ~25 MB

const CANONICAL_MIME: Record<string, string> = {
  ".pdf": "application/pdf",
  ".docx": "application/vnd.openxmlformats-officedocument.wordprocessingml.document",
  ".pptx": "application/vnd.openxmlformats-officedocument.presentationml.presentation",
  ".txt": "text/plain",
  ".md": "text/markdown",
};

export function isAllowedExtension(ext: string): boolean {
  return (ALLOWED_EXTENSIONS as readonly string[]).includes(ext.toLowerCase());
}

/** Canonical MIME for an extension, falling back to a caller-provided value. */
export function mimeForExtension(ext: string, fallback?: string | null): string {
  return CANONICAL_MIME[ext.toLowerCase()] ?? fallback ?? "application/octet-stream";
}

export interface SavedUpload {
  filePath: string;
  storedName: string;
  checksum: string;
  sizeBytes: number;
  ext: string;
  mimeType: string;
}

/**
 * Persist uploaded bytes to disk under a ULID-based filename (original extension
 * preserved) and compute the sha256 checksum + byte size.
 */
export async function saveUpload(
  bytes: Uint8Array,
  originalName: string,
  providedMime?: string | null,
): Promise<SavedUpload> {
  const ext = extname(originalName).toLowerCase();
  const dir = uploadsDir();
  await mkdir(dir, { recursive: true });

  const storedName = `${newId()}${ext}`;
  const filePath = join(dir, storedName);
  await writeFile(filePath, bytes);

  const checksum = createHash("sha256").update(bytes).digest("hex");
  return {
    filePath,
    storedName,
    checksum,
    sizeBytes: bytes.byteLength,
    ext,
    mimeType: mimeForExtension(ext, providedMime),
  };
}

const insertItem = sqlite.prepare(
  `INSERT INTO items
     (id, type, source_id, external_id, title, body, body_format, url,
      occurred_at, content_hash, metadata, is_deleted, created_at, updated_at, ingested_at)
   VALUES (?, 'document', ?, ?, ?, NULL, 'text', NULL, NULL, NULL, NULL, 0, ?, ?, ?)`,
);
const insertDocument = sqlite.prepare(
  `INSERT INTO documents (item_id, file_path, mime_type, file_size_bytes, page_count, checksum)
   VALUES (?, ?, ?, ?, NULL, ?)`,
);
const enqueueParse = sqlite.prepare(
  `INSERT INTO jobs (type, status, payload, priority, attempts, max_attempts, run_at, created_at)
   VALUES ('pipeline_parse', 'queued', ?, 0, 0, 3, ?, ?)`,
);

export interface CreateDocumentInput {
  originalName: string;
  filePath: string;
  mimeType: string;
  sizeBytes: number;
  checksum: string;
}

/**
 * Create the `items` + `documents` rows for a saved upload and enqueue a
 * `pipeline_parse` job (which chains parse -> chunk -> embed). Runs atomically.
 * Returns the new item id.
 */
export function createDocument(input: CreateDocumentInput): string {
  const sourceId = ensureAppSource("documents");
  const id = newId();
  const now = Date.now();

  const run = sqlite.transaction(() => {
    insertItem.run(id, sourceId, id, input.originalName, now, now, now);
    insertDocument.run(id, input.filePath, input.mimeType, input.sizeBytes, input.checksum);
    enqueueParse.run(JSON.stringify({ itemId: id }), now, now);
  });
  run();
  return id;
}

export type DocumentParseStatus = "pending" | "parsed" | "failed";

export interface DocumentDTO {
  itemId: string;
  title: string;
  mimeType: string | null;
  fileSizeBytes: number | null;
  pageCount: number | null;
  status: DocumentParseStatus;
  createdAt: number;
}

interface DocRow {
  item_id: string;
  title: string | null;
  mime_type: string | null;
  file_size_bytes: number | null;
  page_count: number | null;
  body: string | null;
  created_at: number;
}

/** Item ids of documents whose most-recent `pipeline_parse` job ended in failure. */
function failedParseItemIds(): Set<string> {
  const rows = sqlite
    .prepare<[], { item_id: string | null }>(
      `SELECT json_extract(payload, '$.itemId') AS item_id
         FROM jobs WHERE type = 'pipeline_parse' AND status = 'failed'`,
    )
    .all();
  const set = new Set<string>();
  for (const r of rows) if (r.item_id) set.add(r.item_id);
  return set;
}

function statusFor(row: DocRow, failed: Set<string>): DocumentParseStatus {
  if (row.body && row.body.trim().length > 0) return "parsed";
  if (failed.has(row.item_id)) return "failed";
  return "pending";
}

/** List documents (items ⋈ documents), newest first, with a derived parse status. */
export function listDocuments(): DocumentDTO[] {
  const rows = sqlite
    .prepare<[], DocRow>(
      `SELECT i.id AS item_id, i.title, d.mime_type, d.file_size_bytes, d.page_count,
              i.body, i.created_at
         FROM documents d
         JOIN items i ON i.id = d.item_id
        WHERE i.is_deleted = 0
        ORDER BY i.created_at DESC`,
    )
    .all();
  const failed = failedParseItemIds();
  return rows.map((r) => ({
    itemId: r.item_id,
    title: r.title ?? "",
    mimeType: r.mime_type,
    fileSizeBytes: r.file_size_bytes,
    pageCount: r.page_count,
    status: statusFor(r, failed),
    createdAt: r.created_at,
  }));
}

export interface DocumentDetailDTO extends DocumentDTO {
  filePath: string | null;
  checksum: string | null;
  /** First ~4000 chars of extracted text (null until parsed). */
  textPreview: string | null;
  chunkCount: number;
}

interface DetailRow extends DocRow {
  file_path: string | null;
  checksum: string | null;
}

const PREVIEW_CHARS = 4000;

/** Fetch one document with an extracted-text preview + chunk count. */
export function getDocument(itemId: string): DocumentDetailDTO | null {
  const row = sqlite
    .prepare<[string], DetailRow>(
      `SELECT i.id AS item_id, i.title, d.mime_type, d.file_size_bytes, d.page_count,
              i.body, i.created_at, d.file_path, d.checksum
         FROM documents d
         JOIN items i ON i.id = d.item_id
        WHERE d.item_id = ? AND i.is_deleted = 0`,
    )
    .get(itemId);
  if (!row) return null;

  const chunkCount = sqlite
    .prepare<[string], { n: number }>(`SELECT COUNT(*) AS n FROM chunks WHERE item_id = ?`)
    .get(itemId);

  const failed = failedParseItemIds();
  return {
    itemId: row.item_id,
    title: row.title ?? "",
    mimeType: row.mime_type,
    fileSizeBytes: row.file_size_bytes,
    pageCount: row.page_count,
    status: statusFor(row, failed),
    createdAt: row.created_at,
    filePath: row.file_path,
    checksum: row.checksum,
    textPreview: row.body ? row.body.slice(0, PREVIEW_CHARS) : null,
    chunkCount: chunkCount?.n ?? 0,
  };
}

/**
 * Hard-delete a document: remove the item row (cascades documents + chunks +
 * embedding_meta), delete the orphaned `embeddings` vec rows in the same
 * transaction (vec0 has no SQL FK — mirrors the pipeline handlers), then unlink
 * the stored file from disk. Returns false if the document does not exist.
 */
export async function deleteDocument(itemId: string): Promise<boolean> {
  const row = sqlite
    .prepare<[string], { file_path: string | null }>(
      `SELECT d.file_path FROM documents d
         JOIN items i ON i.id = d.item_id
        WHERE d.item_id = ? AND i.is_deleted = 0`,
    )
    .get(itemId);
  if (!row) return false;

  const run = sqlite.transaction(() => {
    const chunkIds = sqlite
      .prepare<[string], { id: number }>(`SELECT id FROM chunks WHERE item_id = ?`)
      .all(itemId)
      .map((c) => c.id);
    if (chunkIds.length) {
      const del = sqlite.prepare(`DELETE FROM embeddings WHERE rowid = ?`);
      for (const id of chunkIds) del.run(id);
    }
    sqlite.prepare(`DELETE FROM items WHERE id = ?`).run(itemId); // cascades documents + chunks + meta
  });
  run();

  if (row.file_path) {
    try {
      await unlink(row.file_path);
    } catch {
      // File already gone / never written — deletion of DB rows still succeeded.
    }
  }
  return true;
}
