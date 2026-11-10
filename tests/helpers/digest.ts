import type { DigestEnvelope, FailureCluster } from "../../src/types/schema.js";

export function clustersOf(envelope: DigestEnvelope): FailureCluster[] {
  return envelope.clusters ?? [];
}
