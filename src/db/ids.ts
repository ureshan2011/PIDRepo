import { ulid } from "ulid";

/**
 * Generate a ULID — a 26-char, lexicographically time-sortable identifier used
 * as the primary key for all cross-boundary / user-referenced rows.
 */
export function newId(): string {
  return ulid();
}

// Alias matching the spec's `ulid()` helper naming.
export { ulid };
