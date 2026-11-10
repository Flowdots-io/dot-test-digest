import type { DigestEnvelope, FailureCluster } from "../../src/types/schema.js";

/** The envelope's clusters, empty when the envelope carries none (the schema makes the key optional). */
export function clustersOf(envelope: DigestEnvelope): FailureCluster[] {
  return envelope.clusters ?? [];
}
