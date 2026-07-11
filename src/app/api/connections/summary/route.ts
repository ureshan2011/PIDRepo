import { NextResponse } from "next/server";
import { getSummary } from "@/services/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/connections/summary — rolled-up status for the TopBar sync dot. */
export async function GET() {
  return NextResponse.json(getSummary());
}
