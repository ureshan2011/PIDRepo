import { NextResponse } from "next/server";
import { refreshAvailability } from "@/lib/lm-studio";
import { getAiSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/**
 * GET /api/health/lm-studio — pings the configured LM Studio `GET /v1/models`
 * and reports reachability + which configured models are loaded. Degrades
 * loudly: returns `reachable:false` (HTTP 200) when LM Studio is down, never
 * throws/500. BUILD_SPEC §6.
 */
export async function GET() {
  const s = getAiSettings();
  const st = await refreshAvailability(true);
  const models = st.models;

  return NextResponse.json({
    reachable: st.available,
    baseUrl: s["ai.baseUrl"],
    models,
    chatModelLoaded: models.includes(s["ai.chatModel"]),
    embeddingModelLoaded: models.includes(s["ai.embeddingModel"]),
    checkedAt: Date.now(),
  });
}
