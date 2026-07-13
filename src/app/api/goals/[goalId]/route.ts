import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin } from "@/lib/auth";
import { deleteGoal, getGoal, updateGoal } from "@/services/goals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ goalId: string }> };

/** GET /api/goals/:goalId */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { goalId } = await params;
  const goal = getGoal(goalId);
  if (!goal) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ goal });
}

const patchSchema = z
  .object({
    title: z.string().min(1).optional(),
    description: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    status: z.enum(["active", "paused", "completed", "abandoned"]).optional(),
    targetDate: z.number().int().nullable().optional(),
  })
  .strict();

/** PATCH /api/goals/:goalId */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const { goalId } = await params;
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
  const goal = updateGoal(goalId, parsed.data);
  if (!goal) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ goal });
}

/** DELETE /api/goals/:goalId */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const { goalId } = await params;
  const ok = deleteGoal(goalId);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
