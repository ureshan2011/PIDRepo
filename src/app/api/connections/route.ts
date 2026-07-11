import { NextResponse } from "next/server";
import { listConnections } from "@/services/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/connections — sources joined to sync_state (health list). */
export async function GET() {
  return NextResponse.json({ accounts: listConnections() });
}
