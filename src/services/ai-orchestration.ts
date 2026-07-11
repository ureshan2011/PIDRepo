import type OpenAI from "openai";
import {
  cachedModels,
  createClient,
  isAvailableCached,
  markUnavailable,
  refreshAvailability,
} from "@/lib/lm-studio";
import { getAiSettings } from "@/lib/settings";

/**
 * AI Orchestration Service — the SOLE LM Studio caller. Every chat/embedding/model
 * call in the app funnels through here so availability, timeouts and structured
 * output handling live in one place. Degrades LOUDLY: unreachable LM Studio throws
 * a typed {@link LMStudioUnavailableError} that callers can catch, and never hangs
 * (per-call timeout is enforced by the SDK client). BUILD_SPEC §6.
 */

export class LMStudioUnavailableError extends Error {
  readonly code = "LMStudioUnavailable" as const;
  constructor(message = "LM Studio is not reachable", options?: { cause?: unknown }) {
    super(message, options);
    this.name = "LMStudioUnavailableError";
  }
}

export type ChatMessage = OpenAI.Chat.Completions.ChatCompletionMessageParam;
export type ResponseFormat = OpenAI.Chat.Completions.ChatCompletionCreateParams["response_format"];

export interface ChatArgs {
  model?: string;
  messages: ChatMessage[];
  responseFormat?: ResponseFormat;
  temperature?: number;
}

function wrapError(err: unknown): never {
  markUnavailable();
  throw new LMStudioUnavailableError(
    err instanceof Error ? `LM Studio call failed: ${err.message}` : "LM Studio call failed",
    { cause: err },
  );
}

/**
 * Chat completion. Defaults to `ai.chatModel`. Throws LMStudioUnavailableError on
 * any transport/timeout failure so callers can fall back or requeue.
 */
export async function chat(args: ChatArgs): Promise<OpenAI.Chat.Completions.ChatCompletion> {
  const { client } = createClient();
  const s = getAiSettings();
  try {
    const res = await client.chat.completions.create({
      model: args.model ?? s["ai.chatModel"],
      messages: args.messages,
      response_format: args.responseFormat,
      temperature: args.temperature,
    });
    return res;
  } catch (err) {
    return wrapError(err);
  }
}

/**
 * Batched embeddings. Defaults to `ai.embeddingModel`. Returns one vector per
 * input, in order. Throws LMStudioUnavailableError on failure.
 */
export async function embed(inputs: string[]): Promise<number[][]> {
  if (inputs.length === 0) return [];
  const { client } = createClient();
  const s = getAiSettings();
  try {
    const res = await client.embeddings.create({
      model: s["ai.embeddingModel"],
      input: inputs,
    });
    return res.data
      .sort((a, b) => a.index - b.index)
      .map((d) => d.embedding as unknown as number[]);
  } catch (err) {
    return wrapError(err);
  }
}

/** List models available on the LM Studio server (also refreshes availability). */
export async function listModels(): Promise<string[]> {
  try {
    const st = await refreshAvailability(true);
    if (!st.available) throw new LMStudioUnavailableError();
    return st.models;
  } catch (err) {
    if (err instanceof LMStudioUnavailableError) throw err;
    return wrapError(err);
  }
}

/** Synchronous cached availability flag (no network round trip on the hot path). */
export function isAvailable(): boolean {
  return isAvailableCached();
}

export { cachedModels, refreshAvailability };
