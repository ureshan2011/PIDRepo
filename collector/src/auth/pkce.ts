/**
 * PKCE + loopback-redirect OAuth helper (docs/15 §3.4 "auth-code+PKCE loopback").
 *
 * Shared by the Graph and Google OAuth flows. Runs a one-shot localhost HTTP server
 * on 127.0.0.1, opens the system browser to the authorization URL, and captures the
 * `code` from the loopback redirect — the standard native-app flow with no client
 * secret required (public client). Never logs the code or any token.
 */

import { createHash, randomBytes } from "node:crypto";
import { createServer } from "node:http";
import { exec } from "node:child_process";
import { OAUTH } from "../config.js";
import { log } from "../log.js";

export interface PkcePair {
  verifier: string;
  challenge: string;
}

export function generatePkce(): PkcePair {
  const verifier = base64url(randomBytes(32));
  const challenge = base64url(createHash("sha256").update(verifier).digest());
  return { verifier, challenge };
}

function base64url(buf: Buffer): string {
  return buf.toString("base64").replace(/\+/g, "-").replace(/\//g, "_").replace(/=+$/, "");
}

/** Open the user's default browser at `url` (Windows `start`, cross-platform fallbacks). */
export function openBrowser(url: string): void {
  const platform = process.platform;
  const cmd =
    platform === "win32"
      ? `start "" "${url}"`
      : platform === "darwin"
        ? `open "${url}"`
        : `xdg-open "${url}"`;
  exec(cmd, (err) => {
    if (err) log.warn("could not auto-open browser; user must open the URL manually", { url });
  });
}

/**
 * Start a loopback server, open the browser to `authUrlBuilder(redirectUri)`, and
 * resolve the authorization code once the provider redirects back. Times out in 5 min.
 */
export function captureAuthCode(
  authUrlBuilder: (redirectUri: string) => string,
  expectedState: string,
): Promise<{ code: string; redirectUri: string }> {
  return new Promise((resolve, reject) => {
    const server = createServer((req, res) => {
      try {
        const url = new URL(req.url ?? "/", `http://${OAUTH.loopbackHost}`);
        if (!url.pathname.startsWith("/callback")) {
          res.writeHead(404).end();
          return;
        }
        const code = url.searchParams.get("code");
        const state = url.searchParams.get("state");
        const err = url.searchParams.get("error");
        res.writeHead(200, { "content-type": "text/html" });
        res.end("<html><body>PID: sign-in complete. You can close this window.</body></html>");
        server.close();
        if (err) return reject(new Error(err));
        if (!code) return reject(new Error("no authorization code returned"));
        if (state !== expectedState) return reject(new Error("state mismatch (possible CSRF)"));
        resolve({ code, redirectUri });
      } catch (e) {
        server.close();
        reject(e instanceof Error ? e : new Error(String(e)));
      }
    });

    server.listen(0, OAUTH.loopbackHost, () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr ? addr.port : 0;
      redirectUri = `http://${OAUTH.loopbackHost}:${port}/callback`;
      openBrowser(authUrlBuilder(redirectUri));
    });

    let redirectUri = "";
    const timeout = setTimeout(
      () => {
        server.close();
        reject(new Error("authorization timed out (5 min)"));
      },
      5 * 60_000,
    );
    timeout.unref?.();
  });
}
