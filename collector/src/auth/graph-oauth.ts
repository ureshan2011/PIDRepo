/**
 * Microsoft Graph OAuth (docs/15 §3.4, §7.2, §8.1).
 *
 * Auth-code + PKCE loopback (primary) and device-code (fallback for headless setup)
 * against `login.microsoftonline.com`. On success the refresh token is sealed via
 * DPAPI (token-store) and only an opaque ref is kept. `tryGraphAuth` is the probe the
 * tap-selector calls: unattended, it refreshes the stored token and maps provider
 * errors to the exact codes the selector branches on — `AADSTS90094` (admin-consent
 * wall) and `invalid_grant` (revoked). It never pops a browser on a re-evaluation pass.
 */

import { randomBytes } from "node:crypto";
import { OAUTH } from "../config.js";
import type { AuthProbeResult, ClassifiedAccount } from "../model.js";
import { generatePkce, captureAuthCode } from "./pkce.js";
import { loadRefreshToken, storeRefreshToken, hasStoredToken } from "./token-store.js";
import { log } from "../log.js";

interface TokenResponse {
  access_token: string;
  refresh_token?: string;
  expires_in: number;
  error?: string;
  error_description?: string;
}

interface AccessToken {
  accessToken: string;
  expiresAt: number;
}

/** In-memory access-token cache (short-lived; never persisted). */
const accessCache = new Map<string, AccessToken>();

function authorityFor(account: ClassifiedAccount): string {
  // Consumer MSA uses /consumers; org/hybrid use the tenant (or /organizations).
  const tenant = account.tenantId ?? "organizations";
  return `${OAUTH.graphAuthority}/${tenant}`;
}

function tokenEndpoint(account: ClassifiedAccount): string {
  return `${authorityFor(account)}/oauth2/v2.0/token`;
}

function authEndpoint(account: ClassifiedAccount): string {
  return `${authorityFor(account)}/oauth2/v2.0/authorize`;
}

/** Interactive one-time consent (auth-code + PKCE loopback). Called during setup / reconnect. */
export async function runAuthCodePkceLoopback(account: ClassifiedAccount): Promise<AuthProbeResult> {
  try {
    const pkce = generatePkce();
    const state = randomBytes(16).toString("hex");
    const { code, redirectUri } = await captureAuthCode((redirect) => {
      const p = new URLSearchParams({
        client_id: OAUTH.graphClientId,
        response_type: "code",
        redirect_uri: redirect,
        response_mode: "query",
        scope: OAUTH.graphScopes.join(" "),
        state,
        code_challenge: pkce.challenge,
        code_challenge_method: "S256",
        login_hint: account.upn ?? account.address ?? "",
      });
      return `${authEndpoint(account)}?${p.toString()}`;
    }, state);

    const body = new URLSearchParams({
      client_id: OAUTH.graphClientId,
      grant_type: "authorization_code",
      code,
      redirect_uri: redirectUri,
      code_verifier: pkce.verifier,
      scope: OAUTH.graphScopes.join(" "),
    });
    const res = await fetch(tokenEndpoint(account), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body,
    });
    const json = (await res.json()) as TokenResponse;
    if (!res.ok || json.error) return { ok: false, error: classifyError(json) };
    if (json.refresh_token) {
      await storeRefreshToken(account.id, json.refresh_token, "graph", OAUTH.graphScopes);
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

/** Device-code fallback (docs/15 §3.4) — for a headless/remote setup session. */
export async function runDeviceCode(account: ClassifiedAccount): Promise<AuthProbeResult> {
  try {
    const dcRes = await fetch(`${authorityFor(account)}/oauth2/v2.0/devicecode`, {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: OAUTH.graphClientId,
        scope: OAUTH.graphScopes.join(" "),
      }),
    });
    const dc = (await dcRes.json()) as {
      device_code: string;
      user_code: string;
      verification_uri: string;
      interval: number;
      expires_in: number;
    };
    // The user_code / verification_uri are safe to surface (not secrets).
    log.info("device-code sign-in required", {
      verification_uri: dc.verification_uri,
      user_code: dc.user_code,
    });
    const deadline = Date.now() + dc.expires_in * 1000;
    while (Date.now() < deadline) {
      await sleep(Math.max(dc.interval, 5) * 1000);
      const pollRes = await fetch(tokenEndpoint(account), {
        method: "POST",
        headers: { "content-type": "application/x-www-form-urlencoded" },
        body: new URLSearchParams({
          client_id: OAUTH.graphClientId,
          grant_type: "urn:ietf:params:oauth:grant-type:device_code",
          device_code: dc.device_code,
        }),
      });
      const json = (await pollRes.json()) as TokenResponse;
      if (json.error === "authorization_pending") continue;
      if (json.error) return { ok: false, error: classifyError(json) };
      if (json.refresh_token) {
        await storeRefreshToken(account.id, json.refresh_token, "graph", OAUTH.graphScopes);
      }
      accessCache.set(account.id, {
        accessToken: json.access_token,
        expiresAt: Date.now() + json.expires_in * 1000,
      });
      return { ok: true, accountRef: account.id };
    }
    return { ok: false, error: "device_code_expired" };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/**
 * Unattended probe used by the tap-selector: refresh the stored token and confirm the
 * account still authenticates. If no token is stored yet (never set up), returns
 * `interactive_required` — the setup wizard, not the selector, drives the browser flow.
 */
export async function tryGraphAuth(account: ClassifiedAccount): Promise<AuthProbeResult> {
  if (!hasStoredToken(account.id)) {
    return { ok: false, error: "interactive_required" };
  }
  const token = await getAccessToken(account);
  if (token.ok) return { ok: true, accountRef: account.id };
  return { ok: false, error: token.error };
}

/**
 * Return a valid access token for Graph calls, refreshing via the sealed refresh token
 * when the cached one is stale. Maps `AADSTS90094` / `invalid_grant` for the caller.
 */
export async function getAccessToken(
  account: ClassifiedAccount,
): Promise<{ ok: true; accessToken: string } | { ok: false; error: string }> {
  const cached = accessCache.get(account.id);
  if (cached && cached.expiresAt - 60_000 > Date.now()) {
    return { ok: true, accessToken: cached.accessToken };
  }
  const refreshToken = await loadRefreshToken(account.id);
  if (!refreshToken) return { ok: false, error: "interactive_required" };
  try {
    const res = await fetch(tokenEndpoint(account), {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: new URLSearchParams({
        client_id: OAUTH.graphClientId,
        grant_type: "refresh_token",
        refresh_token: refreshToken,
        scope: OAUTH.graphScopes.join(" "),
      }),
    });
    const json = (await res.json()) as TokenResponse;
    if (!res.ok || json.error) return { ok: false, error: classifyError(json) };
    if (json.refresh_token) {
      await storeRefreshToken(account.id, json.refresh_token, "graph", OAUTH.graphScopes);
    }
    accessCache.set(account.id, {
      accessToken: json.access_token,
      expiresAt: Date.now() + json.expires_in * 1000,
    });
    return { ok: true, accessToken: json.access_token };
  } catch (err) {
    // Network/5xx => transient; surface as-is so health maps it to 'stale', not revoked.
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

/** Map a token error body to the codes the selector/health machine branch on. */
function classifyError(json: TokenResponse): string {
  const desc = json.error_description ?? "";
  if (desc.includes("AADSTS90094")) return "AADSTS90094"; // tenant admin-consent wall
  if (json.error === "invalid_grant") return "invalid_grant"; // revoked / expired refresh token
  return json.error ?? "graph_auth_failed";
}

function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}
