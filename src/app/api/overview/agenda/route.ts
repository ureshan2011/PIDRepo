import { NextResponse } from "next/server";
import { getAgenda, getStats } from "@/services/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/overview/agenda — today's/this-week's events + stat counts. */
export async function GET() {
  return NextResponse.json({ agenda: getAgenda(), stats: getStats() });
}
