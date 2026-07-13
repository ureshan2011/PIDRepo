import type { Connector } from "./types";
import { sampleConnector } from "./sample";
import { outlookCollectorConnector } from "./outlook/shim";

/**
 * Connector registry — maps `connector_id` (== `sources.connector_id`) to its
 * singleton Connector instance. The worker's connector-sync handler looks up the
 * connector for a source here. Adding a real connector is a one-line entry.
 * BUILD_SPEC §4 / §5.
 */

const registry: Record<string, Connector> = {
  [sampleConnector.id]: sampleConnector,
  [outlookCollectorConnector.id]: outlookCollectorConnector,
};

/** Look up a connector by id; `undefined` if none registered. */
export function getConnector(connectorId: string): Connector | undefined {
  return registry[connectorId];
}

/** All registered connectors. */
export function allConnectors(): Connector[] {
  return Object.values(registry);
}
