import path from "node:path";
import { fileURLToPath, pathToFileURL } from "node:url";
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

function mentionsFile(text: string, file: string): boolean {
  return file !== "" && (text.includes(file) || text.includes(pathToFileURL(file).href));
}

function firstErrorLine(block: readonly string[]): string | undefined {
  for (const text of block) {
    const error = errorLine(text);
    if (error !== undefined) return error;
  }
  return undefined;
}

function lastErrorLine(block: readonly string[]): string | undefined {
  for (let index = block.length - 1; index >= 0; index -= 1) {
    const error = errorLine(block[index] ?? "");
    if (error !== undefined) return error;
  }
  return undefined;
}

/**
 * The error a crashed file printed: the first error line at or after the last line naming the file,
 * so a log line printed earlier does not stand in for it. A frame naming the file can come after
 * its error (`ReferenceError ... at file:///x.test.js:2:1`), so with none at or after the mention the
 * last error line before it is the file's; with no mention at all, the first error line.
 */
function fileError(lines: readonly string[], file: string): string | undefined {
  let mention = lines.length - 1;
  while (mention >= 0 && !mentionsFile(lines[mention] ?? "", file)) mention -= 1;
  if (mention < 0) return firstErrorLine(lines);
  return firstErrorLine(lines.slice(mention)) ?? lastErrorLine(lines.slice(0, mention));
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

/** A read failure counts only when it names the crashed file itself: another file read at load is the test's own fault. */
function isFileReadFailure(entry: NodeEntry, subprocessError: string): boolean {
  return FILE_READ_FAILURE.test(subprocessError) && mentionsFile(subprocessError, entry.file ?? "");
}

function errorKindOf(entry: NodeEntry): ErrorKind {
  if (entry.subprocessError !== undefined) {
    return isFileReadFailure(entry, entry.subprocessError)
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

/** node escapes a `#` inside a TAP test name as `\#` and a backslash as `\\`, so an unescaped ` # TODO` / ` # SKIP` is a directive. */
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
function tapSubprocessError(
  lines: readonly CapturedLine[],
  headerIndex: number,
  file: string,
): string | undefined {
  let subtest = headerIndex - 1;
  while (subtest >= 0 && !/^# Subtest:/.test(lines[subtest]?.text ?? "")) subtest -= 1;
  const comments: string[] = [];
  for (let index = subtest - 1; index >= 0; index -= 1) {
    const text = lines[index]?.text ?? "";
    if (!text.startsWith("#")) break;
    comments.unshift(text.replace(/^#\s+/, ""));
  }
  return fileError(comments, file);
}

/** node prints the class of an error in `name:` except for a plain `Error`, which the spec reporter shows as `Error: <text>`. */
const THROWN_FAILURES: ReadonlySet<string> = new Set(["testCodeFailure", "hookFailed"]);

function readTapEntry(
  lines: readonly CapturedLine[],
  index: number,
  name: string,
  block: TapBlock,
): NodeEntry {
  const startLine = lines[index]?.line ?? 0;
  const field = (key: string): string[] => block.fields.get(key) ?? [];
  const crashedFile = field("error")[0] === "test failed" && block.fields.has("exitCode");
  const errorName = field("name").join(" ").trim();
  let message = cleanNodeMessage(field("error").filter((text) => text !== ""));
  if (errorName !== "" && !message.startsWith(errorName)) message = `${errorName}: ${message}`;
  const isThrownError = block.fields.has("stack") && !block.fields.has("name") && !crashedFile;
  if (isThrownError && THROWN_FAILURES.has(field("failureType")[0] ?? "")) {
    message = message === "" ? "Error" : `Error: ${message}`;
  }

  const place = /^(.*?):(\d+)(?::\d+)?$/.exec(field("location")[0] ?? "");
  const expected = field("expected");
  const actual = field("actual");
  const subprocessError = crashedFile ? tapSubprocessError(lines, index, place?.[1] ?? "") : undefined;
  return {
    name,
    file: place?.[1] ?? null,
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

function textBlocks(texts: readonly string[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const text of texts) {
    if (text.trim() === "" || SPEC_ROW_START.test(text)) {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(text);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
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

/** The lines node printed between the previous tree row and the file's own `✖ <file>` row. */
function linesAboveFileRow(lines: readonly CapturedLine[], inSection: readonly boolean[], name: string): string[] {
  const row = lines.findIndex((line, index) => !inSection[index] && SPEC_NAME_ROW.exec(line.text)?.[1] === name);
  if (row < 0) return [];
  let previous = row - 1;
  while (previous >= 0 && !SPEC_ROW_START.test(lines[previous]?.text ?? "")) previous -= 1;
  return lines.slice(previous + 1, row).map((line) => line.text);
}

/** The blocks of the run that lists `entry`: the lines outside failing-tests sections from the end of the previous section (or the stream start) up to the entry's section. */
function ownRunBlocks(lines: readonly CapturedLine[], inSection: readonly boolean[], entry: NodeEntry): string[][] {
  let sectionStart = lines.findIndex((line) => line.line === entry.startLine);
  if (sectionStart < 0) return [];
  while (sectionStart > 0 && inSection[sectionStart - 1] === true) sectionStart -= 1;
  let runStart = sectionStart;
  while (runStart > 0 && inSection[runStart - 1] !== true) runStart -= 1;
  return textBlocks(lines.slice(runStart, sectionStart).map((line) => line.text));
}

/** node's spec entry for a crashed file says only `'test failed'`; its stderr is printed above that file's own `✖` row. */
function adoptSubprocessErrors(lines: readonly CapturedLine[], entries: NodeEntry[]): void {
  const crashed = entries.filter((entry) => entry.crashedFile);
  if (crashed.length === 0) return;
  const inSection = failingSectionMask(lines);
  for (const entry of crashed) {
    const absolute = entry.file ?? "";
    const blocks = ownRunBlocks(lines, inSection, entry);
    const mentions = (block: readonly string[]): boolean => block.some((text) => mentionsFile(text, absolute));
    const error =
      fileError(linesAboveFileRow(lines, inSection, entry.name), absolute) ??
      firstErrorLine(blocks.find((block) => mentions(block) && firstErrorLine(block) !== undefined) ?? []) ??
      (crashed.length === 1 ? firstErrorLine(blocks.flat()) : undefined);
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
