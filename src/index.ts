#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { EX_USAGE, USAGE, UsageError, parseArgs } from "./cli/args.js";
import { wantsColor } from "./cli/color.js";
import { runSubcommand, type SubcommandDeps } from "./cli/dispatch.js";
import { EX_SOFTWARE } from "./cli/errors.js";
import { isSubcommandName } from "./cli/subcommands.js";
import { loadConfig, type LoadedConfig } from "./config/load.js";
import { digestRun, type CapturedOutput } from "./pipeline.js";
import { PROGRESS_INTERVAL_MS, runChild, type ProgressOptions } from "./runner/capture.js";
import { finishRun } from "./runner/finish-run.js";
import { RawLogWriter } from "./runner/raw-log.js";
import { loadState, resolveScopeId, saveState, type RunState } from "./state/tdd-gate.js";
import type { CliOptions } from "./types/schema.js";
import { VERSION } from "./version.js";

const COMMAND_NOT_FOUND = 127;

/** Injection points for tests; each defaults to the process's own (production builds a JevClient inside triageUnstructured). */
export type MainDeps = SubcommandDeps;

/** Loads the configuration for a run, prints its warnings, and returns it with the defaults it gives the flags. */
function configureRun(env: NodeJS.ProcessEnv): { config: LoadedConfig; flagDefaults: Partial<CliOptions> } {
  const config = loadConfig({ cwd: process.cwd(), env });
  for (const warning of config.warnings) process.stderr.write(`${warning}\n`);
  const { maxClusters, contextLines, format, noJev, retryFlakes, color, progress } = config.values;
  return { config, flagDefaults: { maxClusters, contextLines, format, noJev, retryFlakes, color, progress } };
}

/** Node runs a timer whose delay is above this every 1 ms. */
const MAX_TIMER_MS = 2_147_483_647;

/** `DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS` shortens the heartbeat interval for tests; anything but a positive integer up to `MAX_TIMER_MS` is ignored. */
function progressInterval(env: NodeJS.ProcessEnv): number {
  const raw = env["DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS"] ?? "";
  const value = /^[1-9]\d*$/.test(raw) ? Number(raw) : Number.NaN;
  return value <= MAX_TIMER_MS ? value : PROGRESS_INTERVAL_MS;
}

export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const [first, ...rest] = argv;
  const env = deps.env ?? process.env;
  if (first !== undefined && isSubcommandName(first)) return runSubcommand(first, rest, { ...deps, env });

  let config: LoadedConfig | undefined;
  let parsed;
  try {
    parsed = parseArgs(argv, () => {
      const configured = configureRun(env);
      config = configured.config;
      return configured.flagDefaults;
    });
  } catch (error) {
    if (error instanceof UsageError) {
      process.stderr.write(`${error.message}\n`);
      return EX_USAGE;
    }
    throw error;
  }

  if (parsed.kind === "help") {
    process.stdout.write(USAGE);
    return 0;
  }
  if (parsed.kind === "version") {
    process.stdout.write(`${VERSION}\n`);
    return 0;
  }

  const options = parsed.options;
  const command = parsed.command;
  const repoRoot = process.cwd();
  const scopeId = resolveScopeId(repoRoot, options.scopeId);
  const previousState = options.tddPhase === "none" ? null : loadState(scopeId);
  const createdAt = new Date().toISOString();

  // Creating the log can fail (read-only cache). Fail loudly, but before the child
  // runs, so the child's exit code is never at stake.
  let rawLog: RawLogWriter;
  try {
    rawLog = new RawLogWriter();
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dot-test-digest: cannot create the raw log: ${message}\n`);
    return EX_SOFTWARE;
  }

  const progress: ProgressOptions | undefined = options.progress === true
    ? {
        intervalMs: progressInterval(env),
        isTTY: deps.stderrIsTTY ?? process.stderr.isTTY === true,
        now: deps.now ?? Date.now,
        write: (text) => process.stderr.write(text),
      }
    : undefined;
  const capture = async (): Promise<CapturedOutput> =>
    runChild(command, {
      rawLog,
      cwd: repoRoot,
      ...(deps.lineSources ? { lineSources: deps.lineSources } : {}),
      ...(progress ? { progress } : {}),
    });

  try {
    const outcome = await digestRun({
      output: await capture(),
      recapture: capture,
      command,
      repoRoot,
      logPath: rawLog.path,
      runId: rawLog.runId,
      settings: options,
      previousState,
      color: wantsColor(options.color ?? "auto", deps.stdoutIsTTY ?? process.stdout.isTTY === true, env),
      ...(deps.client ? { client: deps.client } : {}),
    });
    const { envelope, digest } = outcome;

    // An INVALID_GREEN run proved nothing, so it leaves the state as it was.
    if (options.tddPhase !== "none" && outcome.status !== "INVALID_GREEN") {
      const nextState: RunState = {
        version: 1,
        scope_id: scopeId,
        phase: options.tddPhase,
        baseline: outcome.recordBaseline ? outcome.failedTests : (previousState?.baseline ?? []),
        last_run: {
          failed: outcome.failedTests,
          passed: envelope.summary.passed,
          status: outcome.status,
          at: new Date().toISOString(),
        },
      };
      // INV-3: losing the cache must not change the verdict or the exit code.
      try {
        saveState(nextState);
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`dot-test-digest: could not persist TDD state: ${message}\n`);
      }
    }

    process.stdout.write(digest);
    if (outcome.message !== undefined) process.stderr.write(`${outcome.message}\n`);
    rawLog.close();

    finishRun(
      {
        outcome,
        rawLog,
        createdAt,
        source: "run",
        cwd: repoRoot,
        command,
        scopeId,
        settings: options,
        retention: config?.values,
      },
      { ...deps, warn: (line) => process.stderr.write(`${line}\n`) },
    );
    return outcome.exitCode;
  } catch (error) {
    rawLog.close();
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dot-test-digest: ${message}\n`);
    const spawnCode = (error as NodeJS.ErrnoException).code;
    return spawnCode === "ENOENT" || spawnCode === "EACCES" ? COMMAND_NOT_FOUND : EX_SOFTWARE;
  }
}

/** True when this module is the process entrypoint, also when the bin is reached through a symlink. Never throws. */
function isEntrypoint(entry: string | undefined): boolean {
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/** A reader that closed stdout (`| head`) or stderr early misses that stream; the exit code and the log stay (INV-3). */
function ignoreClosedPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") throw error;
}

if (isEntrypoint(process.argv[1])) {
  process.stdout.on("error", ignoreClosedPipe);
  process.stderr.on("error", ignoreClosedPipe);
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
