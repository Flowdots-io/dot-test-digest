import os from "node:os";
import type { AdapterCounts } from "../adapters/common.js";
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
  counts: AdapterCounts;
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
      ...(input.counts.warnings ? { warnings: input.counts.warnings } : {}),
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

/** The pass line leads with passed, the failure header with failed; skipped and warnings follow only when nonzero. */
function countsFragment(envelope: DigestEnvelope, lead: "passed" | "failed"): string {
  const { passed, failed, skipped, warnings = 0 } = envelope.summary;
  const pair = lead === "passed" ? `${passed} passed, ${failed} failed` : `${failed} failed, ${passed} passed`;
  return `${pair}${skipped > 0 ? `, ${skipped} skipped` : ""}${warnings > 0 ? `, ${warnings} warnings` : ""}`;
}

/** No grammar recognized the output, so there are no counts to report, only the exit code. */
function isUncounted(envelope: DigestEnvelope): boolean {
  return envelope.status === "PASS" && envelope.execution_gear === "GEAR_0_HEURISTIC_FALLBACK";
}

export function renderPassLine(envelope: DigestEnvelope): string {
  const outcome = isUncounted(envelope)
    ? "exit 0"
    : `${countsFragment(envelope, "passed")}${deltaFragment(envelope)}`;
  const line = `[${statusLabel(envelope)}] ${outcome} in ${envelope.duration_ms}ms | log: ${shortenPath(envelope.raw_log_path)}`;
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
    `[${statusLabel(envelope)}] ${countsFragment(envelope, "failed")} in ${envelope.duration_ms}ms | ${clusterCount} cluster${clusterCount === 1 ? "" : "s"}` +
    ` | log: ${shortenPath(envelope.raw_log_path)}`
  );
}

function byteLength(text: string): number {
  return Buffer.byteLength(text, "utf8");
}

/** The digest, without its final newline, is at most this many bytes: 2,400 with the newline and 600 EstimatedTokens. */
const FAIL_BODY_BYTES = Math.min(FAIL_BYTE_CEILING, MAX_FAIL_TOKENS * BYTES_PER_TOKEN) - 1;

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
  const footerOf = (count: number): string => (count > 0 ? `\n+${count} more clusters (see log)` : "");

  const fixedBytes = (kept: number): number =>
    byteLength(headerLine(envelope, kept) + footerOf(all.length - kept));
  let kept = clusters.length;
  while (kept > 1 && fixedBytes(kept) + byteLength(blocks.slice(0, kept).join("")) > FAIL_BODY_BYTES) kept -= 1;

  const header = headerLine(envelope, kept);
  const footer = footerOf(all.length - kept);
  const keptBlocks = truncateBytes(blocks.slice(0, kept).join(""), FAIL_BODY_BYTES - byteLength(header + footer));
  let body = `${header}${keptBlocks}${footer}`;
  for (const cluster of all.slice(kept)) {
    const line = `\n${renderOmittedLine(cluster)}`;
    if (byteLength(body) + byteLength(line) > FAIL_BODY_BYTES) break;
    body += line;
  }
  return { header, body };
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
