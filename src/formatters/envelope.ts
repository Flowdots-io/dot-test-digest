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

interface Detail {
  window: boolean;
  stack: boolean;
}

function clusterHead(cluster: FailureCluster): string {
  return `${cluster.cluster_id} ${cluster.error_kind} x${cluster.affected_count} ${cluster.top_frame}`;
}

function renderCluster(cluster: FailureCluster, detail: Detail): string {
  const rows: string[] = [clusterHead(cluster)];
  if (cluster.message !== "") rows.push(`  ${truncateBytes(cluster.message, MESSAGE_BYTE_CEILING)}`);
  if (cluster.diff) {
    rows.push(`  diff: expected ${cluster.diff.expected} / received ${cluster.diff.received}`);
  }
  if (detail.stack) {
    for (const frame of cluster.pruned_stack) {
      if (frame !== cluster.top_frame) rows.push(`  ${frame}`);
    }
  }
  if (detail.window && cluster.signal_window !== "") {
    for (const line of cluster.signal_window.split("\n")) rows.push(`  ${line}`);
  }
  if (cluster.sample_tests.length > 0) rows.push(`  tests: ${cluster.sample_tests.join(", ")}`);
  rows.push(`  raw: ${cluster.raw_log_lines}`);
  return rows.join("\n");
}

const LABEL_BYTE_CEILING = 80;

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

const LADDER: readonly ((cluster: FailureCluster) => string)[] = [
  (cluster) => renderCluster(cluster, { window: true, stack: true }),
  (cluster) => renderCluster(cluster, { window: false, stack: true }),
  (cluster) => renderCluster(cluster, { window: false, stack: false }),
  renderOneLine,
];

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

function byteSums(texts: readonly string[]): number[] {
  const sums = [0];
  for (const text of texts) sums.push((sums.at(-1) ?? 0) + byteLength(text));
  return sums;
}

/** The digest, without its final newline, is at most this many bytes: 2,400 with the newline and 600 EstimatedTokens. */
const FAIL_BODY_BYTES = Math.min(FAIL_BYTE_CEILING - 1, MAX_FAIL_TOKENS * BYTES_PER_TOKEN);

function renderFailBody(
  envelope: DigestEnvelope,
  omitted: readonly FailureCluster[],
  rawText: string | undefined,
): string {
  for (const renderBlock of rawText === undefined ? LADDER.slice(0, 1) : LADDER) {
    const { header, body } = renderLevel(envelope, omitted, renderBlock);
    const bounded = truncateBytes(body, FAIL_BODY_BYTES);
    if (rawText === undefined || byteLength(bounded) <= byteLength(rawText) + byteLength(header)) return bounded;
  }
  const raw = `${headerLine(envelope, (envelope.clusters ?? []).length)}\n${rawText}`;
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

/**
 * The limit decides the full blocks first, with the `+N more clusters (see log)` line reserved, then fills what is
 * left with whole listed lines, so the footer is never the part cut and a long listing never takes blocks away.
 */
function renderLevel(
  envelope: DigestEnvelope,
  omitted: readonly FailureCluster[],
  renderBlock: (cluster: FailureCluster) => string,
): { header: string; body: string } {
  const clusters = envelope.clusters ?? [];
  const all = [...clusters, ...omitted];
  const blocks = clusters.map((cluster) => `\n${renderBlock(cluster)}`);
  const lines = all.map((cluster) => `\n${renderOmittedLine(cluster)}`);
  const footerOf = (count: number): string => (count > 0 ? `\n+${count} more clusters (see log)` : "");

  const blockEnds = byteSums(blocks);
  const lineEnds = byteSums(lines);
  const blocksBytes = (kept: number): number =>
    byteLength(headerLine(envelope, kept)) + (blockEnds[kept] ?? 0) + byteLength(footerOf(all.length - kept));

  let kept = clusters.length;
  while (kept > 1 && blocksBytes(kept) > FAIL_BODY_BYTES) kept -= 1;
  let listed = all.length - kept;
  while (listed > 0 && blocksBytes(kept) + (lineEnds[kept + listed] ?? 0) - (lineEnds[kept] ?? 0) > FAIL_BODY_BYTES) {
    listed -= 1;
  }

  const header = headerLine(envelope, kept);
  const footer = footerOf(all.length - kept);
  const keptBlocks = blocks.slice(0, kept).join("");
  const room = FAIL_BODY_BYTES - byteLength(header) - byteLength(footer);
  const rest =
    byteLength(keptBlocks) > room
      ? `${truncateBytes(keptBlocks, room)}${footer}`
      : `${keptBlocks}${footer}${lines.slice(kept, kept + listed).join("")}`;
  return { header, body: `${header}${rest}` };
}

export function formatEnvelope(
  envelope: DigestEnvelope,
  format: OutputFormat,
  context: RenderContext = {},
): string {
  if (format === "json") return `${JSON.stringify(envelope, null, 2)}\n`;
  const { rawText, omitted = [] } = context;
  const oneLiner = envelope.status === "PASS" || envelope.status === "VALID_RED";
  return `${oneLiner ? renderPassLine(envelope) : renderFailBody(envelope, omitted, rawText)}\n`;
}
