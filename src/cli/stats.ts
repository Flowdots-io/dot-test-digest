import { tokensForBytes } from "../formatters/envelope.js";
import { loadRunRecords, type RunRecord } from "../runner/run-record.js";
import type { Subcommand } from "./dispatch.js";
import { UsageError } from "./errors.js";
import { newestFirst } from "./run-ref.js";

const STATS_USAGE = "dot-test-digest stats [--last N] [--json]";

export interface UsageStats {
  runs: number;
  raw_bytes: number;
  digest_bytes: number;
  saved_bytes: number;
  /** `(raw - digest) / raw * 100` to one decimal; `0` when nothing raw was recorded. */
  saved_percent: number;
  /** The EstimatedToken rule (4 bytes a token, rounded up); `0` when nothing was saved. */
  estimated_tokens_saved: number;
  /** Runs per status, keys in alphabetical order. */
  statuses: Record<string, number>;
}

/** Totals over `records`, or over the `last` newest of them by `created_at`. */
export function summarize(records: readonly RunRecord[], last?: number): UsageStats {
  const counted = last === undefined ? records : [...records].sort(newestFirst).slice(0, last);
  let raw = 0;
  let digest = 0;
  const byStatus = new Map<string, number>();
  for (const record of counted) {
    raw += record.raw_bytes;
    digest += record.digest_bytes;
    byStatus.set(record.status, (byStatus.get(record.status) ?? 0) + 1);
  }
  const saved = raw - digest;
  return {
    runs: counted.length,
    raw_bytes: raw,
    digest_bytes: digest,
    saved_bytes: saved,
    saved_percent: raw === 0 ? 0 : Math.round((saved / raw) * 1000) / 10,
    estimated_tokens_saved: saved > 0 ? tokensForBytes(saved) : 0,
    statuses: Object.fromEntries([...byStatus].sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))),
  };
}

export function formatStats(stats: UsageStats): string {
  if (stats.runs === 0) return "runs: 0\n";
  const statuses = Object.entries(stats.statuses).map(([status, count]) => `${status} ${count}`);
  return [
    `runs: ${stats.runs}`,
    `raw bytes: ${stats.raw_bytes}`,
    `digest bytes: ${stats.digest_bytes}`,
    `saved: ${stats.saved_bytes} bytes (${stats.saved_percent.toFixed(1)}%), about ${stats.estimated_tokens_saved} tokens`,
    `status: ${statuses.join(", ")}`,
    "",
  ].join("\n");
}

function parseStatsArgs(args: readonly string[]): { last?: number; json: boolean } {
  let last: number | undefined;
  let json = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (arg === "--json") {
      json = true;
    } else if (arg === "--last" || arg.startsWith("--last=")) {
      const raw = arg === "--last" ? args[(index += 1)] : arg.slice("--last=".length);
      if (raw === undefined || !/^[1-9]\d*$/.test(raw)) {
        throw new UsageError(`--last must be a positive integer, got ${raw ?? "nothing"}`);
      }
      last = Number(raw);
    } else {
      throw new UsageError(`unexpected argument "${arg}": ${STATS_USAGE}`);
    }
  }
  return { ...(last === undefined ? {} : { last }), json };
}

/** `stats [--last N] [--json]`: what the recorded runs of every directory saved. Reads only. */
export const runStats: Subcommand = (args, context) => {
  const options = parseStatsArgs(args);
  const stats = summarize(loadRunRecords(context.logDir), options.last);
  context.write(options.json ? `${JSON.stringify(stats)}\n` : formatStats(stats));
  return 0;
};
