import { runGear0, type AdapterCounts } from "./adapters/index.js";
import { buildEnvelope, formatEnvelope } from "./formatters/envelope.js";
import { MIN_UNSTRUCTURED_LINES, triageUnstructured, type JevAsker } from "./gears/gear1-jev.js";
import { normalizeLine } from "./pruner/ansi-stripper.js";
import { dedupeFailures, type DedupeResult, type RawFailure } from "./pruner/cluster-dedup.js";
import { canonicalTestId, uniqueFailures } from "./pruner/failure-identity.js";
import { mapLines, type LineSource } from "./runner/line-source.js";
import { evaluatePhase, type RunState } from "./state/tdd-gate.js";
import type {
  CliOptions,
  DigestEnvelope,
  DigestStatus,
  ExecutionGear,
  FailureCluster,
} from "./types/schema.js";

/** The options that shape a digest; a replay takes them from the record. */
export type DigestSettings = Pick<
  CliOptions,
  "tddPhase" | "format" | "maxClusters" | "contextLines" | "noJev" | "retryFlakes" | "allowNoTests"
>;

/** The output of one command, as captured live or read back from a log. */
export interface CapturedOutput {
  lines: LineSource;
  exitCode: number;
  signal: string | null;
  durationMs: number;
}

export interface DigestInput {
  output: CapturedOutput;
  /** Runs the command again for a flake retry; only a live run can, so a replay or a digest leaves it out. */
  recapture?: () => Promise<CapturedOutput>;
  command: readonly string[];
  /** Where source windows are read from. */
  repoRoot: string;
  /** The log came from outside the tool: read source windows only from files under `repoRoot`. */
  confineWindows?: boolean;
  /** The log the `raw:` pointers name. */
  logPath: string;
  /** The run that log belongs to: `show <run_id>` reads it. */
  runId: string;
  settings: DigestSettings;
  /** The scope's TDD state before this run; `null` prints no delta. */
  previousState: RunState | null;
  color: boolean;
  /** `false` when no process was timed (a `digest` of a file): the header drops ` in <t>ms`. */
  timed?: boolean;
  client?: JevAsker;
}

export interface DigestOutcome {
  /** What the caller prints on stdout. */
  digest: string;
  /** One stderr line without its newline (a TDD verdict's reason), if any. */
  message?: string;
  exitCode: number;
  status: DigestStatus;
  envelope: DigestEnvelope;
  /** Canonical ids of the failing tests, for the TDD state. */
  failedTests: string[];
  /** The run is a red that sets the scope's baseline. */
  recordBaseline: boolean;
  gear: ExecutionGear;
  childExitCode: number;
  signal: string | null;
  durationMs: number;
  /** Kept clusters first, then the omitted ones. */
  clusters: FailureCluster[];
}

interface Analysis {
  output: CapturedOutput;
  gear: ExecutionGear;
  failures: RawFailure[];
  ranked: DedupeResult;
  counts: AdapterCounts;
  retryWanted: boolean;
  rawText: string | undefined;
}

function normalized(lines: LineSource): LineSource {
  return mapLines(lines, normalizeLine);
}

function rawTextOf(lines: LineSource): string | undefined {
  return lines
    .slice()
    .map((line) => `${line.text}\n`)
    .join("");
}

/** Whether a grammar finds at least one failure in the lines: what a `digest` without `--exit-code` exits on. */
export function parsesFailure(lines: LineSource): boolean {
  return (runGear0(normalized(lines))?.failures.length ?? 0) > 0;
}

async function analyze(output: CapturedOutput, input: DigestInput): Promise<Analysis> {
  const { settings, repoRoot } = input;
  const lines = normalized(output.lines);
  const gear0 = runGear0(lines, input.command);
  // A linter that fails on warnings alone (`--max-warnings=0`) has only its warnings to show.
  const reported =
    gear0 === null
      ? []
      : gear0.failures.length === 0 && output.exitCode !== 0
        ? (gear0.warnings ?? [])
        : gear0.failures;

  let ranked: DedupeResult =
    gear0 === null
      ? { kept: [], omitted: [] }
      : dedupeFailures(reported, {
          repoRoot,
          contextLines: settings.contextLines,
          keep: settings.maxClusters,
          logPath: input.logPath,
          ...(input.confineWindows === true ? { windowRoot: repoRoot } : {}),
        });
  let gear: ExecutionGear = gear0 === null ? "GEAR_0_HEURISTIC_FALLBACK" : "GEAR_0_GRAMMAR";
  let retryWanted = false;

  if (output.exitCode !== 0 && ranked.kept.length === 0) {
    const outcome = await triageUnstructured({
      lines,
      command: input.command,
      exitCode: output.exitCode,
      repoRoot,
      contextLines: settings.contextLines,
      // R11b: Jev needs >150 lines; shorter unstructured failures go straight to the heuristic.
      noJev: settings.noJev || lines.length < MIN_UNSTRUCTURED_LINES,
      retryFlakes: settings.retryFlakes,
      ...(input.client ? { client: input.client } : {}),
    });
    gear = outcome.gear;
    ranked = { kept: [outcome.cluster], omitted: [] };
    retryWanted = outcome.retry;
  }

  return {
    output,
    gear,
    failures: uniqueFailures(reported),
    ranked,
    counts: gear0?.counts ?? { passed: 0, failed: 0, skipped: 0 },
    retryWanted,
    rawText: rawTextOf(lines),
  };
}

/** Adapters, dedupe, the phase decision, the envelope and its rendering: the one path every entry point ends in. */
export async function digestRun(input: DigestInput): Promise<DigestOutcome> {
  const { settings } = input;
  let run = await analyze(input.output, input);
  if (run.retryWanted && settings.retryFlakes && input.recapture) run = await analyze(await input.recapture(), input);

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
    phase: settings.tddPhase,
    childExitCode: run.output.exitCode,
    failures: run.failures,
    gear: run.gear,
    previousState: input.previousState,
    failedTests,
    passed: run.counts.passed,
    failed: run.counts.failed,
    allowNoTests: settings.allowNoTests,
    // A runner we cannot parse may still leave behavioral evidence in the log.
    evidence: run.ranked.kept.map((cluster) => `${cluster.message}\n${cluster.signal_window}`).join("\n"),
  });

  const envelope = buildEnvelope({
    status: decision.status,
    phase: settings.tddPhase,
    exitCode: decision.exitCode,
    signal: run.output.signal,
    gear: run.gear,
    durationMs: run.output.durationMs,
    counts: run.counts,
    clusters: run.ranked.kept,
    ...(decision.delta ? { delta: decision.delta } : {}),
    rawLogPath: input.logPath,
    omittedCount: run.ranked.omitted.length,
    runId: input.runId,
  });

  const digest = formatEnvelope(envelope, settings.format, {
    omitted: run.ranked.omitted,
    rawText: run.rawText,
    color: input.color,
    timed: input.timed !== false,
  });

  return {
    digest,
    ...(decision.message !== undefined ? { message: decision.message } : {}),
    exitCode: decision.exitCode,
    status: decision.status,
    envelope,
    failedTests,
    recordBaseline: decision.recordBaseline,
    gear: run.gear,
    childExitCode: run.output.exitCode,
    signal: run.output.signal,
    durationMs: run.output.durationMs,
    clusters: [...run.ranked.kept, ...run.ranked.omitted],
  };
}
