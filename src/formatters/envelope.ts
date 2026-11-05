import os from "node:os";
import type {
  Delta,
  DigestEnvelope,
  DigestStatus,
  ExecutionGear,
  FailureCluster,
  OutputFormat,
  TddPhase,
} from "../types/schema.js";

export const PASS_BYTE_CEILING = 160;
export const FAIL_BYTE_CEILING = 2400;
export const MAX_FAIL_TOKENS = 600;
const BYTES_PER_TOKEN = 4;
const MESSAGE_BYTE_CEILING = 240;

export function estimateTokens(text: string): number {
  return Math.ceil(Buffer.byteLength(text, "utf8") / BYTES_PER_TOKEN);
}

export function shortenPath(target: string): string {
  const home = os.homedir();
  return target.startsWith(home) ? `~${target.slice(home.length)}` : target;
}

export function truncateBytes(text: string, maxBytes: number): string {
  const buffer = Buffer.from(text, "utf8");
  if (buffer.length <= maxBytes) return text;
  const marker = "...";
  const sliced = buffer.subarray(0, Math.max(0, maxBytes - marker.length)).toString("utf8");
  return `${sliced.replace(/\uFFFD+$/, "")}${marker}`;
}

export interface BuildEnvelopeInput {
  status: DigestStatus;
  phase: TddPhase;
  exitCode: number;
  signal: string | null;
  gear: ExecutionGear;
  durationMs: number;
  counts: { passed: number; failed: number; skipped: number };
  clusters: readonly FailureCluster[];
  delta?: Delta;
  rawLogPath: string;
}

export function buildEnvelope(input: BuildEnvelopeInput): DigestEnvelope {
  return {
    status: input.status,
    tdd_phase: input.phase,
    exit_code: input.exitCode,
    signal: input.signal,
    execution_gear: input.gear,
    duration_ms: input.durationMs,
    summary: {
      passed: input.counts.passed,
      failed: input.counts.failed,
      skipped: input.counts.skipped,
      total_clusters: input.clusters.length,
    },
    ...(input.delta ? { delta: input.delta } : {}),
    ...(input.clusters.length > 0 ? { clusters: [...input.clusters] } : {}),
    raw_log_path: input.rawLogPath,
  };
}

function statusLabel(envelope: DigestEnvelope): string {
  return envelope.tdd_phase === "none"
    ? envelope.status
    : `${envelope.status} | ${envelope.tdd_phase.toUpperCase()}`;
}

function deltaFragment(envelope: DigestEnvelope): string {
  if (!envelope.delta) return "";
  return ` (delta: +${envelope.delta.newly_passing} newly passing, ${envelope.delta.newly_broken_regressions} regressions)`;
}

export function renderPassLine(envelope: DigestEnvelope): string {
  const line =
    `[${statusLabel(envelope)}] ${envelope.summary.passed} passed, ${envelope.summary.failed} failed` +
    `${deltaFragment(envelope)} in ${envelope.duration_ms}ms | log: ${shortenPath(envelope.raw_log_path)}`;
  return truncateBytes(line, PASS_BYTE_CEILING - 1);
}

/**
 * The size rule's ladder (SPEC-002 §4.4): each level drops detail from the one
 * before. Level 5 (header + raw text) is handled apart in `renderFailBody`.
 */
interface Level {
  window: boolean;
  stack: boolean;
  oneLine: boolean;
}

const FULL: Level = { window: true, stack: true, oneLine: false };
const LADDER: readonly Level[] = [
  FULL,
  { window: false, stack: true, oneLine: false },
  { window: false, stack: false, oneLine: false },
  { window: false, stack: false, oneLine: true },
];

function clusterHead(cluster: FailureCluster): string {
  return `${cluster.cluster_id} ${cluster.error_kind} x${cluster.affected_count} ${cluster.top_frame}`;
}

function renderCluster(cluster: FailureCluster, level: Level): string {
  const rows: string[] = [clusterHead(cluster)];
  if (cluster.message !== "") rows.push(`  ${truncateBytes(cluster.message, MESSAGE_BYTE_CEILING)}`);
  if (cluster.diff) {
    rows.push(`  diff: expected ${cluster.diff.expected} / received ${cluster.diff.received}`);
  }
  if (level.stack) {
    for (const frame of cluster.pruned_stack) {
      if (frame !== cluster.top_frame) rows.push(`  ${frame}`);
    }
  }
  if (level.window && cluster.signal_window !== "") {
    for (const line of cluster.signal_window.split("\n")) rows.push(`  ${line}`);
  }
  if (cluster.sample_tests.length > 0) rows.push(`  tests: ${cluster.sample_tests.join(", ")}`);
  rows.push(`  raw: ${cluster.raw_log_lines}`);
  return rows.join("\n");
}

const LABEL_BYTE_CEILING = 80;

/** What the failure body needs besides the envelope; no `rawText` means the size rule is off. */
export interface RenderContext {
  rawText?: string;
  omitted?: readonly FailureCluster[];
}

function omittedLabel(cluster: FailureCluster): string {
  const label = cluster.sample_tests[0] ?? cluster.message;
  return truncateBytes(label.replace(/\s+/g, " ").trim(), LABEL_BYTE_CEILING);
}

function renderOmittedLine(cluster: FailureCluster): string {
  return `  ${clusterHead(cluster)} ${omittedLabel(cluster)}`;
}

function renderOneLine(cluster: FailureCluster): string {
  const head = `${clusterHead(cluster)} ${cluster.raw_log_lines}`;
  return cluster.message === "" ? head : `${head} ${truncateBytes(cluster.message, MESSAGE_BYTE_CEILING)}`;
}

function headerLine(envelope: DigestEnvelope, clusterCount: number): string {
  return (
    `[${statusLabel(envelope)}] ${envelope.summary.failed} failed, ${envelope.summary.passed} passed` +
    ` in ${envelope.duration_ms}ms | ${clusterCount} cluster${clusterCount === 1 ? "" : "s"}` +
    ` | log: ${shortenPath(envelope.raw_log_path)}`
  );
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

interface FailBodyInput {
  rawText: string | undefined;
  omitted: readonly FailureCluster[];
}

/**
 * The first ladder level whose text is no larger than the raw output plus the
 * header would be; the header plus the raw text itself when none is.
 */
function renderFailBody(envelope: DigestEnvelope, { rawText, omitted }: FailBodyInput): string {
  if (rawText === undefined) return renderLevel(envelope, omitted, FULL).text;
  for (const level of LADDER) {
    const { text, header } = renderLevel(envelope, omitted, level);
    if (byteLength(text) <= byteLength(rawText) + byteLength(header)) return text;
  }
  const raw = `${headerLine(envelope, (envelope.clusters ?? []).length)}\n${rawText}`;
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

function renderLevel(
  envelope: DigestEnvelope,
  omitted: readonly FailureCluster[],
  level: Level,
): { text: string; header: string } {
  const clusters = envelope.clusters ?? [];
  let kept = clusters.length;
  let listed = clusters.length + omitted.length;

  const render = (): { text: string; header: string } => {
    const header = headerLine(envelope, kept);
    const blocks = clusters
      .slice(0, kept)
      .map((c) => (level.oneLine ? renderOneLine(c) : renderCluster(c, level)))
      .join("\n");
    const allOmitted = [...clusters.slice(kept), ...omitted];
    const lines = allOmitted.slice(0, listed).map((c) => `\n${renderOmittedLine(c)}`);
    const footer = allOmitted.length > 0 ? `\n+${allOmitted.length} more clusters (see log)${lines.join("")}` : "";
    return { text: `${header}\n${blocks}${footer}`, header };
  };

  let rendered = render();
  while (estimateTokens(rendered.text) > MAX_FAIL_TOKENS && kept > 1) {
    kept -= 1;
    rendered = render();
  }
  while (estimateTokens(rendered.text) > MAX_FAIL_TOKENS && listed > 0) {
    listed -= 1;
    rendered = render();
  }
  return { text: truncateBytes(rendered.text, FAIL_BYTE_CEILING - 1), header: rendered.header };
}

export function formatEnvelope(
  envelope: DigestEnvelope,
  format: OutputFormat,
  context: RenderContext = {},
): string {
  if (format === "json") return `${JSON.stringify(envelope, null, 2)}\n`;
  const oneLiner = envelope.status === "PASS" || envelope.status === "VALID_RED";
  return `${oneLiner ? renderPassLine(envelope) : renderFailBody(envelope, { rawText: context.rawText, omitted: context.omitted ?? [] })}\n`;
}
