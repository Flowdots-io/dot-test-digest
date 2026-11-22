import { AUTO_PRUNE_MAX_FILES, pruneCache, type PruneOptions, type PruneResult } from "../cache/prune.js";
import type { SettingValues } from "../config/settings.js";
import type { DigestOutcome, DigestSettings } from "../pipeline.js";
import { VERSION } from "../version.js";
import { cacheRoot, type RawLogWriter } from "./raw-log.js";
import { recordClusters, recordPathFor, writeRunRecord, type RunRecord } from "./run-record.js";
import path from "node:path";

/** What a run or a digest knows once its digest is printed. */
export interface FinishedRun {
  outcome: DigestOutcome;
  rawLog: RawLogWriter;
  createdAt: string;
  source: RunRecord["source"];
  /** The file a `digest` read, `"-"` for stdin. */
  input?: string;
  cwd: string;
  command: readonly string[];
  scopeId: string;
  settings: DigestSettings;
  /** The configuration's retention settings; `undefined` never prunes. */
  retention: SettingValues | undefined;
}

export interface FinishDeps {
  /** Writes `logs/<run>.json`; tests replace it to simulate a full disk. */
  writeRecord?: (file: string, record: RunRecord) => void;
  /** Tests replace it to simulate a failure. */
  prune?: (home: string, options: PruneOptions, now: number) => PruneResult;
  /** One stderr line, without its newline. */
  warn: (line: string) => void;
}

function messageOf(error: unknown): string {
  return error instanceof Error ? error.message : String(error);
}

function recordOf(run: FinishedRun): RunRecord {
  const { outcome, rawLog, settings } = run;
  const { envelope } = outcome;
  return {
    schema: 1,
    run_id: rawLog.runId,
    version: VERSION,
    created_at: run.createdAt,
    source: run.source,
    ...(run.input === undefined ? {} : { input: run.input }),
    cwd: run.cwd,
    command: [...run.command],
    exit_code: outcome.exitCode,
    child_exit_code: outcome.childExitCode,
    signal: outcome.signal,
    duration_ms: outcome.durationMs,
    phase: settings.tddPhase,
    scope_id: run.scopeId,
    status: outcome.status,
    execution_gear: outcome.gear,
    format: settings.format,
    options: {
      max_clusters: settings.maxClusters,
      context_lines: settings.contextLines,
      no_jev: settings.noJev,
      retry_flakes: settings.retryFlakes,
      allow_no_tests: settings.allowNoTests,
    },
    summary: { ...envelope.summary, warnings: envelope.summary.warnings ?? 0 },
    raw_lines: rawLog.linesWritten,
    raw_bytes: rawLog.bytesWritten,
    digest_bytes: Buffer.byteLength(outcome.digest, "utf8"),
    clusters: recordClusters(outcome.clusters),
  };
}

/** Writes the run record, then prunes the cache. Both are bookkeeping: a failure is a stderr line, never an exit code (INV-3). */
export function finishRun(run: FinishedRun, deps: FinishDeps): void {
  try {
    (deps.writeRecord ?? writeRunRecord)(recordPathFor(path.dirname(run.rawLog.path), run.rawLog.runId), recordOf(run));
  } catch (error) {
    deps.warn(`dot-test-digest: could not write the run record: ${messageOf(error)}`);
  }
  const { retention } = run;
  if (retention?.["retention.auto"] !== true) return;
  try {
    (deps.prune ?? pruneCache)(
      cacheRoot(),
      {
        keepRuns: retention["retention.keepRuns"],
        maxAgeDays: retention["retention.maxAgeDays"],
        stateMaxAgeDays: retention["retention.stateMaxAgeDays"],
        currentRunId: run.rawLog.runId,
        currentScopeId: run.scopeId,
        maxFiles: AUTO_PRUNE_MAX_FILES,
      },
      Date.now(),
    );
  } catch (error) {
    deps.warn(`dot-test-digest: could not prune the cache: ${messageOf(error)}`);
  }
}
