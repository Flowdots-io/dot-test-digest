import fs from "node:fs";
import path from "node:path";
import { loadConfig } from "../config/load.js";
import { digestRun, parsesFailure, type DigestSettings } from "../pipeline.js";
import type { CapturedLine } from "../runner/capture.js";
import { finishRun } from "../runner/finish-run.js";
import { RawLogWriter } from "../runner/raw-log.js";
import { resolveScopeId } from "../state/tdd-gate.js";
import { OutputFormatSchema, type OutputFormat } from "../types/schema.js";
import { FORMAT_CHOICES, readBoolean, readInt } from "./args.js";
import { wantsColor } from "./color.js";
import type { Subcommand } from "./dispatch.js";
import { NoInputError, UsageError } from "./errors.js";

const DIGEST_USAGE =
  "dot-test-digest digest <file|-> [--exit-code N] [--format F] [--max-clusters N] [--context-lines N] [--no-jev] (-- <file> for a name starting with -)";
const STDIN = "-";

interface DigestArgs {
  input: string;
  exitCode?: number;
  format?: OutputFormat;
  maxClusters?: number;
  contextLines?: number;
  noJev?: boolean;
}

function readExitCode(raw: string): number {
  const value = Number(raw);
  if (!/^\d+$/.test(raw) || value > 255) {
    throw new UsageError(`--exit-code must be an integer between 0 and 255, got ${raw}`);
  }
  return value;
}

function parseDigestArgs(args: readonly string[]): DigestArgs {
  const positional: string[] = [];
  const parsed: Omit<DigestArgs, "input"> = {};
  let flagsEnded = false;
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    if (!flagsEnded && arg === "--") {
      flagsEnded = true;
      continue;
    }
    if (flagsEnded || arg === STDIN || !arg.startsWith("-")) {
      positional.push(arg);
      continue;
    }
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    if (flag === "--tdd-phase") throw new UsageError("--tdd-phase is not supported by digest");
    if (flag === "--no-jev") {
      parsed.noJev = readBoolean(flag, arg);
      continue;
    }
    const value = equals === -1 ? args[(index += 1)] : arg.slice(equals + 1);
    if (value === undefined) throw new UsageError(`${flag} requires a value`);
    if (flag === "--exit-code") {
      parsed.exitCode = readExitCode(value);
    } else if (flag === "--format") {
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
  const [input, extra] = positional;
  if (input === undefined) throw new UsageError(`digest needs a file or -: ${DIGEST_USAGE}`);
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}": ${DIGEST_USAGE}`);
  return { input, ...parsed };
}

async function readStream(stream: NodeJS.ReadableStream): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of stream) chunks.push(typeof chunk === "string" ? Buffer.from(chunk) : chunk);
  return Buffer.concat(chunks).toString("utf8");
}

function readFile(file: string, cwd: string): string {
  try {
    return fs.readFileSync(path.resolve(cwd, file), "utf8");
  } catch (error) {
    const reason = (error as NodeJS.ErrnoException).code ?? (error instanceof Error ? error.message : String(error));
    throw new NoInputError(`cannot read ${file}: ${reason}`);
  }
}

function linesOf(text: string): CapturedLine[] {
  const texts = text.split("\n");
  if (texts.at(-1) === "") texts.pop();
  return texts.map((line, index) => ({ stream: "stdout", text: line, line: index + 1 }));
}

/**
 * `digest <file|->`: an existing log through the pipeline a run uses. The lines are copied to a new log, so `raw:`
 * pointers are the input's line numbers, and the run is recorded with `source: "digest"`. Exits with `--exit-code`,
 * else 1 when a grammar found a failure and 0 otherwise.
 */
export const runDigest: Subcommand = async (args, context) => {
  const flags = parseDigestArgs(args);
  let text: string;
  if (flags.input === STDIN) {
    if (context.stdinIsTTY) throw new UsageError('no input: pipe a log into "digest -"');
    text = await readStream(context.stdin);
  } else {
    text = readFile(flags.input, context.cwd);
  }
  if (text === "") throw new UsageError("input is empty");

  const config = loadConfig({ cwd: context.cwd, env: context.env });
  for (const warning of config.warnings) context.warn(warning);
  const { values } = config;
  const settings: DigestSettings = {
    tddPhase: "none",
    format: flags.format ?? values.format,
    maxClusters: flags.maxClusters ?? values.maxClusters,
    contextLines: flags.contextLines ?? values.contextLines,
    noJev: flags.noJev ?? values.noJev,
    retryFlakes: false,
    allowNoTests: false,
  };

  const createdAt = new Date().toISOString();
  const rawLog = new RawLogWriter({ dir: context.logDir });
  rawLog.write(text.endsWith("\n") ? text : `${text}\n`);
  rawLog.close();

  const lines = linesOf(text);
  const outcome = await digestRun({
    output: {
      lines,
      exitCode: flags.exitCode ?? (parsesFailure(lines) ? 1 : 0),
      signal: null,
      durationMs: 0,
    },
    command: [],
    repoRoot: context.cwd,
    confineWindows: true,
    logPath: rawLog.path,
    runId: rawLog.runId,
    settings,
    previousState: null,
    color: wantsColor(values.color, context.stdoutIsTTY, context.env),
    timed: false,
    ...(context.client ? { client: context.client } : {}),
  });
  context.write(outcome.digest);
  if (outcome.message !== undefined) context.warn(outcome.message);

  finishRun(
    {
      outcome,
      rawLog,
      createdAt,
      source: "digest",
      input: flags.input,
      cwd: context.cwd,
      command: [],
      scopeId: resolveScopeId(context.cwd),
      settings,
      retention: values,
    },
    { ...context.finish, warn: context.warn },
  );
  return outcome.exitCode;
};
