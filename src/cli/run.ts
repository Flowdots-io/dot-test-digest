import { EX_USAGE, USAGE, UsageError, parseArgs } from "./args.js";
import { wantsColor } from "./color.js";
import type { SubcommandDeps } from "./dispatch.js";
import { EX_SOFTWARE } from "./errors.js";
import { loadConfig, type LoadedConfig } from "../config/load.js";
import { digestRun, type CapturedOutput } from "../pipeline.js";
import { PROGRESS_INTERVAL_MS, runChild, type ProgressOptions } from "../runner/capture.js";
import { finishRun } from "../runner/finish-run.js";
import { RawLogWriter } from "../runner/raw-log.js";
import { loadState, resolveScopeId, saveState, type RunState } from "../state/tdd-gate.js";
import type { CliOptions, DigestStatus } from "../types/schema.js";
import { VERSION } from "../version.js";

const COMMAND_NOT_FOUND = 127;

/** Where a wrapped run reads and writes: the process's own streams for the CLI, buffers for the MCP server. */
export interface RunIo {
  cwd: string;
  env: NodeJS.ProcessEnv;
  stdout: (text: string) => void;
  stderr: (text: string) => void;
  /** Stops the child after this long (`runChild`'s `timeoutMs`). */
  timeoutMs?: number;
}

export interface RunResult {
  exitCode: number;
  /** Present when the command ran and its digest was printed. */
  run?: { runId: string; status: DigestStatus; timedOut: boolean };
}

/** Loads the configuration for a run, prints its warnings, and returns it with the defaults it gives the flags. */
function configureRun(io: RunIo): { config: LoadedConfig; flagDefaults: Partial<CliOptions> } {
  const config = loadConfig({ cwd: io.cwd, env: io.env });
  for (const warning of config.warnings) io.stderr(`${warning}\n`);
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

/** `[flags] -- <command>`: runs the command in `io.cwd`, prints its digest, records the run. */
export async function runWrapped(argv: readonly string[], deps: SubcommandDeps, io: RunIo): Promise<RunResult> {
  const { env } = io;
  let config: LoadedConfig | undefined;
  let parsed;
  try {
    parsed = parseArgs(argv, () => {
      const configured = configureRun(io);
      config = configured.config;
      return configured.flagDefaults;
    });
  } catch (error) {
    if (error instanceof UsageError) {
      io.stderr(`${error.message}\n`);
      return { exitCode: EX_USAGE };
    }
    throw error;
  }

  if (parsed.kind === "help") {
    io.stdout(USAGE);
    return { exitCode: 0 };
  }
  if (parsed.kind === "version") {
    io.stdout(`${VERSION}\n`);
    return { exitCode: 0 };
  }

  const options = parsed.options;
  const command = parsed.command;
  const repoRoot = io.cwd;
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
    io.stderr(`dot-test-digest: cannot create the raw log: ${message}\n`);
    return { exitCode: EX_SOFTWARE };
  }

  const progress: ProgressOptions | undefined = options.progress === true
    ? {
        intervalMs: progressInterval(env),
        isTTY: deps.stderrIsTTY ?? process.stderr.isTTY === true,
        now: deps.now ?? Date.now,
        write: io.stderr,
      }
    : undefined;
  let timedOut = false;
  const capture = async (): Promise<CapturedOutput> => {
    const result = await runChild(command, {
      rawLog,
      cwd: repoRoot,
      ...(deps.lineSources ? { lineSources: deps.lineSources } : {}),
      ...(progress ? { progress } : {}),
      ...(io.timeoutMs === undefined ? {} : { timeoutMs: io.timeoutMs }),
    });
    timedOut ||= result.timedOut;
    return result;
  };

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
        io.stderr(`dot-test-digest: could not persist TDD state: ${message}\n`);
      }
    }

    io.stdout(digest);
    if (outcome.message !== undefined) io.stderr(`${outcome.message}\n`);
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
      { ...deps, warn: (line) => io.stderr(`${line}\n`) },
    );
    return { exitCode: outcome.exitCode, run: { runId: rawLog.runId, status: outcome.status, timedOut } };
  } catch (error) {
    rawLog.close();
    const message = error instanceof Error ? error.message : String(error);
    io.stderr(`dot-test-digest: ${message}\n`);
    const spawnCode = (error as NodeJS.ErrnoException).code;
    return { exitCode: spawnCode === "ENOENT" || spawnCode === "EACCES" ? COMMAND_NOT_FOUND : EX_SOFTWARE };
  }
}
