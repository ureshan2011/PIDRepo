/**
 * Edge-safe session + request-origin helpers. Uses Web Crypto (available in both
 * the Edge middleware runtime and Node) so `middleware.ts` can import these
 * without pulling in `node:crypto`. Passphrase hashing (node scrypt) lives in
 * `src/lib/auth.ts`, which re-exports these. BUILD_SPEC §7.
 */

export const SESSION_COOKIE = "pid_session";
export const SESSION_MAX_AGE_S = 60 * 60 * 24 * 30; // 30 days

/** Local origins the app trusts (127.0.0.1-only binding + localhost alias). */
const ALLOWED_HOSTS = new Set([
  "127.0.0.1:3000",
  "localhost:3000",
  "127.0.0.1",
  "localhost",
]);

function sessionSecret(): string {
  return (
    process.env.PID_SESSION_SECRET ??
    process.env.PID_PASSPHRASE_HASH ??
    "pid-dev-session-secret"
  );
}

function b64urlEncode(bytes: Uint8Array): string {
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin).replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

function b64urlDecode(s: string): Uint8Array {
  const pad = s.length % 4 === 0 ? "" : "=".repeat(4 - (s.length % 4));
  const bin = atob(s.replace(/-/g, "+").replace(/_/g, "/") + pad);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

async function hmacKey(): Promise<CryptoKey> {
  return crypto.subtle.importKey(
    "raw",
    new TextEncoder().encode(sessionSecret()),
    { name: "HMAC", hash: "SHA-256" },
    false,
    ["sign", "verify"],
  );
}

/** Create a signed session token with an embedded expiry. */
export async function createSessionToken(
  maxAgeS: number = SESSION_MAX_AGE_S,
): Promise<string> {
  const payload = JSON.stringify({ exp: Date.now() + maxAgeS * 1000 });
  const payloadB64 = b64urlEncode(new TextEncoder().encode(payload));
  const key = await hmacKey();
  const sig = await crypto.subtle.sign("HMAC", key, new TextEncoder().encode(payloadB64));
  return `${payloadB64}.${b64urlEncode(new Uint8Array(sig))}`;
}

/** Verify a session token's signature and expiry. */
export async function verifySessionToken(token: string | undefined | null): Promise<boolean> {
  if (!token) return false;
  const dot = token.indexOf(".");
  if (dot < 0) return false;
  const payloadB64 = token.slice(0, dot);
  const sigB64 = token.slice(dot + 1);
  try {
    const key = await hmacKey();
    const ok = await crypto.subtle.verify(
      "HMAC",
      key,
      b64urlDecode(sigB64),
      new TextEncoder().encode(payloadB64),
    );
    if (!ok) return false;
    const { exp } = JSON.parse(new TextDecoder().decode(b64urlDecode(payloadB64))) as {
      exp: number;
    };
    return typeof exp === "number" && exp > Date.now();
  } catch {
    return false;
  }
}

/**
 * CSRF / DNS-rebinding guard: the request Host must be a trusted local host, and
 * if an Origin header is present it must match that host. Returns true if OK.
 */
export function checkOrigin(headers: Headers): boolean {
  const host = headers.get("host");
  if (!host || !ALLOWED_HOSTS.has(host)) return false;

  const origin = headers.get("origin");
  if (origin) {
    try {
      const originHost = new URL(origin).host;
      if (originHost !== host) return false;
    } catch {
      return false;
    }
  }
  return true;
}
