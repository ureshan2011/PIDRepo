import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin } from "@/lib/auth";
import { getAiSettings, setAiSettings } from "@/lib/settings";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/settings — returns the current AI runtime settings. */
export async function GET() {
  return NextResponse.json(getAiSettings());
}

const putSchema = z
  .object({
    "ai.baseUrl": z.string().url().optional(),
    "ai.chatModel": z.string().optional(),
    "ai.classifierModel": z.string().optional(),
    "ai.embeddingModel": z.string().optional(),
    "ai.apiKey": z.string().optional(),
    "ai.requestTimeoutMs": z.number().int().positive().optional(),
    "ai.contextWindowOverride": z.number().int().positive().optional(),
  })
  .strict();

/** PUT /api/settings — patch one or more AI runtime settings. */
export async function PUT(req: NextRequest) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }

  let body: unknown;
  try {
    body = await req.json();
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  const parsed = putSchema.safeParse(body);
  if (!parsed.success) {
    return NextResponse.json(
      { error: "validation_error", issues: parsed.error.flatten() },
      { status: 400 },
    );
  }

  setAiSettings(parsed.data);
  return NextResponse.json(getAiSettings());
}
