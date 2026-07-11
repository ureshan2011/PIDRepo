import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin } from "@/lib/auth";
import { createNote, listNotes } from "@/services/notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/notes — list notes. */
export async function GET() {
  return NextResponse.json({ notes: listNotes() });
}

const createSchema = z
  .object({
    title: z.string().min(1),
    body: z.string().nullable().optional(),
    notebook: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

/** POST /api/notes — create a note. */
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
  const note = createNote(parsed.data);
  return NextResponse.json({ note }, { status: 201 });
}
