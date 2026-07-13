import { NextRequest, NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth";
import { deleteDocument, getDocument } from "@/services/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

type Ctx = { params: Promise<{ itemId: string }> };

/** GET /api/documents/:itemId — detail + extracted-text preview. */
export async function GET(_req: NextRequest, { params }: Ctx) {
  const { itemId } = await params;
  const document = getDocument(itemId);
  if (!document) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ document });
}

/** DELETE /api/documents/:itemId — removes rows, vec embeddings, and the file. */
export async function DELETE(req: NextRequest, { params }: Ctx) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const { itemId } = await params;
  const ok = await deleteDocument(itemId);
  if (!ok) return NextResponse.json({ error: "not_found" }, { status: 404 });
  return NextResponse.json({ ok: true });
}
