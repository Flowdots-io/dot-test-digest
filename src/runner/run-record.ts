import fs from "node:fs";
import path from "node:path";
import { randomBytes } from "node:crypto";
import { z } from "zod";
import {
  DigestStatusSchema,
  ErrorKindSchema,
  ExecutionGearSchema,
  OutputFormatSchema,
  TddPhaseSchema,
  type FailureCluster,
} from "../types/schema.js";

export const RUN_RECORD_SCHEMA = 1;

const count = z.number().int().min(0);

export const RecordClusterSchema = z.object({
  cluster_id: z.string(),
  error_kind: ErrorKindSchema,
  affected_count: z.number().int().positive(),
  raw_log_lines: z.string().regex(/^L\d+-L\d+$/),
});
export type RecordCluster = z.infer<typeof RecordClusterSchema>;

/** `logs/<run>.json`: what a run was, beside `logs/<run>.log`, which holds its raw lines only. */
export const RunRecordSchema = z.object({
  schema: z.literal(RUN_RECORD_SCHEMA),
  run_id: z.string().min(1),
  version: z.string(),
  created_at: z.string().datetime(),
  source: z.enum(["run", "digest"]),
  /** The file a `digest` read, `"-"` for stdin. */
  input: z.string().optional(),
  cwd: z.string(),
  command: z.array(z.string()),
  exit_code: z.number().int(),
  child_exit_code: z.number().int(),
  signal: z.string().nullable(),
  duration_ms: count,
  phase: TddPhaseSchema,
  scope_id: z.string(),
  status: DigestStatusSchema,
  execution_gear: ExecutionGearSchema,
  format: OutputFormatSchema,
  options: z.object({
    max_clusters: z.number().int(),
    context_lines: z.number().int(),
    no_jev: z.boolean(),
    retry_flakes: z.boolean(),
    allow_no_tests: z.boolean(),
  }),
  summary: z.object({
    passed: count,
    failed: count,
    skipped: count,
    warnings: count,
    total_clusters: count,
  }),
  raw_lines: count,
  raw_bytes: count,
  digest_bytes: count,
  clusters: z.array(RecordClusterSchema),
});
export type RunRecord = z.infer<typeof RunRecordSchema>;

export function recordPathFor(logDir: string, runId: string): string {
  return path.join(logDir, `${runId}.json`);
}

export function logPathFor(logDir: string, runId: string): string {
  return path.join(logDir, `${runId}.log`);
}

export function recordClusters(clusters: readonly FailureCluster[]): RecordCluster[] {
  return clusters.map(({ cluster_id, error_kind, affected_count, raw_log_lines }) => ({
    cluster_id,
    error_kind,
    affected_count,
    raw_log_lines,
  }));
}

/** Atomic: a reader sees no record or the whole record, never a partial one. */
export function writeRunRecord(file: string, record: RunRecord): void {
  const temp = `${file}.${process.pid}.${randomBytes(4).toString("hex")}.tmp`;
  try {
    fs.writeFileSync(temp, `${JSON.stringify(record, null, 2)}\n`);
    fs.renameSync(temp, file);
  } catch (error) {
    fs.rmSync(temp, { force: true });
    throw error;
  }
}

/** Throws when the file is unreadable or is not a record of this schema. */
export function readRunRecord(file: string): RunRecord {
  return RunRecordSchema.parse(JSON.parse(fs.readFileSync(file, "utf8")));
}

/** Every valid record in `logDir`; unreadable or foreign `.json` files are skipped. */
export function loadRunRecords(logDir: string): RunRecord[] {
  const records: RunRecord[] = [];
  for (const name of listLogDir(logDir)) {
    if (!name.endsWith(".json")) continue;
    try {
      records.push(readRunRecord(path.join(logDir, name)));
    } catch {
      // A record being replaced, or a file this version does not understand.
    }
  }
  return records;
}

export function listLogDir(logDir: string): string[] {
  try {
    return fs.readdirSync(logDir);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw error;
  }
}
