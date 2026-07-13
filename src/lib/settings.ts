import { eq } from "drizzle-orm";
import { db } from "@/db/client";
import { settings } from "@/db/schema";

/**
 * Typed getters/setters over the `settings` KV table. All AI runtime config
 * lives here (dotted `ai.*` keys per BUILD_SPEC §6) so nothing is hardcoded.
 */

export interface AiSettings {
  "ai.baseUrl": string;
  "ai.chatModel": string;
  "ai.classifierModel": string;
  "ai.embeddingModel": string;
  "ai.apiKey": string;
  "ai.requestTimeoutMs": number;
  "ai.contextWindowOverride": number;
}

export const AI_SETTINGS_DEFAULTS: AiSettings = {
  "ai.baseUrl": "http://localhost:1234/v1",
  "ai.chatModel": "qwen2.5-14b-instruct",
  "ai.classifierModel": "qwen2.5-3b-instruct",
  "ai.embeddingModel": "nomic-embed-text-v1.5",
  "ai.apiKey": "lm-studio",
  "ai.requestTimeoutMs": 120000,
  "ai.contextWindowOverride": 8192,
};

/** Read a single setting value (JSON-decoded), or `undefined` if unset. */
export function getSetting<T = unknown>(key: string): T | undefined {
  const row = db.select().from(settings).where(eq(settings.key, key)).get();
  return row?.value as T | undefined;
}

/** Read a setting, falling back to a provided default. */
export function getSettingOr<T>(key: string, fallback: T): T {
  const v = getSetting<T>(key);
  return v === undefined || v === null ? fallback : v;
}

/** Upsert a single setting (value is JSON-encoded by Drizzle). */
export function setSetting(key: string, value: unknown): void {
  db.insert(settings)
    .values({ key, value, updatedAt: new Date() })
    .onConflictDoUpdate({
      target: settings.key,
      set: { value, updatedAt: new Date() },
    })
    .run();
}

/** Read all AI settings merged over defaults. */
export function getAiSettings(): AiSettings {
  const out = { ...AI_SETTINGS_DEFAULTS };
  for (const key of Object.keys(AI_SETTINGS_DEFAULTS) as (keyof AiSettings)[]) {
    const v = getSetting(key);
    if (v !== undefined && v !== null) {
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      (out as any)[key] = v;
    }
  }
  return out;
}

/** Patch one or more AI settings. */
export function setAiSettings(patch: Partial<AiSettings>): void {
  for (const [key, value] of Object.entries(patch)) {
    if (value !== undefined) setSetting(key, value);
  }
}
