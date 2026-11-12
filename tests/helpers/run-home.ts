import fs from "node:fs";
import path from "node:path";
import type { RunRecord } from "../../src/runner/run-record.js";
import { tempDir } from "./node-cart.js";

export interface SyntheticRun {
  id: string;
  cwd: string;
  createdAt: string;
  /** The log's lines; `null` leaves no log (a pruned or partly deleted run). */
  log?: readonly string[] | null;
  /** Overrides on the generated record; `null` leaves no record (a log from 0.1.x). */
  record?: Partial<RunRecord> | null;
}

/** A complete, valid record with neutral values; `overrides` win. */
export function syntheticRecord(run: Pick<SyntheticRun, "id" | "cwd" | "createdAt">, overrides: Partial<RunRecord> = {}): RunRecord {
  return {
    schema: 1,
    run_id: run.id,
    version: "0.1.0",
    created_at: run.createdAt,
    source: "run",
    cwd: run.cwd,
    command: ["true"],
    exit_code: 0,
    child_exit_code: 0,
    signal: null,
    duration_ms: 1,
    phase: "none",
    scope_id: "s",
    status: "PASS",
    execution_gear: "GEAR_0_HEURISTIC_FALLBACK",
    format: "compact-md",
    options: { max_clusters: 5, context_lines: 2, no_jev: true, retry_flakes: false, allow_no_tests: false },
    summary: { passed: 0, failed: 0, skipped: 0, warnings: 0, total_clusters: 0 },
    raw_lines: 0,
    raw_bytes: 0,
    digest_bytes: 0,
    clusters: [],
    ...overrides,
  };
}

/** Writes `logs/<id>.log` and `logs/<id>.json` for each run into `home` (a fresh temp dir by default). */
export function syntheticHome(runs: readonly SyntheticRun[], home: string = tempDir("dtd-home-")): string {
  const logs = path.join(home, "logs");
  fs.mkdirSync(logs, { recursive: true });
  for (const run of runs) {
    const lines = run.log === undefined ? [`log of ${run.id}`] : run.log;
    const text = lines === null ? "" : lines.map((line) => `${line}\n`).join("");
    if (lines !== null) fs.writeFileSync(path.join(logs, `${run.id}.log`), text);
    if (run.record === null) continue;
    const record = syntheticRecord(run, {
      raw_lines: lines?.length ?? 0,
      raw_bytes: Buffer.byteLength(text),
      ...run.record,
    });
    fs.writeFileSync(path.join(logs, `${run.id}.json`), `${JSON.stringify(record, null, 2)}\n`);
  }
  return home;
}

/** Real directories `<root>/<name>` for records' `cwd`, resolved as `process.cwd()` reports them. */
export function workDirs<const N extends string>(...names: N[]): Record<N, string> {
  const root = fs.realpathSync(tempDir("dtd-work-"));
  const dirs = {} as Record<N, string>;
  for (const name of names) {
    dirs[name] = path.join(root, name);
    fs.mkdirSync(dirs[name], { recursive: true });
  }
  return dirs;
}
