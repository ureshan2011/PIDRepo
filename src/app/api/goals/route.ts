import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin } from "@/lib/auth";
import { createGoal, listGoals } from "@/services/goals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/goals — list goals with milestones + progress. */
export async function GET() {
  return NextResponse.json({ goals: listGoals() });
}

const createSchema = z
  .object({
    title: z.string().min(1),
    description: z.string().nullable().optional(),
    category: z.string().nullable().optional(),
    status: z.enum(["active", "paused", "completed", "abandoned"]).optional(),
    targetDate: z.number().int().nullable().optional(),
  })
  .strict();

/** POST /api/goals — create a goal. */
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
  const goal = createGoal(parsed.data);
  return NextResponse.json({ goal }, { status: 201 });
}
