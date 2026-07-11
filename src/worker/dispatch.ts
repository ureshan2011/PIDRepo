/**
 * Job-type -> handler registry. Phase 0 ships this EMPTY: the worker idles
 * cleanly with no handlers registered. Phase 1's ingestion agent populates it by
 * importing handlers from `src/worker/handlers/*` and calling `registerHandler`
 * (or adding entries to the `handlers` map directly, right below). BUILD_SPEC §5.
 */

export interface JobRecord {
  id: number;
  type: string;
  payload: Record<string, unknown> | null;
  attempts: number;
  maxAttempts: number;
}

export type JobHandler = (
  payload: Record<string, unknown>,
  ctx: { job: JobRecord },
) => Promise<void>;

// ---------------------------------------------------------------------------
// PHASE 1 EXTENSION POINT — register job handlers here.
//
// Phase 1 registers: connector_sync, pipeline_chunk, pipeline_embed.
// Add later job types (pipeline_extract, insight_generation, ...) in their phases.
// ---------------------------------------------------------------------------
import { connectorSync } from "./handlers/connector-sync";
import { pipelineChunk } from "./handlers/pipeline-chunk";
import { pipelineEmbed } from "./handlers/pipeline-embed";

export const handlers: Record<string, JobHandler> = {
  connector_sync: connectorSync,
  pipeline_chunk: pipelineChunk,
  pipeline_embed: pipelineEmbed,
};

/** Register (or override) a handler for a job type. */
export function registerHandler(type: string, handler: JobHandler): void {
  handlers[type] = handler;
}

/** Look up a handler; `undefined` => unknown/unregistered type. */
export function getHandler(type: string): JobHandler | undefined {
  return handlers[type];
}
