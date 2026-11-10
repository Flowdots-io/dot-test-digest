import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapturedLine } from "../runner/capture.js";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import type { ErrorKind } from "../types/schema.js";
import {
  classifyMessage,
  emptyCounts,
  type AdapterCounts,
  type AdapterResult,
} from "./common.js";
import { parseGeneric } from "./js-generic.js";

interface NodeEntry {
  name: string;
  file: string | null;
  line: string | undefined;
  message: string;
  expected?: string;
  actual?: string;
  stack: string[];
  crashedFile: boolean;
  subprocessError?: string;
  startLine: number;
  endLine: number;
}

const NODE_ERROR_LINE = /^([A-Za-z]*Error)(?: \[[^\]]+\])?: (.*\S)\s*$/;
const FILE_URL = /file:\/\/[^\s()]*/g;
const UNKNOWN_FAILURE = "Unknown test failure";

function leadingSpaces(text: string): number {
  return text.length - text.trimStart().length;
}

function nodePath(text: string): string {
  return text.replace(FILE_URL, (url) => {
    const suffix = /(?::\d+){0,2}$/.exec(url)?.[0] ?? "";
    try {
      return fileURLToPath(url.slice(0, url.length - suffix.length)) + suffix;
    } catch {
      return url;
    }
  });
}

function relativeToCwd(file: string): string {
  const relative = path.relative(process.cwd(), file).split(path.sep).join("/");
  return relative === "" || relative.startsWith("..") ? file : relative;
}

function cleanNodeMessage(parts: readonly string[]): string {
  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^([A-Za-z_$][\w.$]*) \[[A-Z][A-Z0-9_]*\]:/, "$1:")
    .trim();
}

function errorLine(text: string): string | undefined {
  const match = NODE_ERROR_LINE.exec(text);
  return match === null ? undefined : `${match[1] ?? ""}: ${match[2] ?? ""}`;
}

function firstErrorLine(block: readonly string[]): string | undefined {
  for (const text of block) {
    const error = errorLine(text);
    if (error !== undefined) return error;
  }
  return undefined;
}

const CRASH_TRAILER = /^Node\.js v\d/;
const CRASH_LOCATION = /^(?:file:\/\/|node:|\/|[A-Za-z]:[\\/])\S*:\d+$/;

function lastIndexWhere(lines: readonly string[], test: (text: string) => boolean, before = lines.length): number {
  let index = before - 1;
  while (index >= 0 && !test(lines[index] ?? "")) index -= 1;
  return index;
}

/**
 * The error of the crash block node printed for a crashed file: a location-only line, the source and
 * caret, the error, its stack, and the trailer `Node.js v<version>`. `lines` are the lines above the
 * file's own entry; only the last block takes part, so a setup log, another file's output or a stack
 * frame that names another file never stands in for the error.
 */
function crashBlockError(lines: readonly string[]): string | undefined {
  const trailer = lastIndexWhere(lines, (text) => CRASH_TRAILER.test(text));
  const location = trailer < 0 ? -1 : lastIndexWhere(lines, (text) => CRASH_LOCATION.test(text), trailer);
  return location < 0 ? undefined : firstErrorLine(lines.slice(location, trailer));
}

function nameOnlyEntry(name: string, line: number): NodeEntry {
  return {
    name,
    file: null,
    line: undefined,
    message: "",
    stack: [],
    crashedFile: false,
    startLine: line,
    endLine: line,
  };
}

const MODULE_LOADER_FRAME = "node:internal/modules/";

/**
 * A `SyntaxError` a test threw while it ran (`JSON.parse(undefined)`, `new Function("a b")`)
 * is behavioural; one raised while node parsed a module has loader frames in its stack.
 */
function isRuntimeSyntaxError(entry: NodeEntry): boolean {
  return (
    /^SyntaxError\b/.test(entry.message) && !entry.stack.some((frame) => frame.includes(MODULE_LOADER_FRAME))
  );
}

/** node could not read the test file at all, so no test ran: the runner's startup crash. */
const FILE_READ_FAILURE = /^Error: (?:EACCES|EPERM)\b/;

/** A read failure counts only when it names the test file itself, quoted: `open '/dir/a.test.js'`, not `'/dir/a.test.json'`. */
function isFileReadFailure(subprocessError: string, file: string | null): boolean {
  return FILE_READ_FAILURE.test(subprocessError) && file !== null && subprocessError.includes(`'${file}'`);
}

function errorKindOf(entry: NodeEntry): ErrorKind {
  if (entry.subprocessError !== undefined) {
    return isFileReadFailure(entry.subprocessError, entry.file)
      ? "SYNTAX_IMPORT_ERROR"
      : classifyMessage(entry.subprocessError);
  }
  if (entry.crashedFile) return "SYNTAX_IMPORT_ERROR";
  if (isRuntimeSyntaxError(entry)) return "RUNTIME_EXCEPTION";
  return classifyMessage(`${entry.message}\n${entry.stack.join("\n")}`);
}

function toRawFailure(entry: NodeEntry): RawFailure {
  const message = entry.subprocessError ?? entry.message;
  const diff =
    entry.expected !== undefined && entry.actual !== undefined
      ? { expected: entry.expected, received: entry.actual }
      : undefined;
  return {
    testName: entry.name === "" ? null : entry.name,
    testFile: entry.file === null ? null : relativeToCwd(entry.file),
    errorKind: errorKindOf(entry),
    message: message === "" ? UNKNOWN_FAILURE : message,
    frames: entry.stack,
    ...(diff !== undefined ? { diff } : {}),
    startLine: entry.startLine,
    endLine: entry.endLine,
  };
}

function disambiguateSameNames(entries: NodeEntry[]): void {
  const keyOf = (entry: NodeEntry): string => `${entry.file ?? ""}\u0000${entry.name}`;
  const seen = new Map<string, number>();
  for (const entry of entries) seen.set(keyOf(entry), (seen.get(keyOf(entry)) ?? 0) + 1);
  for (const entry of entries) {
    if (entry.name !== "" && entry.line !== undefined && (seen.get(keyOf(entry)) ?? 0) > 1) {
      entry.name = `${entry.name} @${entry.line}`;
    }
  }
}

/**
 * node does not count a suite whose hook or body threw in `fail`/`cancelled`,
 * so the printed count can sit below the failures reported: it never may.
 */
function finish(entries: NodeEntry[], foreign: RawFailure[], counts: AdapterCounts): AdapterResult {
  disambiguateSameNames(entries);
  const failures = [...entries.map(toRawFailure), ...foreign].sort((a, b) => a.startLine - b.startLine);
  const failed = Math.max(counts.failed, failures.length);
  return { adapter: "js-test", failures, counts: { ...counts, failed } };
}

/** node escapes a `#` inside a TAP test name, so an unescaped ` # TODO` / ` # SKIP` is a directive. */
const TAP_NOT_OK = /^(\s*)not ok\s+\d+\s*(?:-\s*)?(.*?)(\s+#\s*(?:TODO|SKIP)\b.*)?\s*$/;
const COUNT_KEYS = "tests|pass|fail|cancelled|skipped|todo";
const TAP_COUNT = new RegExp(`^#\\s+(${COUNT_KEYS})\\s+(\\d+)\\s*$`);
const YAML_KEY = /^([A-Za-z_][\w-]*):(?:\s+(.*?))?\s*$/;
const NODE_SUBTEST = /^\s*# Subtest:/;

interface TapBlock {
  fields: Map<string, string[]>;
  endIndex: number;
}

function unquote(
  value: string,
  quotes: string,
  unescape: (inner: string, quote: string) => string | undefined,
): string {
  const quote = value[0];
  if (quote !== undefined && quotes.includes(quote) && value.length >= 2 && value.endsWith(quote)) {
    return unescape(value.slice(1, -1), quote) ?? value;
  }
  return value;
}

function yamlScalar(value: string): string {
  return unquote(value.trim(), "'\"`", (inner, quote) => {
    if (quote === "'") return inner.replaceAll("''", "'");
    return quote === '"' ? inner.replace(/\\(["\\])/g, "$1") : inner;
  });
}

function readTapBlock(lines: readonly CapturedLine[], headerIndex: number): TapBlock | null {
  const open = lines[headerIndex + 1]?.text;
  if (open === undefined || open.trim() !== "---") return null;
  const base = leadingSpaces(open);
  const fields = new Map<string, string[]>();
  let key: string | null = null;
  let bucket: string[] = [];
  let scalarBlock = false;

  const seal = (): void => {
    if (key !== null) fields.set(key, bucket);
    key = null;
    bucket = [];
  };

  for (let index = headerIndex + 2; index < lines.length; index += 1) {
    const text = lines[index]?.text ?? "";
    if (text.trim() === "..." && leadingSpaces(text) === base) {
      seal();
      return { fields, endIndex: index };
    }
    const blank = text.trim() === "";
    if (key !== null && (blank || leadingSpaces(text) > base)) {
      if (scalarBlock || !blank) bucket.push(text.trim());
      continue;
    }
    const match = YAML_KEY.exec(text.trim());
    if (match === null || leadingSpaces(text) !== base) continue;
    seal();
    key = match[1] ?? null;
    const inline = match[2] ?? "";
    scalarBlock = /^\|[-+]?$/.test(inline);
    if (inline !== "" && !scalarBlock) bucket.push(yamlScalar(inline));
  }
  return null;
}

/** node's TAP relays a crashed file's stderr as `#` lines directly above that file's top-level `# Subtest:` line. */
function tapSubprocessError(lines: readonly CapturedLine[], headerIndex: number): string | undefined {
  let subtest = headerIndex - 1;
  while (subtest >= 0 && !/^# Subtest:/.test(lines[subtest]?.text ?? "")) subtest -= 1;
  const comments: string[] = [];
  for (let index = subtest - 1; index >= 0; index -= 1) {
    const text = lines[index]?.text ?? "";
    if (!text.startsWith("#")) break;
    comments.unshift(text.replace(/^#\s+/, ""));
  }
  return crashBlockError(comments);
}

/**
 * node prints the class of an error in `name:` except for a plain `Error`, which the spec reporter shows as
 * `Error: <text>`. Only an error a test or hook threw has a `stack:` key: a thrown string or number and a
 * failed `t.plan` have none and keep their text.
 */
const THROWN_FAILURES: ReadonlySet<string> = new Set(["testCodeFailure", "hookFailed"]);

function tapField(block: TapBlock, key: string): string[] {
  return block.fields.get(key) ?? [];
}

function readTapMessage(block: TapBlock, crashedFile: boolean): string {
  const field = (key: string): string[] => tapField(block, key);
  const text = cleanNodeMessage(field("error").filter((line) => line !== ""));
  const errorName = field("name").join(" ").trim();
  if (errorName !== "") return text.startsWith(errorName) ? text : `${errorName}: ${text}`;
  const isPlainError =
    block.fields.has("stack") &&
    !block.fields.has("name") &&
    !crashedFile &&
    THROWN_FAILURES.has(field("failureType")[0] ?? "");
  if (!isPlainError) return text;
  return text === "" ? "Error" : `Error: ${text}`;
}

function readTapEntry(
  lines: readonly CapturedLine[],
  index: number,
  name: string,
  block: TapBlock,
): NodeEntry {
  const startLine = lines[index]?.line ?? 0;
  const field = (key: string): string[] => tapField(block, key);
  const crashedFile = field("error")[0] === "test failed" && block.fields.has("exitCode");
  const message = readTapMessage(block, crashedFile);

  const place = /^(.*?):(\d+)(?::\d+)?$/.exec(field("location")[0] ?? "");
  const file = place?.[1] ?? null;
  const expected = field("expected");
  const actual = field("actual");
  const subprocessError = crashedFile ? tapSubprocessError(lines, index) : undefined;
  return {
    name,
    file,
    line: place?.[2],
    message,
    ...(expected.length > 0 && actual.length > 0
      ? { expected: expected.join(", "), actual: actual.join(", ") }
      : {}),
    stack: field("stack").map(nodePath),
    crashedFile,
    ...(subprocessError !== undefined ? { subprocessError } : {}),
    startLine,
    endLine: lines[block.endIndex]?.line ?? startLine,
  };
}

/** node counts a timed-out test as `cancelled`, not `fail`. One stream can hold several node runs; each prints its own summary, so the counts are summed. */
function nodeCounts(lines: readonly CapturedLine[], pattern: RegExp): AdapterCounts {
  const seen = new Map<string, number>();
  for (const line of lines) {
    const match = pattern.exec(line.text);
    if (match === null) continue;
    const key = match[1] ?? "";
    seen.set(key, (seen.get(key) ?? 0) + Number(match[2]));
  }
  const counts = emptyCounts();
  counts.passed = seen.get("pass") ?? 0;
  counts.failed = (seen.get("fail") ?? 0) + (seen.get("cancelled") ?? 0);
  counts.skipped = (seen.get("skipped") ?? 0) + (seen.get("todo") ?? 0);
  return counts;
}

export function isNodeTapStream(lines: readonly CapturedLine[]): boolean {
  return lines.some((line) => NODE_SUBTEST.test(line.text));
}

export function parseNodeTap(lines: readonly CapturedLine[]): AdapterResult {
  const entries: NodeEntry[] = [];
  const foreign: RawFailure[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const notOk = TAP_NOT_OK.exec(lines[index]?.text ?? "");
    if (notOk === null) continue;
    // node writes `#` as `\#` and a backslash as `\\` in a test name.
    const name = (notOk[2] ?? "").replace(/\\([\\#])/g, "$1");
    const isDirective = notOk[3] !== undefined;
    const block = readTapBlock(lines, index);
    if (!isDirective) {
      const failureType = block?.fields.get("failureType")?.[0];
      if (block === null) {
        entries.push(nameOnlyEntry(name, lines[index]?.line ?? 0));
      } else if (failureType === undefined) {
        foreign.push(...parseGeneric(lines.slice(index, block.endIndex + 1)).failures);
      } else if (failureType !== "subtestsFailed") {
        entries.push(readTapEntry(lines, index, name, block));
      }
    }
    if (block !== null) index = block.endIndex;
  }
  return finish(entries, foreign, nodeCounts(lines, TAP_COUNT));
}

export const NODE_SPEC_SUMMARY = new RegExp(`^ℹ (${COUNT_KEYS}) (\\d+)\\s*$`);
const SPEC_FAILING_HEADER = /^✖ failing tests:\s*$/;
const SPEC_TEST_AT = /^test at (.+?):(\d+):\d+\s*$/;
/** node's spec rows end in `(<n>ms)`, then ` # TODO`, ` # SKIP`, or ` # <reason>` for a skip that gave one. */
const SPEC_ROW_TAIL = String.raw`(?: \(\d+(?:\.\d+)?ms\)( #(?: .*)?)?)?\s*$`;
const SPEC_NAME_ROW = new RegExp(`^✖ (.*?)${SPEC_ROW_TAIL}`);
const SPEC_TREE_ROW = new RegExp(`^(\\s*)([✖▶]) (.*?)${SPEC_ROW_TAIL}`);
const SPEC_ENTRY_INDENT = 2;
const SPEC_ROW_START = /^\s*[✔✖▶﹣ℹ]/;

export function isSpecStream(lines: readonly CapturedLine[]): boolean {
  const keys = new Set<string>();
  for (const line of lines) {
    const match = NODE_SPEC_SUMMARY.exec(line.text);
    if (match !== null && ["tests", "pass", "fail"].includes(match[1] ?? "")) keys.add(match[1] ?? "");
  }
  return keys.size >= 2;
}

function inspectedString(value: string): string {
  return unquote(value, "'\"`", (inner, quote) => (inner.includes(quote) ? undefined : inner));
}

function readSpecEntry(lines: readonly CapturedLine[], start: number, end: number): NodeEntry | null {
  const at = SPEC_TEST_AT.exec(lines[start]?.text ?? "");
  const nameRow = SPEC_NAME_ROW.exec(lines[start + 1]?.text ?? "");
  if (at === null || nameRow === null || nameRow[2] !== undefined) return null;

  const messageLines: string[] = [];
  const stack: string[] = [];
  const properties = new Map<string, string>();
  let inFrames = false;
  let propertyIndent: number | null = null;
  let last = start + 1;
  for (let index = start + 2; index < end; index += 1) {
    const raw = lines[index]?.text ?? "";
    const text = raw.trim();
    if (text === "") continue;
    if (leadingSpaces(raw) < SPEC_ENTRY_INDENT) break;
    last = index;
    const isFrame = /^at /.test(text);
    if (isFrame) inFrames = true;
    if (!inFrames) {
      messageLines.push(text);
    } else if (isFrame) {
      stack.push(nodePath(text.slice(3).replace(/ \{$/, "")));
    } else if (text !== "}") {
      propertyIndent ??= leadingSpaces(raw);
      const property = /^(\w+): (.*?),?$/.exec(text);
      if (property !== null && leadingSpaces(raw) === propertyIndent) {
        properties.set(property[1] ?? "", property[2] ?? "");
      }
    }
  }

  const name = nameRow[1] ?? "";
  const file = path.resolve(at[1] ?? "");
  const message = inspectedString(cleanNodeMessage(messageLines));
  const expected = properties.get("expected");
  const actual = properties.get("actual");
  return {
    name,
    file,
    line: at[2],
    message,
    ...(expected !== undefined && actual !== undefined
      ? { expected: inspectedString(expected), actual: inspectedString(actual) }
      : {}),
    stack,
    crashedFile: message === "test failed" && path.resolve(name) === file,
    startLine: lines[start]?.line ?? 0,
    endLine: lines[last]?.line ?? 0,
  };
}

/** node's spec reporter opens a suite with a `▶` row and closes it with a `✖` row of the same name and indent. */
function readSpecLeafRows(lines: readonly CapturedLine[]): NodeEntry[] {
  const opened = new Set<string>();
  const entries: NodeEntry[] = [];
  for (const line of lines) {
    if (NODE_SPEC_SUMMARY.test(line.text)) break;
    const row = SPEC_TREE_ROW.exec(line.text);
    if (row === null) continue;
    const key = `${row[1] ?? ""}\u0000${row[3] ?? ""}`;
    if (row[2] === "▶") {
      opened.add(key);
      continue;
    }
    if (opened.has(key) || row[4] !== undefined) continue;
    entries.push(nameOnlyEntry(row[3] ?? "", line.line));
  }
  return entries;
}

/**
 * A `✖ failing tests:` section is its header followed by blank lines, indented lines, `test at` lines and
 * the unindented name row under each. The first other line is the next thing node or a wrapper printed
 * (a later run opens with its own output, so a stream can hold several sections).
 */
function failingSectionMask(lines: readonly CapturedLine[]): boolean[] {
  let open = false;
  return lines.map((line, index) => {
    const previous = lines[index - 1]?.text ?? "";
    const continues =
      line.text.trim() === "" ||
      /^\s/.test(line.text) ||
      SPEC_TEST_AT.test(line.text) ||
      (SPEC_TEST_AT.test(previous) && SPEC_NAME_ROW.test(line.text));
    open = SPEC_FAILING_HEADER.test(line.text) || (open && continues);
    return open;
  });
}

/** The lines node printed between the previous tree row and the `nth` own `✖ <name>` row outside the failing-tests sections. */
function linesAboveFileRow(
  lines: readonly CapturedLine[],
  inSection: readonly boolean[],
  name: string,
  nth: number,
): string[] {
  const rows = lines.flatMap((line, index) =>
    !inSection[index] && SPEC_NAME_ROW.exec(line.text)?.[1] === name ? [index] : [],
  );
  const row = rows[nth];
  if (row === undefined) return [];
  let previous = row - 1;
  while (previous >= 0 && !SPEC_ROW_START.test(lines[previous]?.text ?? "")) previous -= 1;
  return lines.slice(previous + 1, row).map((line) => line.text);
}

/** node's spec entry for a crashed file says only `'test failed'`; its stderr is printed above that file's own `✖` row. The n-th crashed entry of a name takes the n-th row of that name (one stream can hold several runs). */
function adoptSubprocessErrors(lines: readonly CapturedLine[], entries: NodeEntry[]): void {
  const crashed = entries.filter((entry) => entry.crashedFile);
  if (crashed.length === 0) return;
  const inSection = failingSectionMask(lines);
  const taken = new Map<string, number>();
  for (const entry of crashed) {
    const nth = taken.get(entry.name) ?? 0;
    taken.set(entry.name, nth + 1);
    const error = crashBlockError(linesAboveFileRow(lines, inSection, entry.name, nth));
    if (error !== undefined) entry.subprocessError = error;
  }
}

export function parseNodeSpec(lines: readonly CapturedLine[]): AdapterResult {
  const counts = nodeCounts(lines, NODE_SPEC_SUMMARY);
  const section = lines.findIndex((line) => SPEC_FAILING_HEADER.test(line.text));
  if (section < 0) return finish(readSpecLeafRows(lines), [], counts);

  const starts: number[] = [];
  for (let index = section + 1; index < lines.length; index += 1) {
    if (SPEC_TEST_AT.test(lines[index]?.text ?? "")) starts.push(index);
  }
  const entries: NodeEntry[] = [];
  starts.forEach((start, position) => {
    const entry = readSpecEntry(lines, start, starts[position + 1] ?? lines.length);
    if (entry !== null) entries.push(entry);
  });
  adoptSubprocessErrors(lines, entries);
  return finish(entries, [], counts);
}
