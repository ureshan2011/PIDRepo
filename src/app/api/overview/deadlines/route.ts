import { NextResponse } from "next/server";
import { getDeadlines } from "@/services/overview";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/overview/deadlines — overdue/today/this-week open tasks. */
export async function GET() {
  return NextResponse.json({ deadlines: getDeadlines() });
}
