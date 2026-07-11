import { and, desc, eq, gte, inArray, lt, lte } from "drizzle-orm";
import { db } from "@/db/client";
import { newId } from "@/db/ids";
import { items, sources, tasks } from "@/db/schema";

/**
 * Tasks domain service — CRUD over the `items` (type='task') + `tasks` domain
 * table pattern. Server-only (imports db directly). BUILD_SPEC §3.3 / §8.
 *
 * App-owned source decision: `items.source_id` is NOT NULL and FKs `sources`, so
 * manually-created items need a source row. We lazily ensure ONE app-owned source
 * (`connector_id='app'`, `account_id='manual'`, `category='app'`, display name
 * "PID (manual)") and attach every hand-created task/note item to it. The row is
 * idempotent on the (connector_id, account_id) unique index. It is intentionally
 * excluded from the Connections health list (it is not a connector). See
 * `ensureAppSource` below — shared by the notes service too.
 */

const APP_CONNECTOR_ID = "app";
const APP_ACCOUNT_ID = "manual";

/** Lazily ensure the single app-owned `sources` row exists; returns its id. */
export function ensureAppSource(): string {
  const existing = db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.connectorId, APP_CONNECTOR_ID), eq(sources.accountId, APP_ACCOUNT_ID)))
    .get();
  if (existing) return existing.id;

  const id = newId();
  const now = new Date();
  db.insert(sources)
    .values({
      id,
      connectorId: APP_CONNECTOR_ID,
      accountId: APP_ACCOUNT_ID,
      displayName: "PID (manual)",
      category: "app",
      enabled: true,
      status: "ok",
      createdAt: now,
      updatedAt: now,
    })
    .onConflictDoNothing({ target: [sources.connectorId, sources.accountId] })
    .run();

  // Re-read to cover the race where a concurrent insert won.
  const row = db
    .select({ id: sources.id })
    .from(sources)
    .where(and(eq(sources.connectorId, APP_CONNECTOR_ID), eq(sources.accountId, APP_ACCOUNT_ID)))
    .get();
  return row?.id ?? id;
}

export type TaskStatus = "open" | "in_progress" | "done" | "cancelled";
export type TaskPriority = "low" | "medium" | "high";
export type TaskFilter = "all" | "today" | "overdue" | "week" | "open" | "done";

export interface TaskDTO {
  itemId: string;
  title: string;
  body: string | null;
  status: TaskStatus;
  priority: TaskPriority | null;
  dueAt: number | null;
  completedAt: number | null;
  project: string | null;
  createdAt: number;
  updatedAt: number;
}

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

function startOfToday(): Date {
  const d = new Date();
  d.setHours(0, 0, 0, 0);
  return d;
}
function endOfToday(): Date {
  const d = new Date();
  d.setHours(23, 59, 59, 999);
  return d;
}
function endOfWeek(): Date {
  const d = startOfToday();
  d.setDate(d.getDate() + 7);
  d.setHours(23, 59, 59, 999);
  return d;
}

const OPEN_STATES: TaskStatus[] = ["open", "in_progress"];

const selection = {
  itemId: tasks.itemId,
  title: items.title,
  body: items.body,
  status: tasks.status,
  priority: tasks.priority,
  dueAt: tasks.dueAt,
  completedAt: tasks.completedAt,
  project: tasks.project,
  createdAt: items.createdAt,
  updatedAt: items.updatedAt,
};

type Row = {
  itemId: string;
  title: string | null;
  body: string | null;
  status: string;
  priority: string | null;
  dueAt: Date | null;
  completedAt: Date | null;
  project: string | null;
  createdAt: Date;
  updatedAt: Date;
};

function toDto(r: Row): TaskDTO {
  return {
    itemId: r.itemId,
    title: r.title ?? "",
    body: r.body,
    status: r.status as TaskStatus,
    priority: (r.priority as TaskPriority | null) ?? null,
    dueAt: ms(r.dueAt),
    completedAt: ms(r.completedAt),
    project: r.project,
    createdAt: r.createdAt.getTime(),
    updatedAt: r.updatedAt.getTime(),
  };
}

/** List tasks, optionally filtered by a named window or status. */
export function listTasks(filter: TaskFilter = "all"): TaskDTO[] {
  const conds = [eq(items.isDeleted, false)];
  switch (filter) {
    case "today":
      conds.push(gte(tasks.dueAt, startOfToday()), lte(tasks.dueAt, endOfToday()));
      break;
    case "overdue":
      conds.push(lt(tasks.dueAt, startOfToday()), inArray(tasks.status, OPEN_STATES));
      break;
    case "week":
      conds.push(gte(tasks.dueAt, startOfToday()), lte(tasks.dueAt, endOfWeek()));
      break;
    case "open":
      conds.push(inArray(tasks.status, OPEN_STATES));
      break;
    case "done":
      conds.push(eq(tasks.status, "done"));
      break;
    case "all":
    default:
      break;
  }

  const rows = db
    .select(selection)
    .from(tasks)
    .innerJoin(items, eq(tasks.itemId, items.id))
    .where(and(...conds))
    .orderBy(desc(items.createdAt))
    .all();
  return rows.map(toDto);
}

/** Fetch one task by item id. */
export function getTask(itemId: string): TaskDTO | null {
  const r = db
    .select(selection)
    .from(tasks)
    .innerJoin(items, eq(tasks.itemId, items.id))
    .where(and(eq(tasks.itemId, itemId), eq(items.isDeleted, false)))
    .get();
  return r ? toDto(r) : null;
}

export interface CreateTaskInput {
  title: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority | null;
  dueAt?: number | null;
  project?: string | null;
}

/** Create a task: one `items` row (type='task') + one `tasks` row. */
export function createTask(input: CreateTaskInput): TaskDTO {
  const sourceId = ensureAppSource();
  const id = newId();
  const now = new Date();
  const status = input.status ?? "open";

  db.transaction((tx) => {
    tx.insert(items)
      .values({
        id,
        type: "task",
        sourceId,
        externalId: id,
        title: input.title,
        body: input.body ?? null,
        bodyFormat: "text",
        occurredAt: input.dueAt != null ? new Date(input.dueAt) : null,
        isDeleted: false,
        createdAt: now,
        updatedAt: now,
        ingestedAt: now,
      })
      .run();
    tx.insert(tasks)
      .values({
        itemId: id,
        status,
        priority: input.priority ?? null,
        dueAt: input.dueAt != null ? new Date(input.dueAt) : null,
        completedAt: status === "done" ? now : null,
        project: input.project ?? null,
      })
      .run();
  });

  const created = getTask(id);
  if (!created) throw new Error("task creation failed");
  return created;
}

export interface UpdateTaskInput {
  title?: string;
  body?: string | null;
  status?: TaskStatus;
  priority?: TaskPriority | null;
  dueAt?: number | null;
  project?: string | null;
}

/** Patch a task's item (title/body) and/or domain (status/priority/due/project) fields. */
export function updateTask(itemId: string, patch: UpdateTaskInput): TaskDTO | null {
  const existing = getTask(itemId);
  if (!existing) return null;
  const now = new Date();

  db.transaction((tx) => {
    if (patch.title !== undefined || patch.body !== undefined || patch.dueAt !== undefined) {
      tx.update(items)
        .set({
          ...(patch.title !== undefined ? { title: patch.title } : {}),
          ...(patch.body !== undefined ? { body: patch.body } : {}),
          ...(patch.dueAt !== undefined
            ? { occurredAt: patch.dueAt != null ? new Date(patch.dueAt) : null }
            : {}),
          updatedAt: now,
        })
        .where(eq(items.id, itemId))
        .run();
    }

    const taskSet: Record<string, unknown> = {};
    if (patch.status !== undefined) {
      taskSet.status = patch.status;
      taskSet.completedAt = patch.status === "done" ? now : null;
    }
    if (patch.priority !== undefined) taskSet.priority = patch.priority;
    if (patch.dueAt !== undefined) taskSet.dueAt = patch.dueAt != null ? new Date(patch.dueAt) : null;
    if (patch.project !== undefined) taskSet.project = patch.project;
    if (Object.keys(taskSet).length > 0) {
      tx.update(tasks).set(taskSet).where(eq(tasks.itemId, itemId)).run();
    }
  });

  return getTask(itemId);
}

/** Mark a task done (sets completedAt). */
export function completeTask(itemId: string): TaskDTO | null {
  return updateTask(itemId, { status: "done" });
}

/** Reopen a done task (clears completedAt). */
export function reopenTask(itemId: string): TaskDTO | null {
  return updateTask(itemId, { status: "open" });
}

/** Hard-delete a task (cascade removes the `tasks` row + FTS index entry). */
export function deleteTask(itemId: string): boolean {
  const existing = getTask(itemId);
  if (!existing) return false;
  db.delete(items).where(eq(items.id, itemId)).run();
  return true;
}
