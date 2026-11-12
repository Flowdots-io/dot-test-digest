import fs from "node:fs";
import type { RunRecord } from "../runner/run-record.js";
import { NoInputError, UsageError } from "./errors.js";
import { resolveRunRef } from "./run-ref.js";
import type { SubcommandContext } from "./dispatch.js";

const SHOW_USAGE = "dot-test-digest show <run> [range|cluster_id] [--numbers] [--record]";
const CLUSTER_ID = /^c_[0-9a-f]{8}$/;
const RANGES = [/^L(\d+)-L(\d+)$/, /^(\d+)-(\d+)$/, /^L(\d+)$/];

interface ShowArgs {
  ref: string;
  selector: string | undefined;
  numbers: boolean;
  record: boolean;
}

function parseShowArgs(args: readonly string[]): ShowArgs {
  const positional: string[] = [];
  let numbers = false;
  let record = false;
  for (const arg of args) {
    if (arg === "--numbers") numbers = true;
    else if (arg === "--record") record = true;
    else if (arg.startsWith("-")) throw new UsageError(`unknown flag: ${arg}`);
    else positional.push(arg);
  }
  const [ref, selector, extra] = positional;
  if (ref === undefined) throw new UsageError(`show needs a run: ${SHOW_USAGE}`);
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}": ${SHOW_USAGE}`);
  if (record && (selector !== undefined || numbers)) {
    throw new UsageError("--record prints the whole record: it takes no range, cluster id or --numbers");
  }
  return { ref, selector, numbers, record };
}

/** The 1-based inclusive range a selector names, before clamping. */
function selectedRange(selector: string, record: RunRecord): [number, number] {
  if (CLUSTER_ID.test(selector)) {
    const cluster = record.clusters.find((candidate) => candidate.cluster_id === selector);
    if (cluster === undefined) throw new UsageError(`no cluster ${selector} in ${record.run_id}`);
    return rangeOf(cluster.raw_log_lines, selector);
  }
  return rangeOf(selector, selector);
}

function rangeOf(text: string, selector: string): [number, number] {
  for (const pattern of RANGES) {
    const match = pattern.exec(text);
    if (match === null) continue;
    const from = Number(match[1]);
    const to = match[2] === undefined ? from : Number(match[2]);
    if (from < 1 || from > to) throw new UsageError(`invalid range: ${selector}`);
    return [from, to];
  }
  throw new UsageError(`invalid selector "${selector}": use L<a>-L<b>, <a>-<b>, L<a> or a cluster id`);
}

/** The log's lines as stored, without the newline that ends each. */
function readLogLines(path: string): string[] {
  const lines = fs.readFileSync(path, "utf8").split("\n");
  if (lines.at(-1) === "") lines.pop();
  return lines;
}

export function runShow(args: readonly string[], context: SubcommandContext): number {
  const options = parseShowArgs(args);
  const run = resolveRunRef(options.ref, context);
  if (!run.hasLog) throw new NoInputError(`log of ${run.runId} was removed`);
  if (run.record === null) throw new NoInputError(`record of ${run.runId} is missing or unreadable`);

  if (options.record) {
    context.write(fs.readFileSync(run.recordPath, "utf8"));
    return 0;
  }

  const lines = readLogLines(run.logPath);
  let from = 1;
  let to = lines.length;
  if (options.selector !== undefined) {
    [from, to] = selectedRange(options.selector, run.record);
    if (from > lines.length) throw new UsageError(`the log has ${lines.length} lines`);
    to = Math.min(to, lines.length);
  }

  const shown = lines.slice(from - 1, to);
  context.write(
    shown.map((line, offset) => (options.numbers ? `${from + offset}\t${line}\n` : `${line}\n`)).join(""),
  );
  return 0;
}
