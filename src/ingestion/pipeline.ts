/**
 * Chunking + embedding orchestration helpers used by the worker's pipeline
 * handlers (BUILD_SPEC §5 / §6). Pure/text-only logic lives here so the handlers
 * stay thin. No DB or LM Studio access in this module.
 */

export interface Passage {
  chunkIndex: number;
  content: string;
  charStart: number;
  charEnd: number;
  tokenCount: number;
}

/** Rough token estimate when no tokenizer is available (~4 chars/token). */
export function estimateTokens(text: string): number {
  return Math.max(1, Math.ceil(text.length / 4));
}

export interface ChunkOptions {
  /** Target passage size in characters (~512 tokens ≈ 2000 chars). */
  maxChars?: number;
  /** Overlap between consecutive passages, in characters. */
  overlapChars?: number;
}

/**
 * Split an item's text into ~512-token passages with a small overlap. Guarantees
 * at least one passage for any non-empty input; returns `[]` only for blank text.
 * Splitting is by character window (approximation) per spec — ~2000 chars/chunk
 * with ~200 overlap — but prefers to break on a paragraph/sentence/word boundary
 * near the window edge so passages don't split mid-word.
 */
export function splitIntoChunks(text: string, opts: ChunkOptions = {}): Passage[] {
  const maxChars = opts.maxChars ?? 2000;
  const overlap = Math.min(opts.overlapChars ?? 200, Math.floor(maxChars / 2));

  const trimmed = text.trim();
  if (trimmed.length === 0) return [];

  // Short item: a single passage.
  if (trimmed.length <= maxChars) {
    return [
      {
        chunkIndex: 0,
        content: trimmed,
        charStart: 0,
        charEnd: trimmed.length,
        tokenCount: estimateTokens(trimmed),
      },
    ];
  }

  const passages: Passage[] = [];
  let start = 0;
  let index = 0;

  while (start < trimmed.length) {
    let end = Math.min(start + maxChars, trimmed.length);

    // Try to end on a natural boundary within the last ~15% of the window.
    if (end < trimmed.length) {
      const windowStart = start + Math.floor(maxChars * 0.85);
      const slice = trimmed.slice(windowStart, end);
      const candidates = [slice.lastIndexOf("\n\n"), slice.lastIndexOf(". "), slice.lastIndexOf(" ")];
      const rel = candidates.find((i) => i > 0);
      if (rel !== undefined && rel > 0) end = windowStart + rel + 1;
    }

    const content = trimmed.slice(start, end).trim();
    if (content.length > 0) {
      passages.push({
        chunkIndex: index++,
        content,
        charStart: start,
        charEnd: end,
        tokenCount: estimateTokens(content),
      });
    }

    if (end >= trimmed.length) break;
    start = Math.max(end - overlap, start + 1);
  }

  return passages;
}

/**
 * Build the text to chunk for an item: title + body, so short items with only a
 * title still yield a usable passage.
 */
export function itemText(title: string | null | undefined, body: string | null | undefined): string {
  const t = (title ?? "").trim();
  const b = (body ?? "").trim();
  if (t && b) return `${t}\n\n${b}`;
  return t || b;
}
