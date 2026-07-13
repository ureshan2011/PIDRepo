import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin } from "@/lib/auth";
import { deleteMilestone, updateMilestone } from "@/services/goals";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ goalId: string; milestoneId: string }> };

const patchSchema = z
  .object({
    title: z.string().min(1).optional(),
    targetDate: z.number().int().nullable().optional(),
    status: z.enum(["pending", "in_progress", "done"]).optional(),
    sortOrder: z.number().int().optional(),
  })
  .strict();

/** PATCH /api/goals/:goalId/milestones/:milestoneId — update/complete a milestone. */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const { milestoneId } = await params;
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
  const milestone = updateMilestone(milestoneId, parsed.data);
  if (!milestone) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ milestone });
}

/** DELETE /api/goals/:goalId/milestones/:milestoneId */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const { milestoneId } = await params;
  const ok = deleteMilestone(milestoneId);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
