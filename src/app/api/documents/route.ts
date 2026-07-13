import { extname } from "node:path";
import { NextRequest, NextResponse } from "next/server";
import { checkOrigin } from "@/lib/auth";
import {
  createDocument,
  isAllowedExtension,
  listDocuments,
  MAX_UPLOAD_BYTES,
  saveUpload,
} from "@/services/documents";

export const runtime = "nodejs";
export const dynamic = "force-dynamic";

/** GET /api/documents — list uploaded documents with parse status. */
export async function GET() {
  return NextResponse.json({ documents: listDocuments() });
}

/**
 * POST /api/documents — multipart upload of a single document file. Validates
 * extension + size, stores the bytes, creates the item/documents rows, and
 * enqueues parsing. Returns 201 with the new document summary.
 */
export async function POST(req: NextRequest) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }

  let form: FormData;
  try {
    form = await req.formData();
  } catch {
    return NextResponse.json({ error: "invalid_form_data" }, { status: 400 });
  }

  const file = form.get("file");
  if (!(file instanceof File)) {
    return NextResponse.json({ error: "missing_file" }, { status: 400 });
  }

  const originalName = file.name || "untitled";
  const ext = extname(originalName).toLowerCase();
  if (!isAllowedExtension(ext)) {
    return NextResponse.json(
      { error: "unsupported_type", message: "Allowed types: pdf, docx, pptx, txt, md" },
      { status: 415 },
    );
  }
  if (file.size > MAX_UPLOAD_BYTES) {
    return NextResponse.json(
      { error: "file_too_large", message: "Maximum file size is 25 MB" },
      { status: 400 },
    );
  }

  const bytes = new Uint8Array(await file.arrayBuffer());
  if (bytes.byteLength === 0) {
    return NextResponse.json({ error: "empty_file" }, { status: 400 });
  }
  if (bytes.byteLength > MAX_UPLOAD_BYTES) {
    return NextResponse.json({ error: "file_too_large" }, { status: 400 });
  }

  const saved = await saveUpload(bytes, originalName, file.type || null);
  const itemId = createDocument({
    originalName,
    filePath: saved.filePath,
    mimeType: saved.mimeType,
    sizeBytes: saved.sizeBytes,
    checksum: saved.checksum,
  });

  return NextResponse.json(
    {
      document: {
        itemId,
        title: originalName,
        mimeType: saved.mimeType,
        fileSizeBytes: saved.sizeBytes,
        status: "pending",
      },
    },
    { status: 201 },
  );
}
