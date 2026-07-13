/**
 * Token sealing via DPAPI / Windows Credential Manager (docs/15 §8.1).
 *
 * Refresh tokens (Graph, IMAP/Google OAuth) are ALWAYS sealed with the CurrentUser
 * DPAPI scope before touching disk — never written in plaintext to the staging DB,
 * `accounts.json`, or any log (docs/15 §8.1, §9). The collector holds only an opaque
 * account reference; the OS resolves it back to the secret at call time, scoped to the
 * logged-on user. A copied SQLite/JSON file is therefore useless to an attacker.
 *
 * Two backends, tried in order:
 *   1. native `win-dpapi` (lazy-imported optionalDependency), if present;
 *   2. a PowerShell shim over `System.Security.Cryptography.ProtectedData` — no native
 *      dependency, same CurrentUser DPAPI key. This is the default portable path.
 * Sealed blobs are stored as base64 files under `<dataDir>/secrets/<ref>.dpapi`; the
 * `ref` (a random id) is the only thing that ever appears in config/logs.
 */

import { existsSync, mkdirSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { join } from "node:path";
import { ulid } from "ulid";
import { dataDir, IS_WINDOWS } from "../config.js";
import { assertWindows, powershell } from "./native.js";
import { log } from "../log.js";

function secretsDir(): string {
  const dir = join(dataDir(), "secrets");
  mkdirSync(dir, { recursive: true });
  return dir;
}

function blobPath(ref: string): string {
  return join(secretsDir(), `${ref}.dpapi`);
}

async function nativeDpapi(): Promise<typeof import("win-dpapi") | null> {
  if (!IS_WINDOWS) return null;
  try {
    return await import("win-dpapi");
  } catch {
    return null; // optionalDependency skipped — fall back to the PowerShell shim
  }
}

/** Seal via the PowerShell ProtectedData shim (base64 in, base64 out). */
async function shimProtect(plaintextB64: string): Promise<string> {
  assertWindows("DPAPI seal");
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security | Out-Null
$data=[Convert]::FromBase64String('${plaintextB64}')
$prot=[System.Security.Cryptography.ProtectedData]::Protect($data,$null,'CurrentUser')
[Convert]::ToBase64String($prot)`;
  return (await powershell(script)).trim();
}

async function shimUnprotect(sealedB64: string): Promise<string> {
  assertWindows("DPAPI unseal");
  const script = String.raw`
$ErrorActionPreference='Stop'
Add-Type -AssemblyName System.Security | Out-Null
$data=[Convert]::FromBase64String('${sealedB64}')
$plain=[System.Security.Cryptography.ProtectedData]::Unprotect($data,$null,'CurrentUser')
[Convert]::ToBase64String($plain)`;
  return (await powershell(script)).trim();
}

/**
 * Seal a secret string and return an opaque reference to store in `accounts.json`.
 * The plaintext is never returned to any persistent surface.
 */
export async function sealToken(secret: string): Promise<string> {
  assertWindows("token sealing");
  const ref = ulid();
  const plaintextB64 = Buffer.from(secret, "utf8").toString("base64");
  let sealedB64: string;
  const native = await nativeDpapi();
  if (native) {
    const sealed = native.protectData(Buffer.from(secret, "utf8"), null, "CurrentUser");
    sealedB64 = sealed.toString("base64");
  } else {
    sealedB64 = await shimProtect(plaintextB64);
  }
  writeFileSync(blobPath(ref), sealedB64, "utf8");
  log.info("sealed token", { ref }); // ref only — never the secret
  return ref;
}

/** Resolve an opaque reference back to the plaintext secret at call time. */
export async function unsealToken(ref: string): Promise<string> {
  assertWindows("token unsealing");
  const path = blobPath(ref);
  if (!existsSync(path)) throw new Error(`sealed token not found: ${ref}`);
  const sealedB64 = readFileSync(path, "utf8");
  const native = await nativeDpapi();
  if (native) {
    const plain = native.unprotectData(Buffer.from(sealedB64, "base64"), null, "CurrentUser");
    return plain.toString("utf8");
  }
  const plainB64 = await shimUnprotect(sealedB64);
  return Buffer.from(plainB64, "base64").toString("utf8");
}

/** Delete a sealed blob (e.g. on account removal / revoked token). */
export function deleteToken(ref: string): void {
  try {
    rmSync(blobPath(ref));
  } catch {
    /* already gone */
  }
}
