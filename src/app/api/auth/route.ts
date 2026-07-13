import { NextRequest, NextResponse } from "next/server";
import {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  checkOrigin,
  createSessionToken,
  verifyPassphrase,
} from "@/lib/auth";

export const runtime = "nodejs";

const cookieOptions = {
  httpOnly: true,
  sameSite: "lax" as const,
  secure: false, // 127.0.0.1 only; no TLS locally.
  path: "/",
};

/** POST /api/auth — passphrase login; sets an httpOnly session cookie. */
export async function POST(req: NextRequest) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }

  let passphrase = "";
  try {
    const body = (await req.json()) as { passphrase?: unknown };
    passphrase = typeof body.passphrase === "string" ? body.passphrase : "";
  } catch {
    return NextResponse.json({ error: "invalid_body" }, { status: 400 });
  }

  if (!verifyPassphrase(passphrase)) {
    return NextResponse.json({ error: "invalid_passphrase" }, { status: 401 });
  }

  const token = await createSessionToken();
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, token, { ...cookieOptions, maxAge: SESSION_MAX_AGE_S });
  return res;
}

/** DELETE /api/auth — logout; clears the session cookie. */
export async function DELETE(req: NextRequest) {
  if (!checkOrigin(req.headers)) {
    return NextResponse.json({ error: "bad_origin" }, { status: 403 });
  }
  const res = NextResponse.json({ ok: true });
  res.cookies.set(SESSION_COOKIE, "", { ...cookieOptions, maxAge: 0 });
  return res;
}
