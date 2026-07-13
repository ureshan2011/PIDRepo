import OpenAI from "openai";
import { getAiSettings } from "@/lib/settings";

/**
 * OpenAI SDK factory targeting the local LM Studio server, built from `settings`
 * rows (never hardcoded), plus a lightweight availability cache. All actual LM
 * Studio traffic goes through `src/services/ai-orchestration.ts`, which is the
 * sole caller — this module only builds the client and tracks reachability.
 * BUILD_SPEC §6.
 */

const AVAILABILITY_REPOLL_MS = 30_000;

export function createClient(): { client: OpenAI; baseUrl: string; timeoutMs: number } {
  const s = getAiSettings();
  const client = new OpenAI({
    baseURL: s["ai.baseUrl"],
    apiKey: s["ai.apiKey"] || "lm-studio", // LM Studio ignores the value; SDK requires non-empty.
    timeout: s["ai.requestTimeoutMs"],
    maxRetries: 0, // we handle retry/backoff ourselves so callers fail fast.
  });
  return { client, baseUrl: s["ai.baseUrl"], timeoutMs: s["ai.requestTimeoutMs"] };
}

interface AvailabilityState {
  available: boolean;
  lastCheckedAt: number;
  models: string[];
}

const state: AvailabilityState = {
  available: false,
  lastCheckedAt: 0,
  models: [],
};

/** Synchronous read of the last-known availability flag (no network). */
export function isAvailableCached(): boolean {
  return state.available;
}

export function cachedModels(): string[] {
  return state.models;
}

/**
 * Poll `GET /v1/models`, updating the cached availability flag. Skips the network
 * call if a recent check (< 30s) already ran, unless `force` is set.
 */
export async function refreshAvailability(force = false): Promise<AvailabilityState> {
  const now = Date.now();
  if (!force && now - state.lastCheckedAt < AVAILABILITY_REPOLL_MS) {
    return state;
  }
  state.lastCheckedAt = now;
  try {
    const { client } = createClient();
    const res = await client.models.list();
    state.models = res.data.map((m) => m.id);
    state.available = true;
  } catch {
    state.available = false;
    state.models = [];
  }
  return state;
}

/** Mark unavailable immediately after a failed call (drives the re-poll). */
export function markUnavailable(): void {
  state.available = false;
  state.lastCheckedAt = 0; // allow the next refresh to hit the network right away.
}
