import { and, desc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { newId } from "@/db/ids";
import { items, notes } from "@/db/schema";
import { ensureAppSource } from "./tasks";

/**
 * Notes domain service — CRUD over `items` (type='note') + `notes` domain table
 * (notebook, tags, pinned). Manually-created notes attach to the shared app-owned
 * source via {@link ensureAppSource}. BUILD_SPEC §3.3 / §8.
 */

export interface NoteDTO {
  itemId: string;
  title: string;
  body: string | null;
  notebook: string | null;
  tags: string[];
  pinned: boolean;
  createdAt: number;
  updatedAt: number;
}

const selection = {
  itemId: notes.itemId,
  title: items.title,
  body: items.body,
  notebook: notes.notebook,
  tags: notes.tags,
  pinned: notes.pinned,
  createdAt: items.createdAt,
  updatedAt: items.updatedAt,
};

type Row = {
  itemId: string;
  title: string | null;
  body: string | null;
  notebook: string | null;
  tags: string[] | null;
  pinned: boolean;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(r: Row): NoteDTO {
  return {
    itemId: r.itemId,
    title: r.title ?? "",
    body: r.body,
    notebook: r.notebook,
    tags: r.tags ?? [],
    pinned: r.pinned,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

/** List notes (pinned first, then most recent). */
export function listNotes(): NoteDTO[] {
  const rows = db
    .select(selection)
    .from(notes)
    .innerJoin(items, eq(notes.itemId, items.id))
    .where(eq(items.isDeleted, false))
    .orderBy(desc(notes.pinned), desc(items.updatedAt))
    .all();
  return rows.map(toDto);
}

/** Fetch one note by item id. */
export function getNote(itemId: string): NoteDTO | null {
  const r = db
    .select(selection)
    .from(notes)
    .innerJoin(items, eq(notes.itemId, items.id))
    .where(and(eq(notes.itemId, itemId), eq(items.isDeleted, false)))
    .get();
  return r ? toDto(r) : null;
}

export interface CreateNoteInput {
  title: string;
  body?: string | null;
  notebook?: string | null;
  tags?: string[];
  pinned?: boolean;
}

/** Create a note: one `items` row (type='note') + one `notes` row. */
export function createNote(input: CreateNoteInput): NoteDTO {
  const sourceId = ensureAppSource();
  const id = newId();
  const now = new Date();

  db.transaction((tx) => {
    tx.insert(items)
      .values({
        id,
        type: "note",
        sourceId,
        externalId: id,
        title: input.title,
        body: input.body ?? null,
        bodyFormat: "markdown",
        occurredAt: now,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
        ingestedAt: now,
      })
      .run();
    tx.insert(notes)
      .values({
        itemId: id,
        notebook: input.notebook ?? null,
        tags: input.tags ?? [],
        pinned: input.pinned ?? false,
      })
      .run();
  });

  const created = getNote(id);
  if (!created) throw new Error("note creation failed");
  return created;
}

export interface UpdateNoteInput {
  title?: string;
  body?: string | null;
  notebook?: string | null;
  tags?: string[];
  pinned?: boolean;
}

/** Patch a note's item (title/body) and/or domain (notebook/tags/pinned) fields. */
export function updateNote(itemId: string, patch: UpdateNoteInput): NoteDTO | null {
  const existing = getNote(itemId);
  if (!existing) return null;
  const now = new Date();

  db.transaction((tx) => {
    if (patch.title !== undefined || patch.body !== undefined) {
      tx.update(items)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          updatedAt: now,
        })
        .where(eq(items.id, itemId))
        .run();
    } else {
      tx.update(items).set({ updatedAt: now }).where(eq(items.id, itemId)).run();
    }

    const noteSet: Record<string, unknown> = {};
    if (patch.notebook !== undefined) noteSet.notebook = patch.notebook;
    if (patch.tags !== undefined) noteSet.tags = patch.tags;
    if (patch.pinned !== undefined) noteSet.pinned = patch.pinned;
    if (Object.keys(noteSet).length > 0) {
      tx.update(notes).set(noteSet).where(eq(notes.itemId, itemId)).run();
    }
  });

  return getNote(itemId);
}

/** Hard-delete a note (cascade removes the `notes` row + FTS index entry). */
export function deleteNote(itemId: string): boolean {
  const existing = getNote(itemId);
  if (!existing) return false;
  db.delete(items).where(eq(items.id, itemId)).run();
  return true;
}
