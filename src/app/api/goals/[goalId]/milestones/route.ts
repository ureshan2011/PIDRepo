import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin } from "@/lib/auth";
import { addMilestone, getGoal } from "@/services/goals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ goalId: string }> };

/** GET /api/goals/:goalId/milestones — list milestones for a goal. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { goalId } = await params;
  const goal = getGoal(goalId);
  if (!goal) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ milestones: goal.milestones });
}

const createSchema = z
  .object({
    title: z.string().min(1),
    targetDate: z.number().int().nullable().optional(),
    status: z.enum(["pending", "in_progress", "done"]).optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

/** POST /api/goals/:goalId/milestones — add a milestone. */
export async function POST(req: NextRequest, { params }: Ctx) {
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
  const parsed = createSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }
  const milestone = addMilestone(goalId, parsed.data);
  if (!milestone) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ milestone }, { status: 201 });
}
