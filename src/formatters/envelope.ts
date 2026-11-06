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

/** What a cluster block keeps at one step of the size rule's ladder (SPEC-002 §4.4). */
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

/**
 * The size rule's ladder: each renderer drops detail from the one before. The
 * last level (header plus the raw text itself) is handled apart in `renderFailBody`.
 */
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

/** `sums[i]` is the byte length of the first `i` texts. */
function byteSums(texts: readonly string[]): number[] {
  const sums = [0];
  for (const text of texts) sums.push((sums.at(-1) ?? 0) + byteLength(text));
  return sums;
}

/**
 * The first ladder level whose text is no larger than the raw output plus the
 * header would be; the header plus the raw text itself when none is. Without
 * raw text the size rule is off and only the fullest level is rendered.
 */
function renderFailBody(
  envelope: DigestEnvelope,
  omitted: readonly FailureCluster[],
  rawText: string | undefined,
): string {
  for (const renderBlock of rawText === undefined ? LADDER.slice(0, 1) : LADDER) {
    const { header, body } = renderLevel(envelope, omitted, renderBlock);
    const text = truncateBytes(`${header}\n${body}`, FAIL_BYTE_CEILING - 1);
    if (rawText === undefined || byteLength(text) <= byteLength(rawText) + byteLength(header)) return text;
  }
  const raw = `${headerLine(envelope, (envelope.clusters ?? []).length)}\n${rawText}`;
  return raw.endsWith("\n") ? raw.slice(0, -1) : raw;
}

/** One ladder level: the header, and the cluster blocks and omitted-cluster footer that fit the token budget. */
function renderLevel(
  envelope: DigestEnvelope,
  omitted: readonly FailureCluster[],
  renderBlock: (cluster: FailureCluster) => string,
): { header: string; body: string } {
  const clusters = envelope.clusters ?? [];
  const all = [...clusters, ...omitted];
  const blocks = clusters.map(renderBlock);
  const lines = all.map((c) => `\n${renderOmittedLine(c)}`);
  const footerHead = (count: number): string => `\n+${count} more clusters (see log)`;

  // Every size below is a byte count measured once per piece, so choosing what
  // fits is arithmetic over prefix sums instead of re-rendering the whole text.
  const blockEnds = byteSums(blocks);
  const lineEnds = byteSums(lines);
  const fits = (kept: number, listed: number): boolean => {
    const count = all.length - kept;
    const footer = count > 0 ? byteLength(footerHead(count)) + (lineEnds[kept + listed] ?? 0) - (lineEnds[kept] ?? 0) : 0;
    const bytes =
      byteLength(headerLine(envelope, kept)) + 1 + (blockEnds[kept] ?? 0) + Math.max(0, kept - 1) + footer;
    return Math.ceil(bytes / BYTES_PER_TOKEN) <= MAX_FAIL_TOKENS;
  };

  let kept = clusters.length;
  while (kept > 1 && !fits(kept, all.length - kept)) kept -= 1;
  let listed = all.length - kept;
  while (listed > 0 && !fits(kept, listed)) listed -= 1;

  const header = headerLine(envelope, kept);
  const footer =
    all.length > kept ? `${footerHead(all.length - kept)}${lines.slice(kept, kept + listed).join("")}` : "";
  return { header, body: `${blocks.slice(0, kept).join("\n")}${footer}` };
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
