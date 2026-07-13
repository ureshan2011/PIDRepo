import { randomBytes, scryptSync, timingSafeEqual } from "node:crypto";

/**
 * Single-user passphrase auth (node runtime). Stores only a scrypt hash; verifies
 * the login passphrase; re-exports the edge-safe session/origin helpers so callers
 * have one auth entrypoint. BUILD_SPEC §7.
 *
 * Dev default: if PID_PASSPHRASE_HASH is unset, the passphrase is "pid-dev".
 */

export const DEV_PASSPHRASE = "pid-dev";

const SCRYPT_KEYLEN = 64;

/** Produce a portable hash string: `scrypt$<saltHex>$<hashHex>`. */
export function hashPassphrase(passphrase: string): string {
  const salt = randomBytes(16);
  const hash = scryptSync(passphrase, salt, SCRYPT_KEYLEN);
  return `scrypt$${salt.toString("hex")}$${hash.toString("hex")}`;
}

function verifyAgainstHash(passphrase: string, stored: string): boolean {
  const parts = stored.split("$");
  if (parts.length !== 3 || parts[0] !== "scrypt") return false;
  const salt = Buffer.from(parts[1], "hex");
  const expected = Buffer.from(parts[2], "hex");
  const actual = scryptSync(passphrase, salt, expected.length);
  return expected.length === actual.length && timingSafeEqual(expected, actual);
}

/**
 * Verify a login passphrase. Uses PID_PASSPHRASE_HASH if set; otherwise falls
 * back to the dev passphrase "pid-dev".
 */
export function verifyPassphrase(passphrase: string): boolean {
  const stored = process.env.PID_PASSPHRASE_HASH;
  if (stored) return verifyAgainstHash(passphrase, stored);
  return passphrase === DEV_PASSPHRASE;
}

export {
  SESSION_COOKIE,
  SESSION_MAX_AGE_S,
  createSessionToken,
  verifySessionToken,
  checkOrigin,
} from "@/lib/session";
