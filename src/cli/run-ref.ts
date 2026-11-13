import fs from "node:fs";
import path from "node:path";
import {
  listLogDir,
  loadRunRecords,
  logPathFor,
  readRunRecord,
  recordPathFor,
  type RunRecord,
} from "../runner/run-record.js";
import { NoInputError, UsageError } from "./errors.js";

export const MIN_PREFIX = 6;
const MAX_LISTED = 5;

export interface RunLocation {
  logDir: string;
  /** `last` means the newest run recorded in this directory. */
  cwd: string;
  /** When set, only runs recorded in this directory or below it exist (the MCP server: one project's runs). */
  within?: string;
}

/** A resolved run. Either file may be gone (pruned, or a log from before records existed). */
export interface ResolvedRun {
  runId: string;
  logPath: string;
  recordPath: string;
  hasLog: boolean;
  /** `null` when the record is missing or unreadable. */
  record: RunRecord | null;
}

/** Newest first: greatest `created_at`, ties broken by the greater run id. */
export function newestFirst(a: RunRecord, b: RunRecord): number {
  const byTime = Date.parse(b.created_at) - Date.parse(a.created_at);
  if (byTime !== 0) return byTime;
  return a.run_id < b.run_id ? 1 : a.run_id > b.run_id ? -1 : 0;
}

/** Every run id that has a log or a record in `logDir`. */
export function listRunIds(logDir: string): string[] {
  const ids = new Set<string>();
  for (const name of listLogDir(logDir)) {
    const match = /^(.+)\.(?:log|json)$/.exec(name);
    if (match?.[1] !== undefined) ids.add(match[1]);
  }
  return [...ids].sort();
}

/** `last`, a full run id, or a unique prefix of at least 6 characters; throws a `CliError` otherwise. */
export function resolveRunRef(ref: string, where: RunLocation): ResolvedRun {
  return locate(where.logDir, ref === "last" ? lastRunId(where) : matchRunId(ref, candidateIds(where)));
}

export function isWithin(dir: string, root: string): boolean {
  return dir === root || dir.startsWith(root.endsWith(path.sep) ? root : `${root}${path.sep}`);
}

/** The ids a reference may name; with `within`, only those whose record says they ran there. */
function candidateIds(where: RunLocation): string[] {
  const { within } = where;
  if (within === undefined) return listRunIds(where.logDir);
  return loadRunRecords(where.logDir)
    .filter((record) => isWithin(record.cwd, within))
    .map((record) => record.run_id)
    .sort();
}

function lastRunId(where: RunLocation): string {
  const [newest] = loadRunRecords(where.logDir)
    .filter((record) => record.cwd === where.cwd)
    .sort(newestFirst);
  if (newest === undefined) throw new NoInputError("no run recorded for this directory");
  return newest.run_id;
}

function matchRunId(ref: string, ids: readonly string[]): string {
  if (ref.length < MIN_PREFIX) {
    throw new UsageError(`run reference "${ref}" is too short (${MIN_PREFIX} characters minimum)`);
  }
  if (ids.includes(ref)) return ref;
  const matches = ids.filter((id) => id.startsWith(ref));
  const [only] = matches;
  if (only === undefined) throw new NoInputError(`no such run: ${ref}`);
  if (matches.length > 1) {
    throw new UsageError(`ambiguous run reference "${ref}": ${matches.slice(0, MAX_LISTED).join(", ")}`);
  }
  return only;
}

function locate(logDir: string, runId: string): ResolvedRun {
  const recordPath = recordPathFor(logDir, runId);
  const logPath = logPathFor(logDir, runId);
  let record: RunRecord | null = null;
  try {
    record = readRunRecord(recordPath);
  } catch {
    record = null;
  }
  return { runId, logPath, recordPath, hasLog: fs.existsSync(logPath), record };
}
