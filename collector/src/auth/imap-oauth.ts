/**
 * IMAP authentication (docs/15 §3.4 GMAIL_IMAP / OTHER_IMAP, §8.1).
 *
 * OAuth (XOAUTH2) preferred, with an app-password fallback. For Gmail the OAuth flow
 * targets Google (`accounts.google.com`) — the account's OWN provider — so Gmail is
 * NEVER laundered through Microsoft (docs/15 §8.3). Refresh tokens and app passwords
 * alike are sealed via DPAPI (token-store); only opaque refs touch disk. The imap tap
 * calls `getImapCredentials` to obtain either an XOAUTH2 access token or an app
 * password at connect time.
 */

import { randomBytes } from "node:crypto";
import { OAUTH } from "../config.js";
import type { AuthProbeResult, ClassifiedAccount } from "../model.js";
import { AccountFlavor } from "../model.js";
import { generatePkce, captureAuthCode } from "./pkce.js";
import { loadRefreshToken, storeRefreshToken, hasStoredToken } from "./token-store.js";
import { log } from "../log.js";

const GOOGLE_AUTH = "https://accounts.google.com/o/oauth2/v2/auth";
const GOOGLE_TOKEN = "https://oauth2.googleapis.com/token";

interface GoogleTokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

const accessCache = new Map<string, { accessToken: string; expiresAt: number }>();

/** Interactive Google OAuth (auth-code + PKCE loopback). Called during setup / reconnect. */
export async function runGoogleOAuthLoopback(account: ClassifiedAccount): Promise<AuthProbeResult> {
  if (!OAUTH.googleClientId) return { ok: false, error: "google_client_not_configured" };
  try {
    const pkce = generatePkce();
    const state = randomBytes(16).toString("hex");
    const { code, redirectUri } = await captureAuthCode((redirect) => {
      const p = new URLSearchParams({
        client_id: OAUTH.googleClientId,
        response_type: "code",
        redirect_uri: redirect,
        scope: OAUTH.googleScopes.join(" "),
        access_type: "offline",
        prompt: "consent",
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        login_hint: account.address ?? "",
      });
      return `${GOOGLE_AUTH}?${p.toString()}`;
    }, state);

    const res = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: OAUTH.googleClientId,
        client_secret: OAUTH.googleClientSecret, // native-app secret; not confidential
        grant_type: "authorization_code",
        code,
        redirect_uri: redirectUri,
        code_verifier: pkce.verifier,
      }),
    });
    const json = (await res.json()) as GoogleTokenResponse;
    if (!res.ok || json.error) return { ok: false, error: json.error ?? "google_auth_failed" };
    if (json.refresh_token) {
      await storeRefreshToken(account.id, json.refresh_token, "google", OAUTH.googleScopes);
    }
    accessCache.set(account.id, {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    });
    return { ok: true, accountRef: account.id };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

async function getGoogleAccessToken(
  account: ClassifiedAccount,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const cached = accessCache.get(account.id);
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return { ok: true, accessToken: cached.accessToken };
  }
  const refreshToken = await loadRefreshToken(account.id);
  if (!refreshToken) return { ok: false, error: "interactive_required" };
  try {
    const res = await fetch(GOOGLE_TOKEN, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: OAUTH.googleClientId,
        client_secret: OAUTH.googleClientSecret,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
      }),
    });
    const json = (await res.json()) as GoogleTokenResponse;
    if (!res.ok || json.error) {
      return { ok: false, error: json.error === "invalid_grant" ? "invalid_grant" : (json.error ?? "refresh_failed") };
    }
    accessCache.set(account.id, {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    });
    return { ok: true, accessToken: json.access_token };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Selector probe (docs/15 §3.4): confirm we can authenticate to IMAP. OAuth first for
 * Gmail; otherwise/afterwards an app password (sealed under the account) is accepted.
 * A missing token during a re-evaluation pass returns `interactive_required` — setup
 * drives the browser/app-password entry, not the selector.
 */
export async function tryImapAuth(
  account: ClassifiedAccount,
  opts: { preferOAuth: boolean; fallback: "app_password" | null },
): Promise<AuthProbeResult> {
  const isGmail = account.flavor === AccountFlavor.GMAIL_IMAP;
  if (opts.preferOAuth && (isGmail || account.authKind === "oauth")) {
    if (!hasStoredToken(account.id)) return { ok: false, error: "interactive_required" };
    const tok = await getGoogleAccessToken(account);
    if (tok.ok) return { ok: true, accountRef: account.id };
    if (opts.fallback !== "app_password") return { ok: false, error: tok.error };
  }
  // App-password fallback: sealed under the account (issuer = imap host).
  if (opts.fallback === "app_password" || account.authKind === "app_password") {
    if (hasStoredToken(account.id)) return { ok: true, accountRef: account.id };
    return { ok: false, error: "interactive_required" };
  }
  return { ok: false, error: "no_imap_auth_configured" };
}

/** Persist an app password (sealed) for an account (called by the setup wizard). */
export async function storeAppPassword(
  account: ClassifiedAccount,
  appPassword: string,
): Promise<void> {
  const host = account.imapHost ?? account.serverHost ?? "imap";
  await storeRefreshToken(account.id, appPassword, host, ["imap"]);
  log.info("stored sealed app password", { account: account.address }); // no secret
}

/** IMAP credentials for imapflow at connect time: XOAUTH2 access token or app password. */
export async function getImapCredentials(
  account: ClassifiedAccount,
): Promise<
  | { kind: "oauth"; user: string; accessToken: string }
  | { kind: "password"; user: string; pass: string }
  | { kind: "none"; error: string }
> {
  const user = account.address ?? account.upn ?? "";
  const isGmail = account.flavor === AccountFlavor.GMAIL_IMAP;
  if (isGmail || account.authKind === "oauth") {
    const tok = await getGoogleAccessToken(account);
    if (tok.ok) return { kind: "oauth", user, accessToken: tok.accessToken };
    // fall through to app password if one exists
  }
  const pass = await loadRefreshToken(account.id);
  if (pass) return { kind: "password", user, pass };
  return { kind: "none", error: "no IMAP credentials available" };
}
