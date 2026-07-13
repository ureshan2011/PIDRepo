import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin } from "@/lib/auth";
import { deleteTask, getTask, updateTask } from "@/services/tasks";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ itemId: string }> };

/** GET /api/tasks/:itemId */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { itemId } = await params;
  const task = getTask(itemId);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ task });
}

const patchSchema = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    status: z.enum(["open", "in_progress", "done", "cancelled"]).optional(),
    priority: z.enum(["low", "medium", "high"]).nullable().optional(),
    dueAt: z.number().int().nullable().optional(),
    project: z.string().nullable().optional(),
  })
  .strict();

/** PATCH /api/tasks/:itemId — update (also handles complete/reopen via status). */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const { itemId } = await params;
  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }
  const parsed = patchSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const task = updateTask(itemId, parsed.data);
  if (!task) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ task });
}

/** DELETE /api/tasks/:itemId */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const { itemId } = await params;
  const ok = deleteTask(itemId);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
