import fs from "node:fs";
import { loadConfig } from "../config/load.js";
import { digestRun, type DigestSettings } from "../pipeline.js";
import { LogLines } from "../runner/line-source.js";
import { OutputFormatSchema, type OutputFormat } from "../types/schema.js";
import { FORMAT_CHOICES, readInt } from "./args.js";
import { wantsColor } from "./color.js";
import type { Subcommand } from "./dispatch.js";
import { NoInputError, UsageError } from "./errors.js";
import { resolveRunRef } from "./run-ref.js";

const REPLAY_USAGE = "dot-test-digest replay <run> [--format F] [--max-clusters N] [--context-lines N]";

interface ReplayArgs {
  ref: string;
  format?: OutputFormat;
  maxClusters?: number;
  contextLines?: number;
}

function parseReplayArgs(args: readonly string[]): ReplayArgs {
  const positional: string[] = [];
  const parsed: Omit<ReplayArgs, "ref"> = {};
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const value = equals === -1 ? args[(index += 1)] : arg.slice(equals + 1);
    if (value === undefined) throw new UsageError(`${flag} requires a value`);
    if (flag === "--format") {
      const format = OutputFormatSchema.safeParse(value);
      if (!format.success) throw new UsageError(`${flag} must be ${FORMAT_CHOICES}`);
      parsed.format = format.data;
    } else if (flag === "--max-clusters") {
      parsed.maxClusters = readInt(flag, value, 1, 15);
    } else if (flag === "--context-lines") {
      parsed.contextLines = readInt(flag, value, 0, 5);
    } else {
      throw new UsageError(`unknown flag: ${flag}`);
    }
  }
  const [ref, extra] = positional;
  if (ref === undefined) throw new UsageError(`replay needs a run: ${REPLAY_USAGE}`);
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}": ${REPLAY_USAGE}`);
  return { ref, ...parsed };
}

/**
 * `replay <run>`: the digest of a recorded run again, from its record and log. Nothing runs, nothing is written,
 * the network is never called, and no TDD state is read, so no delta is printed. Exits with the record's exit code.
 */
export const runReplay: Subcommand = async (args, context) => {
  const flags = parseReplayArgs(args);
  const run = resolveRunRef(flags.ref, context);
  if (run.record === null) {
    throw new NoInputError(
      fs.existsSync(run.recordPath)
        ? `record of ${run.runId} is missing or unreadable`
        : `${run.runId} has no record (written by an older version); replay needs one`,
    );
  }
  if (!run.hasLog) throw new NoInputError(`log of ${run.runId} was removed`);

  const { record } = run;
  const settings: DigestSettings = {
    tddPhase: record.phase,
    format: flags.format ?? record.format,
    maxClusters: flags.maxClusters ?? record.options.max_clusters,
    contextLines: flags.contextLines ?? record.options.context_lines,
    noJev: true,
    retryFlakes: false,
    allowNoTests: record.options.allow_no_tests,
  };
  const config = loadConfig({ cwd: context.cwd, env: context.env });
  for (const warning of config.warnings) context.warn(warning);

  const outcome = await digestRun({
    output: {
      // Numbered as the run numbered them; the stream is not stored and no adapter reads it.
      lines: LogLines.read(run.logPath),
      exitCode: record.child_exit_code,
      signal: record.signal,
      durationMs: record.duration_ms,
    },
    command: record.command,
    repoRoot: record.cwd,
    // A digest's log came from outside the tool, and no process was timed.
    confineWindows: record.source === "digest",
    timed: record.source !== "digest",
    logPath: run.logPath,
    runId: run.runId,
    settings,
    previousState: null,
    color: wantsColor(config.values.color, context.stdoutIsTTY, context.env),
    ...(context.client ? { client: context.client } : {}),
  });
  context.write(outcome.digest);
  if (outcome.message !== undefined) context.warn(outcome.message);
  return record.exit_code;
};
