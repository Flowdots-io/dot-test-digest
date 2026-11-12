import { createHash } from "node:crypto";
import type { ErrorKind, FailureCluster } from "../types/schema.js";
import { uniqueFailures } from "./failure-identity.js";
import { pruneStack, readSignalWindow, topRepoFrame } from "./stack-pruner.js";

export interface RawFailure {
  testName: string | null;
  /** The test file, when the stream revealed it; feeds the canonical identity. */
  testFile?: string | null;
  errorKind: ErrorKind;
  message: string;
  frames: string[];
  diff?: { expected: string; received: string };
  startLine: number;
  endLine: number;
  /** The shell command that reruns this test alone, when the command named a known runner. */
  rerun?: string;
}

export interface DedupeOptions {
  repoRoot: string;
  /** Source windows are read only from files under this directory (a log the tool did not produce). */
  windowRoot?: string;
  contextLines: number;
  keep: number;
  logPath: string;
}

export interface DedupeResult {
  kept: FailureCluster[];
  omitted: FailureCluster[];
}

/**
 * Turns a message into its failure *template*: numbers, quoted values and
 * filesystem paths are the parts that differ between cascading failures.
 */
export function normalizeAssertionTemplate(message: string): string {
  return message
    .replace(/`[^`]*`/g, "*")
    .replace(/'[^']*'/g, "*")
    .replace(/"[^"]*"/g, "*")
    .replace(/0x[0-9a-f]+/gi, "#")
    .replace(/\b\d+(?:\.\d+)?\b/g, "#")
    .replace(/[A-Za-z]:\\[^\s]+/g, "<path>")
    .replace(/\/[^\s:]+/g, "<path>")
    .replace(/\s+/g, " ")
    .trim();
}

/** SHA256(error_kind + top_repo_frame_location + normalized_assertion_template). */
export function computeFingerprint(
  kind: ErrorKind,
  topFrame: string,
  message: string,
): string {
  const payload = `${kind}|${topFrame}|${normalizeAssertionTemplate(message)}`;
  return createHash("sha256").update(payload, "utf8").digest("hex");
}

interface RankedCluster {
  cluster: FailureCluster;
  top: ReturnType<typeof topRepoFrame>;
  startLine: number;
  endLine: number;
}

export function dedupeFailures(
  failures: readonly RawFailure[],
  options: DedupeOptions,
): DedupeResult {
  const groups = new Map<string, RawFailure[]>();

  // SPEC-002 §4.2.2: one failure record per canonical test identity, even if
  // the stream mentioned the test in more than one reporter section.
  for (const failure of uniqueFailures(failures)) {
    const top = topRepoFrame(failure.frames, options.repoRoot);
    const topLocation = top?.location ?? "unknown:0:0";
    const fingerprint = computeFingerprint(failure.errorKind, topLocation, failure.message);
    const bucket = groups.get(fingerprint);
    if (bucket) bucket.push(failure);
    else groups.set(fingerprint, [failure]);
  }

  const entries: RankedCluster[] = [];

  for (const [fingerprint, bucket] of groups) {
    const first = bucket[0];
    if (first === undefined) continue;
    const top = topRepoFrame(first.frames, options.repoRoot);
    const sampleTests = [
      ...new Set(bucket.map((item) => item.testName).filter((name): name is string => name !== null)),
    ].slice(0, 3);
    const startLine = Math.min(...bucket.map((item) => item.startLine));
    const endLine = Math.max(...bucket.map((item) => item.endLine));
    // The test the cluster's first sample names, else the first failure (a lint diagnostic has no test).
    const { rerun } = bucket.find((item) => item.testName !== null) ?? first;

    const cluster: FailureCluster = {
      cluster_id: `c_${fingerprint.slice(0, 8)}`,
      fingerprint,
      error_kind: first.errorKind,
      affected_count: bucket.length,
      sample_tests: sampleTests,
      ...(first.diff ? { diff: first.diff } : {}),
      message: first.message,
      top_frame: top?.location ?? "unknown:0:0",
      pruned_stack: pruneStack(first.frames, options.repoRoot),
      signal_window: "",
      raw_log_lines: `L${startLine}-L${endLine}`,
      ...(rerun !== undefined ? { rerun } : {}),
    };
    entries.push({ cluster, top, startLine, endLine });
  }

  const ranked = entries.sort(compareClusters);
  const kept = ranked.slice(0, options.keep).map(({ cluster, top }) =>
    top
      ? {
          ...cluster,
          signal_window: readSignalWindow(top.file, top.line, options.contextLines, options.repoRoot, options.windowRoot),
        }
      : cluster,
  );
  return { kept, omitted: ranked.slice(options.keep).map(({ cluster }) => cluster) };
}

function compareClusters(a: RankedCluster, b: RankedCluster): number {
  return (
    b.cluster.affected_count - a.cluster.affected_count ||
    a.startLine - b.startLine ||
    a.endLine - b.endLine ||
    (a.cluster.cluster_id < b.cluster.cluster_id ? -1 : a.cluster.cluster_id > b.cluster.cluster_id ? 1 : 0)
  );
}
