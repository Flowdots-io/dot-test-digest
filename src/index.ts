#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { EX_USAGE, USAGE, UsageError, parseArgs } from "./cli/args.js";
import { AUTO_PRUNE_MAX_FILES, pruneCache, type PruneOptions, type PruneResult } from "./cache/prune.js";
import { wantsColor } from "./cli/color.js";
import { runSubcommand } from "./cli/dispatch.js";
import { EX_SOFTWARE } from "./cli/errors.js";
import { isSubcommandName } from "./cli/subcommands.js";
import { loadConfig, type LoadedConfig } from "./config/load.js";
import type { JevAsker } from "./gears/gear1-jev.js";
import { digestRun, type CapturedOutput } from "./pipeline.js";
import { runChild } from "./runner/capture.js";
import { RawLogWriter, cacheRoot } from "./runner/raw-log.js";
import { recordClusters, recordPathFor, writeRunRecord, type RunRecord } from "./runner/run-record.js";
import { loadState, resolveScopeId, saveState, type RunState } from "./state/tdd-gate.js";
import type { CliOptions } from "./types/schema.js";
import { VERSION } from "./version.js";

const COMMAND_NOT_FOUND = 127;

export interface MainDeps {
  /** Injection point for tests; production builds a JevClient inside triageUnstructured. */
  client?: JevAsker;
  /** Writes `logs/<run>.json`; tests replace it to simulate a full disk. */
  writeRecord?: (file: string, record: RunRecord) => void;
  /** The environment the configuration and color decisions read; defaults to `process.env`. */
  env?: NodeJS.ProcessEnv;
  /** Whether stdout is a terminal, for `--color=auto`; defaults to `process.stdout.isTTY`. */
  stdoutIsTTY?: boolean;
  /** Prunes the cache after the digest is printed; tests replace it to simulate a failure. */
  prune?: (home: string, options: PruneOptions, now: number) => PruneResult;
}

/** Loads the configuration for a run, prints its warnings, and returns it with the defaults it gives the flags. */
function configureRun(env: NodeJS.ProcessEnv): { config: LoadedConfig; flagDefaults: Partial<CliOptions> } {
  const config = loadConfig({ cwd: process.cwd(), env });
  for (const warning of config.warnings) process.stderr.write(`${warning}\n`);
  const { maxClusters, contextLines, format, noJev, retryFlakes, color } = config.values;
  return { config, flagDefaults: { maxClusters, contextLines, format, noJev, retryFlakes, color } };
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

  const capture = async (): Promise<CapturedOutput> => runChild(command, { rawLog, cwd: repoRoot });

  try {
    const outcome = await digestRun({
      output: await capture(),
      recapture: capture,
      command,
      repoRoot,
      logPath: rawLog.path,
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

    const record: RunRecord = {
      schema: 1,
      run_id: rawLog.runId,
      version: VERSION,
      created_at: createdAt,
      source: "run",
      cwd: repoRoot,
      command,
      exit_code: outcome.exitCode,
      child_exit_code: outcome.childExitCode,
      signal: outcome.signal,
      duration_ms: outcome.durationMs,
      phase: options.tddPhase,
      scope_id: scopeId,
      status: outcome.status,
      execution_gear: outcome.gear,
      format: options.format,
      options: {
        max_clusters: options.maxClusters,
        context_lines: options.contextLines,
        no_jev: options.noJev,
        retry_flakes: options.retryFlakes,
        allow_no_tests: options.allowNoTests,
      },
      summary: { ...envelope.summary, warnings: envelope.summary.warnings ?? 0 },
      raw_lines: rawLog.linesWritten,
      raw_bytes: rawLog.bytesWritten,
      digest_bytes: Buffer.byteLength(digest, "utf8"),
      clusters: recordClusters(outcome.clusters),
    };
    // INV-3: the record is bookkeeping; losing it must not change the exit code.
    try {
      (deps.writeRecord ?? writeRunRecord)(recordPathFor(path.dirname(rawLog.path), rawLog.runId), record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`dot-test-digest: could not write the run record: ${message}\n`);
    }
    const retention = config?.values;
    if (retention?.["retention.auto"] === true) {
      // INV-3: pruning is housekeeping; a failure must not change the exit code.
      try {
        (deps.prune ?? pruneCache)(
          cacheRoot(),
          {
            keepRuns: retention["retention.keepRuns"],
            maxAgeDays: retention["retention.maxAgeDays"],
            stateMaxAgeDays: retention["retention.stateMaxAgeDays"],
            currentRunId: rawLog.runId,
            currentScopeId: scopeId,
            maxFiles: AUTO_PRUNE_MAX_FILES,
          },
          Date.now(),
        );
      } catch (error) {
        const message = error instanceof Error ? error.message : String(error);
        process.stderr.write(`dot-test-digest: could not prune the cache: ${message}\n`);
      }
    }
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

/** A reader that closed stdout early (`| head`) gets no digest; the exit code and the log stay (INV-3). */
function ignoreClosedPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") throw error;
}

if (isEntrypoint(process.argv[1])) {
  process.stdout.on("error", ignoreClosedPipe);
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
