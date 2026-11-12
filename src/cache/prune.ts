import fs from "node:fs";
import path from "node:path";

const HOUR_MS = 60 * 60 * 1000;
const DAY_MS = 24 * HOUR_MS;

/** Only these names are ever deleted; anything else in the cache is the user's. */
const RUN_FILE = /^(run_[0-9a-z]+)\.(log|json)$/;
const STATE_FILE = /^state-(.+)\.json$/;

/** The automatic prune's cap, so one run never spends long deleting a neglected cache. */
export const AUTO_PRUNE_MAX_FILES = 200;

export interface PruneOptions {
  /** The newest runs kept whatever their age (the current run counts among them). */
  keepRuns: number;
  /** Runs beyond `keepRuns` older than this are deleted. */
  maxAgeDays: number;
  /** State files not modified for longer than this are deleted. */
  stateMaxAgeDays: number;
  dryRun?: boolean;
  currentRunId?: string;
  currentScopeId?: string;
  /** At most this many files are deleted, oldest run first; unlimited by default. */
  maxFiles?: number;
}

export interface PruneResult {
  removedRuns: number;
  removedStates: number;
  keptRuns: number;
}

interface RunFiles {
  id: string;
  files: string[];
  /** The record's `created_at`, else the log's mtime. */
  createdMs: number;
  newestMtimeMs: number;
  hasLog: boolean;
}

/** Regular files only: a symlink, even one named like a run, is never followed or deleted. */
function regularFiles(dir: string): Map<string, fs.Stats> {
  const files = new Map<string, fs.Stats>();
  let names: string[];
  try {
    if (!fs.lstatSync(dir).isDirectory()) return files;
    names = fs.readdirSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return files;
    throw error;
  }
  for (const name of names) {
    try {
      const stats = fs.lstatSync(path.join(dir, name));
      if (stats.isFile()) files.set(name, stats);
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
    }
  }
  return files;
}

function recordCreatedMs(file: string): number | undefined {
  try {
    const record = JSON.parse(fs.readFileSync(file, "utf8")) as { created_at?: unknown };
    const created = typeof record.created_at === "string" ? Date.parse(record.created_at) : NaN;
    return Number.isNaN(created) ? undefined : created;
  } catch {
    return undefined;
  }
}

function collectRuns(logDir: string): RunFiles[] {
  const byId = new Map<string, { log?: fs.Stats; json?: fs.Stats }>();
  for (const [name, stats] of regularFiles(logDir)) {
    const match = RUN_FILE.exec(name);
    if (match === null) continue;
    const [, id = "", ext] = match;
    const entry = byId.get(id) ?? {};
    entry[ext === "log" ? "log" : "json"] = stats;
    byId.set(id, entry);
  }
  return [...byId].map(([id, { log, json }]) => {
    const files = [log && `${id}.log`, json && `${id}.json`].filter((name): name is string => name !== undefined);
    const fromRecord = json === undefined ? undefined : recordCreatedMs(path.join(logDir, `${id}.json`));
    const mtimes = [log, json].filter((stats): stats is fs.Stats => stats !== undefined).map((stats) => stats.mtimeMs);
    return {
      id,
      files: files.map((name) => path.join(logDir, name)),
      createdMs: fromRecord ?? (log ?? json)?.mtimeMs ?? 0,
      newestMtimeMs: Math.max(...mtimes),
      hasLog: log !== undefined,
    };
  });
}

function realCacheDir(dir: string): string | undefined {
  try {
    return fs.realpathSync(dir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/** Deletes a file another process may already have removed. */
function unlink(file: string): void {
  try {
    fs.unlinkSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code !== "ENOENT") throw error;
  }
}

/**
 * Keeps the newest `keepRuns` runs, deletes the older-than-`maxAgeDays` rest, records without a log, and state
 * files untouched for `stateMaxAgeDays`. Never the current run or scope, never a file modified in the last hour,
 * only files named like runs (in `<home>/logs`) or state files (in `<home>`). Creates nothing.
 */
export function pruneCache(cacheDir: string, options: PruneOptions, now: number = Date.now()): PruneResult {
  // A symlinked cache directory is followed once, here; nothing inside it is.
  const home = realCacheDir(cacheDir);
  if (home === undefined) return { removedRuns: 0, removedStates: 0, keptRuns: 0 };
  const recent = (mtimeMs: number): boolean => now - mtimeMs < HOUR_MS;
  const runs = collectRuns(path.join(home, "logs")).sort((a, b) => b.createdMs - a.createdMs || b.id.localeCompare(a.id));

  const doomedRuns: RunFiles[] = [];
  let rank = 0;
  for (const run of runs) {
    const protectedRun = recent(run.newestMtimeMs);
    if (!run.hasLog) {
      if (!protectedRun) doomedRuns.push(run);
      continue;
    }
    rank += 1;
    const expired = rank > options.keepRuns && now - run.createdMs > options.maxAgeDays * DAY_MS;
    if (expired && !protectedRun) doomedRuns.push(run);
  }
  doomedRuns.sort((a, b) => a.createdMs - b.createdMs || a.id.localeCompare(b.id));

  const doomedStates: string[] = [];
  for (const [name, stats] of regularFiles(home)) {
    const match = STATE_FILE.exec(name);
    if (match === null || recent(stats.mtimeMs)) continue;
    if (now - stats.mtimeMs > options.stateMaxAgeDays * DAY_MS) doomedStates.push(path.join(home, name));
  }

  let budget = options.maxFiles ?? Number.POSITIVE_INFINITY;
  const removedRuns = doomedRuns.filter((run) => {
    if (run.files.length > budget) return false;
    budget -= run.files.length;
    return true;
  });
  const removedStates = doomedStates.filter(() => budget-- > 0);

  if (options.dryRun !== true) {
    for (const run of removedRuns) run.files.forEach(unlink);
    removedStates.forEach(unlink);
  }
  const removedLogged = removedRuns.filter((run) => run.hasLog).length;
  return {
    removedRuns: removedRuns.length,
    removedStates: removedStates.length,
    keptRuns: runs.filter((run) => run.hasLog).length - removedLogged,
  };
}
