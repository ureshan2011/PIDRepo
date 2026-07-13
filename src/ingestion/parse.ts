import { readFile } from "node:fs/promises";
import { extname } from "node:path";

/**
 * Document text extraction (BUILD_SPEC §2 ingestion; docs/04 parsing summary).
 * Dispatches by file kind to the libraries named in the tech-stack table:
 *   - PDF  -> pdf-parse (wraps pdfjs-dist)
 *   - DOCX -> mammoth (extractRawText)
 *   - PPTX -> officeparser (per-slide text)
 *   - txt/md -> read directly as UTF-8
 * Returns extracted plain text plus an optional page/slide count. Throws a typed
 * {@link DocumentParseError} on any parse failure so the worker can mark the job
 * failed with a clear message instead of crashing the loop.
 *
 * These libraries are declared in `next.config.ts` `serverExternalPackages` so the
 * Next build never tries to bundle their dynamic requires / native deps.
 */

export type DocumentKind = "pdf" | "docx" | "pptx" | "txt" | "md";

export interface ParsedDocument {
  text: string;
  /** Pages (PDF) or slides (PPTX); undefined for formats without a page concept. */
  pageCount?: number;
}

export class DocumentParseError extends Error {
  constructor(
    message: string,
    public readonly cause?: unknown,
  ) {
    super(message);
    this.name = "DocumentParseError";
  }
}

const EXT_KIND: Record<string, DocumentKind> = {
  ".pdf": "pdf",
  ".docx": "docx",
  ".pptx": "pptx",
  ".txt": "txt",
  ".md": "md",
  ".markdown": "md",
};

const MIME_KIND: Record<string, DocumentKind> = {
  "application/pdf": "pdf",
  "application/vnd.openxmlformats-officedocument.wordprocessingml.document": "docx",
  "application/vnd.openxmlformats-officedocument.presentationml.presentation": "pptx",
  "text/plain": "txt",
  "text/markdown": "md",
  "text/x-markdown": "md",
};

/**
 * Resolve a document kind from a file path and/or MIME type. Extension wins (the
 * stored file preserves the original extension); MIME is the fallback. Returns
 * null when the input is not one of the supported kinds.
 */
export function resolveDocumentKind(
  filePath: string,
  mimeType?: string | null,
): DocumentKind | null {
  const ext = extname(filePath).toLowerCase();
  return EXT_KIND[ext] ?? (mimeType ? (MIME_KIND[mimeType.toLowerCase()] ?? null) : null);
}

/** Extract plain text (and page/slide count where available) from a document file. */
export async function parseFile(filePath: string, mimeType?: string | null): Promise<ParsedDocument> {
  const kind = resolveDocumentKind(filePath, mimeType);
  if (!kind) {
    throw new DocumentParseError(`unsupported document type for "${filePath}" (mime: ${mimeType ?? "unknown"})`);
  }

  try {
    switch (kind) {
      case "pdf": {
        const { PDFParse } = await import("pdf-parse");
        const data = await readFile(filePath);
        const parser = new PDFParse({ data: new Uint8Array(data) });
        try {
          const result = await parser.getText();
          return { text: result.text ?? "", pageCount: result.total };
        } finally {
          await parser.destroy();
        }
      }
      case "docx": {
        const mammoth = (await import("mammoth")).default;
        const buffer = await readFile(filePath);
        const result = await mammoth.extractRawText({ buffer });
        return { text: result.value ?? "" };
      }
      case "pptx": {
        const { parseOffice } = await import("officeparser");
        const buffer = await readFile(filePath);
        const ast = await parseOffice(buffer, { fileType: "pptx" });
        return { text: ast.toText(), pageCount: ast.content.length };
      }
      case "txt":
      case "md": {
        const text = await readFile(filePath, "utf8");
        return { text };
      }
    }
  } catch (err) {
    if (err instanceof DocumentParseError) throw err;
    const message = err instanceof Error ? err.message : String(err);
    throw new DocumentParseError(`failed to parse ${kind} document: ${message}`, err);
  }
}
