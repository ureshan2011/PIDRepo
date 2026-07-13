import { asc, eq } from "drizzle-orm";
import { db } from "@/db/client";
import { newId } from "@/db/ids";
import { goals, milestones } from "@/db/schema";

/**
 * Goals + milestones service — CRUD over the app-owned `goals`/`milestones`
 * tables directly (not the items pattern). List includes milestone progress.
 * BUILD_SPEC §3.4 / §8.
 */

export type GoalStatus = "active" | "paused" | "completed" | "abandoned";
export type MilestoneStatus = "pending" | "in_progress" | "done";

export interface MilestoneDTO {
  id: string;
  goalId: string;
  title: string;
  targetDate: number | null;
  completedAt: number | null;
  status: MilestoneStatus;
  sortOrder: number;
}

export interface GoalDTO {
  id: string;
  title: string;
  description: string | null;
  category: string | null;
  status: GoalStatus;
  targetDate: number | null;
  createdAt: number;
  updatedAt: number;
  milestones: MilestoneDTO[];
  progress: { done: number; total: number; pct: number };
}

const ms = (d: Date | null | undefined): number | null => (d ? d.getTime() : null);

function milestoneToDto(r: typeof milestones.$inferSelect): MilestoneDTO {
  return {
    id: r.id,
    goalId: r.goalId,
    title: r.title,
    targetDate: ms(r.targetDate),
    completedAt: ms(r.completedAt),
    status: r.status as MilestoneStatus,
    sortOrder: r.sortOrder,
  };
}

function assembleGoal(g: typeof goals.$inferSelect, ms_: MilestoneDTO[]): GoalDTO {
  const total = ms_.length;
  const done = ms_.filter((m) => m.status === "done").length;
  const pct = total === 0 ? 0 : Math.round((done / total) * 100);
  return {
    id: g.id,
    title: g.title,
    description: g.description,
    category: g.category,
    status: g.status as GoalStatus,
    targetDate: ms(g.targetDate),
    createdAt: g.createdAt.getTime(),
    updatedAt: g.updatedAt.getTime(),
    milestones: ms_,
    progress: { done, total, pct },
  };
}

function listMilestones(goalId: string): MilestoneDTO[] {
  return db
    .select()
    .from(milestones)
    .where(eq(milestones.goalId, goalId))
    .orderBy(asc(milestones.sortOrder), asc(milestones.id))
    .all()
    .map(milestoneToDto);
}

/** List all goals with their milestones + progress rollup. */
export function listGoals(): GoalDTO[] {
  const gs = db.select().from(goals).orderBy(asc(goals.createdAt)).all();
  return gs.map((g) => assembleGoal(g, listMilestones(g.id)));
}

/** Fetch one goal with milestones + progress. */
export function getGoal(id: string): GoalDTO | null {
  const g = db.select().from(goals).where(eq(goals.id, id)).get();
  if (!g) return null;
  return assembleGoal(g, listMilestones(id));
}

export interface CreateGoalInput {
  title: string;
  description?: string | null;
  category?: string | null;
  status?: GoalStatus;
  targetDate?: number | null;
}

/** Create a goal. */
export function createGoal(input: CreateGoalInput): GoalDTO {
  const id = newId();
  const now = new Date();
  db.insert(goals)
    .values({
      id,
      title: input.title,
      description: input.description ?? null,
      category: input.category ?? null,
      status: input.status ?? "active",
      targetDate: input.targetDate != null ? new Date(input.targetDate) : null,
      createdAt: now,
      updatedAt: now,
    })
    .run();
  const created = getGoal(id);
  if (!created) throw new Error("goal creation failed");
  return created;
}

export interface UpdateGoalInput {
  title?: string;
  description?: string | null;
  category?: string | null;
  status?: GoalStatus;
  targetDate?: number | null;
}

/** Patch a goal's fields. */
export function updateGoal(id: string, patch: UpdateGoalInput): GoalDTO | null {
  const existing = db.select().from(goals).where(eq(goals.id, id)).get();
  if (!existing) return null;
  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.description !== undefined) set.description = patch.description;
  if (patch.category !== undefined) set.category = patch.category;
  if (patch.status !== undefined) set.status = patch.status;
  if (patch.targetDate !== undefined)
    set.targetDate = patch.targetDate != null ? new Date(patch.targetDate) : null;
  db.update(goals).set(set).where(eq(goals.id, id)).run();
  return getGoal(id);
}

/** Delete a goal (cascade removes its milestones). */
export function deleteGoal(id: string): boolean {
  const existing = db.select().from(goals).where(eq(goals.id, id)).get();
  if (!existing) return false;
  db.delete(goals).where(eq(goals.id, id)).run();
  return true;
}

export interface AddMilestoneInput {
  title: string;
  targetDate?: number | null;
  status?: MilestoneStatus;
  sortOrder?: number;
}

/** Add a milestone to a goal. Returns null if the goal does not exist. */
export function addMilestone(goalId: string, input: AddMilestoneInput): MilestoneDTO | null {
  const goal = db.select().from(goals).where(eq(goals.id, goalId)).get();
  if (!goal) return null;
  const id = newId();
  const nextOrder =
    input.sortOrder ??
    db.select().from(milestones).where(eq(milestones.goalId, goalId)).all().length;
  db.insert(milestones)
    .values({
      id,
      goalId,
      title: input.title,
      targetDate: input.targetDate != null ? new Date(input.targetDate) : null,
      completedAt: input.status === "done" ? new Date() : null,
      status: input.status ?? "pending",
      sortOrder: nextOrder,
    })
    .run();
  const row = db.select().from(milestones).where(eq(milestones.id, id)).get();
  return row ? milestoneToDto(row) : null;
}

export interface UpdateMilestoneInput {
  title?: string;
  targetDate?: number | null;
  status?: MilestoneStatus;
  sortOrder?: number;
}

/** Patch a milestone. Setting status='done' stamps completedAt. */
export function updateMilestone(id: string, patch: UpdateMilestoneInput): MilestoneDTO | null {
  const existing = db.select().from(milestones).where(eq(milestones.id, id)).get();
  if (!existing) return null;
  const set: Record<string, unknown> = {};
  if (patch.title !== undefined) set.title = patch.title;
  if (patch.targetDate !== undefined)
    set.targetDate = patch.targetDate != null ? new Date(patch.targetDate) : null;
  if (patch.sortOrder !== undefined) set.sortOrder = patch.sortOrder;
  if (patch.status !== undefined) {
    set.status = patch.status;
    set.completedAt = patch.status === "done" ? new Date() : null;
  }
  if (Object.keys(set).length > 0) {
    db.update(milestones).set(set).where(eq(milestones.id, id)).run();
  }
  const row = db.select().from(milestones).where(eq(milestones.id, id)).get();
  return row ? milestoneToDto(row) : null;
}

/** Mark a milestone done. */
export function completeMilestone(id: string): MilestoneDTO | null {
  return updateMilestone(id, { status: "done" });
}

/** Delete a milestone. */
export function deleteMilestone(id: string): boolean {
  const existing = db.select().from(milestones).where(eq(milestones.id, id)).get();
  if (!existing) return false;
  db.delete(milestones).where(eq(milestones.id, id)).run();
  return true;
}
