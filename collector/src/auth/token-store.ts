/**
 * Account -> sealed-refresh-token index (docs/15 §8.1).
 *
 * Maps a collector account id to the OPAQUE DPAPI reference for its sealed refresh
 * token, plus non-secret metadata (scopes, issuer). The refresh token itself lives
 * ONLY as a DPAPI blob (see platform/dpapi.ts); this index never holds a secret, so a
 * copied `token-index.json` is useless without the user's DPAPI key. Short-lived
 * access tokens are cached in memory only (never persisted).
 */

import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { z } from "zod";
import { dataDir } from "../config.js";
import { sealToken, unsealToken, deleteToken } from "../platform/dpapi.js";

const EntrySchema = z.object({
  tokenRef: z.string(), // opaque DPAPI ref, NOT a secret
  issuer: z.string(), // 'graph' | 'google' | provider host
  scopes: z.array(z.string()),
});
const FileSchema = z.record(z.string(), EntrySchema);
export type TokenEntry = z.infer<typeof EntrySchema>;

function indexPath(): string {
  return join(dataDir(), "token-index.json");
}

function readIndex(): Record<string, TokenEntry> {
  const path = indexPath();
  if (!existsSync(path)) return {};
  try {
    return FileSchema.parse(JSON.parse(readFileSync(path, "utf8")));
  } catch {
    return {};
  }
}

function writeIndex(index: Record<string, TokenEntry>): void {
  writeFileSync(indexPath(), JSON.stringify(index, null, 2), "utf8");
}

/** Seal a refresh token for an account and record its opaque reference. */
export async function storeRefreshToken(
  accountId: string,
  refreshToken: string,
  issuer: string,
  scopes: readonly string[],
): Promise<void> {
  const index = readIndex();
  // Replace any prior sealed blob for this account.
  const prior = index[accountId];
  if (prior) deleteToken(prior.tokenRef);
  const tokenRef = await sealToken(refreshToken);
  index[accountId] = { tokenRef, issuer, scopes: [...scopes] };
  writeIndex(index);
}

/** Resolve an account's refresh token (unseals at call time), or null if none stored. */
export async function loadRefreshToken(accountId: string): Promise<string | null> {
  const entry = readIndex()[accountId];
  if (!entry) return null;
  return unsealToken(entry.tokenRef);
}

export function hasStoredToken(accountId: string): boolean {
  return Boolean(readIndex()[accountId]);
}

export function forgetToken(accountId: string): void {
  const index = readIndex();
  const entry = index[accountId];
  if (!entry) return;
  deleteToken(entry.tokenRef);
  delete index[accountId];
  writeIndex(index);
}
