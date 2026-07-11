import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin } from "@/lib/auth";
import { createTask, listTasks, type TaskFilter } from "@/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

const FILTERS: TaskFilter[] = ["all", "today", "overdue", "week", "open", "done"];

/** GET /api/tasks?filter=... — list tasks. */
export async function GET(req: NextRequest) {
  const raw = req.nextUrl.searchParams.get("filter");
  const filter: TaskFilter = raw && (FILTERS as string[]).includes(raw) ? (raw as TaskFilter) : "all";
  return NextResponse.json({ tasks: listTasks(filter) });
}

const createSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().nullable().optional(),
    status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
    priority: z.enum(["low", "medium", "high"]).nullable().optional(),
    dueAt: z.number().int().nullable().optional(),
    project: z.string().nullable().optional(),
  })
  .strict();

/** POST /api/tasks — create a task. */
export async function POST(req: NextRequest) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const task = createTask(parsed.data);
  return NextResponse.json({ task }, { status: 201 });
}
