#!/usr/bin/env node
import { realpathSync } from "node:fs";
import path from "node:path";
import { pathToFileURL } from "node:url";
import { runGear0, type AdapterCounts } from "./adapters/index.js";
import { EX_USAGE, USAGE, UsageError, parseArgs } from "./cli/args.js";
import { buildEnvelope, formatEnvelope } from "./formatters/envelope.js";
import { MIN_UNSTRUCTURED_LINES, triageUnstructured, type JevAsker } from "./gears/gear1-jev.js";
import { normalizeLine } from "./pruner/ansi-stripper.js";
import { dedupeFailures, type DedupeResult, type RawFailure } from "./pruner/cluster-dedup.js";
import { canonicalTestId, uniqueFailures } from "./pruner/failure-identity.js";
import { runChild, type CapturedLine } from "./runner/capture.js";
import { RawLogWriter } from "./runner/raw-log.js";
import { recordClusters, recordPathFor, writeRunRecord, type RunRecord } from "./runner/run-record.js";
import {
  evaluatePhase,
  loadState,
  resolveScopeId,
  saveState,
  type RunState,
} from "./state/tdd-gate.js";
import type { ExecutionGear } from "./types/schema.js";
import { VERSION } from "./version.js";

const COMMAND_NOT_FOUND = 127;
const EX_SOFTWARE = 70;

interface Attempt {
  lines: CapturedLine[];
  gear: ExecutionGear;
  failures: RawFailure[];
  ranked: DedupeResult;
  counts: AdapterCounts;
  exitCode: number;
  signal: string | null;
  durationMs: number;
  retryWanted: boolean;
  logPath: string;
  rawText: string;
}

export interface MainDeps {
  /** Injection point for tests; production builds a JevClient inside triageUnstructured. */
  client?: JevAsker;
  /** Writes `logs/<run>.json`; tests replace it to simulate a full disk. */
  writeRecord?: (file: string, record: RunRecord) => void;
}

export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  let parsed;
  try {
    parsed = parseArgs(argv);
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

  const attempt = async (): Promise<Attempt> => {
    const capture = await runChild(command, { rawLog, cwd: repoRoot });
    const lines = capture.lines.map((line) => ({ ...line, text: normalizeLine(line.text) }));
    const gear0 = runGear0(lines);
    // A linter that fails on warnings alone (`--max-warnings=0`) has only its warnings to show.
    const reported =
      gear0 === null
        ? []
        : gear0.failures.length === 0 && capture.exitCode !== 0
          ? (gear0.warnings ?? [])
          : gear0.failures;

    let ranked: DedupeResult =
      gear0 === null
        ? { kept: [], omitted: [] }
        : dedupeFailures(reported, {
            repoRoot,
            contextLines: options.contextLines,
            keep: options.maxClusters,
            logPath: rawLog.path,
          });
    let gear: ExecutionGear = gear0 === null ? "GEAR_0_HEURISTIC_FALLBACK" : "GEAR_0_GRAMMAR";
    let retryWanted = false;

    if (capture.exitCode !== 0 && ranked.kept.length === 0) {
      const outcome = await triageUnstructured({
        lines,
        command,
        exitCode: capture.exitCode,
        repoRoot,
        contextLines: options.contextLines,
        // R11b: Jev needs >150 lines; shorter unstructured failures go straight to the heuristic.
        noJev: options.noJev || lines.length < MIN_UNSTRUCTURED_LINES,
        retryFlakes: options.retryFlakes,
        ...(deps.client ? { client: deps.client } : {}),
      });
      gear = outcome.gear;
      ranked = { kept: [outcome.cluster], omitted: [] };
      retryWanted = outcome.retry;
    }

    return {
      lines,
      gear,
      failures: uniqueFailures(reported),
      ranked,
      counts: gear0?.counts ?? { passed: 0, failed: 0, skipped: 0 },
      exitCode: capture.exitCode,
      signal: capture.signal,
      durationMs: capture.durationMs,
      retryWanted,
      logPath: rawLog.path,
      rawText: lines.map((line) => `${line.text}\n`).join(""),
    };
  };

  try {
    let run = await attempt();
    if (run.retryWanted && options.retryFlakes) run = await attempt();

    // SPEC-002 §4.3: baseline and delta compare canonical identities, not the
    // presentation strings a reporter happened to print.
    const failedTests = [
      ...new Set(
        run.failures
          .map((failure) => canonicalTestId(failure.testFile, failure.testName))
          .filter((id): id is string => id !== null),
      ),
    ];

    const decision = evaluatePhase({
      phase: options.tddPhase,
      childExitCode: run.exitCode,
      failures: run.failures,
      gear: run.gear,
      previousState,
      failedTests,
      passed: run.counts.passed,
      failed: run.counts.failed,
      allowNoTests: options.allowNoTests,
      // A runner we cannot parse may still leave behavioral evidence in the log.
      evidence: run.ranked.kept
        .map((cluster) => `${cluster.message}\n${cluster.signal_window}`)
        .join("\n"),
    });

    // An INVALID_GREEN run proved nothing, so it leaves the state as it was.
    if (options.tddPhase !== "none" && decision.status !== "INVALID_GREEN") {
      const nextState: RunState = {
        version: 1,
        scope_id: scopeId,
        phase: options.tddPhase,
        baseline: decision.recordBaseline ? failedTests : (previousState?.baseline ?? []),
        last_run: {
          failed: failedTests,
          passed: run.counts.passed,
          status: decision.status,
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

    const envelope = buildEnvelope({
      status: decision.status,
      phase: options.tddPhase,
      exitCode: decision.exitCode,
      signal: run.signal,
      gear: run.gear,
      durationMs: run.durationMs,
      counts: run.counts,
      clusters: run.ranked.kept,
      ...(decision.delta ? { delta: decision.delta } : {}),
      rawLogPath: run.logPath,
    });

    const digest = formatEnvelope(envelope, options.format, { omitted: run.ranked.omitted, rawText: run.rawText });
    process.stdout.write(digest);
    if (decision.message !== undefined) process.stderr.write(`${decision.message}\n`);
    rawLog.close();

    const record: RunRecord = {
      schema: 1,
      run_id: rawLog.runId,
      version: VERSION,
      created_at: createdAt,
      source: "run",
      cwd: repoRoot,
      command,
      exit_code: decision.exitCode,
      child_exit_code: run.exitCode,
      signal: run.signal,
      duration_ms: run.durationMs,
      phase: options.tddPhase,
      scope_id: scopeId,
      status: decision.status,
      execution_gear: run.gear,
      format: options.format,
      options: {
        max_clusters: options.maxClusters,
        context_lines: options.contextLines,
        no_jev: options.noJev,
        retry_flakes: options.retryFlakes,
      },
      summary: { ...envelope.summary, warnings: envelope.summary.warnings ?? 0 },
      raw_lines: rawLog.linesWritten,
      raw_bytes: rawLog.bytesWritten,
      digest_bytes: Buffer.byteLength(digest, "utf8"),
      clusters: recordClusters([...run.ranked.kept, ...run.ranked.omitted]),
    };
    // INV-3: the record is bookkeeping; losing it must not change the exit code.
    try {
      (deps.writeRecord ?? writeRunRecord)(recordPathFor(path.dirname(rawLog.path), rawLog.runId), record);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      process.stderr.write(`dot-test-digest: could not write the run record: ${message}\n`);
    }
    return decision.exitCode;
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
