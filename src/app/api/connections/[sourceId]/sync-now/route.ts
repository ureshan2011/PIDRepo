import { NextRequest, NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth";
import { enqueueSyncNow } from "@/services/connections";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ sourceId: string }> };

/** POST /api/connections/:sourceId/sync-now — enqueue an on-demand connector_sync job. */
export async function POST(req: NextRequest, { params }: Ctx) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const { sourceId } = await params;
  const res = enqueueSyncNow(sourceId);
  if (!res.ok) {
    const status = res.error === "not_found" ? 404 : 400;
    return NextResponse.json({ error: res.error }, { status });
  }
  return NextResponse.json({ ok: true, jobId: res.jobId }, { status: 202 });
}
