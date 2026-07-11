import { NextResponse } from "next/server";
import { generateBriefing } from "@/services/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/overview/briefing — the AI daily briefing (real LM Studio call), with
 * a deterministic highlights fallback when LM Studio is down. Never 500s.
 * BUILD_SPEC §6.
 */
export async function GET() {
  const briefing = await generateBriefing();
  return NextResponse.json(briefing);
}
