import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { checkOrigin } from "@/lib/auth";
import { deleteNote, getNote, updateNote } from "@/services/notes";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ itemId: string }> };

/** GET /api/notes/:itemId */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { itemId } = await params;
  const note = getNote(itemId);
  if (!note) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ note });
}

const patchSchema = z
  .object({
    title: z.string().min(1).optional(),
    body: z.string().nullable().optional(),
    notebook: z.string().nullable().optional(),
    tags: z.array(z.string()).optional(),
    pinned: z.boolean().optional(),
  })
  .strict();

/** PATCH /api/notes/:itemId */
export async function PATCH(req: NextRequest, { params }: Ctx) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const { itemId } = await params;
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
  const note = updateNote(itemId, parsed.data);
  if (!note) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ note });
}

/** DELETE /api/notes/:itemId */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const { itemId } = await params;
  const ok = deleteNote(itemId);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
