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

/**
 * The two reporters `node --test` prints (SPEC-002 §4.2.3): TAP, whose failures
 * carry a YAML diagnostic block, and the spec tree with its `✖ failing tests:`
 * section. Each reader only fills a `NodeEntry`; `toRawFailure` is the one place
 * that turns an entry into a failure, so both reporters agree on every field.
 */
interface NodeEntry {
  name: string;
  /** Absolute path of the test file, when the stream revealed it. */
  file: string | null;
  /** Line of the test inside its file, used to tell same-named tests apart. */
  line: string | undefined;
  message: string;
  expected?: string;
  actual?: string;
  stack: string[];
  /** A whole test file that crashed rather than one test inside it. */
  fileLevel: boolean;
  /** The error the crashed file's own subprocess printed. */
  subprocessError?: string;
  /** Overrides the kind classified from the message, e.g. a crashed file that printed no error. */
  errorKind?: ErrorKind;
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

/** Joins message lines with one space, collapses whitespace and drops a `[CODE]` tag after the error name. */
function cleanNodeMessage(parts: readonly string[]): string {
  return parts
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^([A-Za-z_$][\w.$]*) \[[A-Z][A-Z0-9_]*\]:/, "$1:")
    .trim();
}

/** `Name: text` of an error line, or undefined when the text is not one. */
function errorLine(text: string): string | undefined {
  const match = NODE_ERROR_LINE.exec(text);
  return match === null ? undefined : `${match[1] ?? ""}: ${match[2] ?? ""}`;
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
    errorKind:
      entry.errorKind ?? classifyMessage(entry.subprocessError ?? `${entry.message}\n${entry.stack.join("\n")}`),
    message: message === "" ? UNKNOWN_FAILURE : message,
    frames: entry.stack,
    ...(diff !== undefined ? { diff } : {}),
    startLine: entry.startLine,
    endLine: entry.endLine,
  };
}

/** Names shared by two or more failures of one file get ` @<line>`. */
function disambiguateSameNames(entries: readonly NodeEntry[]): void {
  const keyOf = (entry: NodeEntry): string => `${entry.file ?? ""}\u0000${entry.name}`;
  const seen = new Map<string, number>();
  for (const entry of entries) seen.set(keyOf(entry), (seen.get(keyOf(entry)) ?? 0) + 1);
  for (const entry of entries) {
    if (entry.name !== "" && entry.line !== undefined && (seen.get(keyOf(entry)) ?? 0) > 1) {
      entry.name = `${entry.name} @${entry.line}`;
    }
  }
}

function finish(entries: readonly NodeEntry[], counts: AdapterCounts): AdapterResult {
  disambiguateSameNames(entries);
  return { adapter: "js-test", failures: entries.map(toRawFailure), counts };
}

/* ------------------------------ TAP ------------------------------ */

const TAP_NOT_OK = /^(\s*)not ok\s+\d+\s*(?:-\s*)?(.*?)\s*$/;
const TAP_COUNT = /^#\s+(tests|pass|fail|cancelled|skipped|todo)\s+(\d+)\s*$/;
const YAML_KEY = /^([A-Za-z_][\w-]*):(?:\s+(.*?))?\s*$/;
const NODE_SUBTEST = /^\s*# Subtest:/;

interface TapBlock {
  fields: Map<string, string[]>;
  /** Index (in the lines array) of the closing `...`. */
  endIndex: number;
}

/** A YAML scalar loses one pair of quotes and its escapes; anything else is trimmed. */
function yamlScalar(value: string): string {
  const trimmed = value.trim();
  const quote = trimmed[0];
  if ((quote === "'" || quote === '"') && trimmed.length >= 2 && trimmed.endsWith(quote)) {
    const inner = trimmed.slice(1, -1);
    return quote === "'" ? inner.replaceAll("''", "'") : inner.replace(/\\(["\\])/g, "$1");
  }
  return trimmed;
}

/**
 * Reads the YAML diagnostic block after a `not ok` line: `---` opens it, the
 * `...` at the same indent closes it. Each top-level key maps to its value
 * lines: the unquoted scalar, or the trimmed lines of a `|-` block scalar or of
 * an indented mapping. Returns null when the block is missing or unterminated.
 */
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

/**
 * The error line a crashed test file's subprocess printed: the first match in
 * the run of `#` comment lines directly above that file's own top-level
 * `# Subtest:` line, so a file never borrows another file's error.
 */
function tapSubprocessError(lines: readonly CapturedLine[], headerIndex: number): string | undefined {
  let subtest = headerIndex - 1;
  while (subtest >= 0 && !/^# Subtest:/.test(lines[subtest]?.text ?? "")) subtest -= 1;
  const comments: string[] = [];
  for (let index = subtest - 1; index >= 0; index -= 1) {
    const text = lines[index]?.text ?? "";
    if (!text.startsWith("#")) break;
    comments.unshift(text.replace(/^#\s+/, ""));
  }
  for (const comment of comments) {
    const error = errorLine(comment);
    if (error !== undefined) return error;
  }
  return undefined;
}

/**
 * The entry of the `not ok` line at `index`, and the index of the last line it
 * consumed. A suite whose only fault is its failing subtests is a roll-up, not
 * a failure (entry null). A `not ok` with no readable diagnostic block (a
 * stream cut short) is kept by name alone.
 */
function readTapEntry(
  lines: readonly CapturedLine[],
  index: number,
  name: string,
): { entry: NodeEntry | null; next: number } {
  const startLine = lines[index]?.line ?? 0;
  const block = readTapBlock(lines, index);
  const failureType = block?.fields.get("failureType")?.[0];
  if (block === null || failureType === undefined) {
    const entry: NodeEntry = {
      name,
      file: null,
      line: undefined,
      message: "",
      stack: [],
      fileLevel: false,
      startLine,
      endLine: startLine,
    };
    return { entry, next: index };
  }
  if (failureType === "subtestsFailed") return { entry: null, next: block.endIndex };

  const field = (key: string): string[] => block.fields.get(key) ?? [];
  const errorName = field("name").join(" ").trim();
  let message = cleanNodeMessage(field("error").filter((text) => text !== ""));
  if (errorName !== "" && !message.startsWith(errorName)) message = `${errorName}: ${message}`;

  const place = /^(.*?):(\d+)(?::\d+)?$/.exec(field("location")[0] ?? "");
  const expected = field("expected");
  const actual = field("actual");
  const fileLevel = field("error")[0] === "test failed" && block.fields.has("exitCode");
  const subprocessError = fileLevel ? tapSubprocessError(lines, index) : undefined;
  const entry: NodeEntry = {
    name,
    file: place?.[1] ?? null,
    line: place?.[2],
    message,
    ...(expected.length > 0 && actual.length > 0
      ? { expected: expected.join(", "), actual: actual.join(", ") }
      : {}),
    stack: field("stack").map(nodePath),
    fileLevel,
    ...(subprocessError !== undefined ? { subprocessError } : {}),
    startLine,
    endLine: lines[block.endIndex]?.line ?? startLine,
  };
  return { entry, next: block.endIndex };
}

function tapCounts(lines: readonly CapturedLine[], failureCount: number): AdapterCounts {
  const seen = new Map<string, number>();
  for (const line of lines) {
    const match = TAP_COUNT.exec(line.text);
    if (match === null) continue;
    const key = match[1] ?? "";
    const value = Number(match[2]);
    seen.set(key, key === "pass" ? Math.max(seen.get(key) ?? 0, value) : value);
  }
  const counts = emptyCounts();
  const failed = (seen.get("fail") ?? 0) + (seen.get("cancelled") ?? 0);
  counts.passed = seen.get("pass") ?? 0;
  counts.failed = failed === 0 ? failureCount : failed;
  counts.skipped = (seen.get("skipped") ?? 0) + (seen.get("todo") ?? 0);
  return counts;
}

/** node's TAP always opens each test file with a `# Subtest:` comment. */
export function isNodeTapStream(lines: readonly CapturedLine[]): boolean {
  return lines.some((line) => NODE_SUBTEST.test(line.text));
}

export function parseNodeTap(lines: readonly CapturedLine[]): AdapterResult {
  const entries: NodeEntry[] = [];
  for (let index = 0; index < lines.length; index += 1) {
    const notOk = TAP_NOT_OK.exec(lines[index]?.text ?? "");
    if (notOk === null) continue;
    const read = readTapEntry(lines, index, (notOk[2] ?? "").replaceAll("\\#", "#"));
    if (read.entry !== null) entries.push(read.entry);
    index = read.next;
  }
  return finish(entries, tapCounts(lines, entries.length));
}

/* ------------------------------ spec ------------------------------ */

export const NODE_SPEC_SUMMARY = /^ℹ (tests|pass|fail|cancelled|skipped|todo) (\d+)\s*$/;
const SPEC_FAILING_HEADER = /^✖ failing tests:\s*$/;
const SPEC_TEST_AT = /^test at (.+?):(\d+):\d+\s*$/;
const SPEC_NAME_ROW = /^✖ (.*?)(?: \(\d+(?:\.\d+)?ms\))?\s*$/;
const SPEC_TREE_ROW = /^(\s*)([✖▶]) (.*?)(?: \(\d+(?:\.\d+)?ms\))?\s*$/;
const SPEC_ROW_START = /^\s*[✔✖▶﹣ℹ]/;

export function isSpecStream(lines: readonly CapturedLine[]): boolean {
  const keys = new Set<string>();
  for (const line of lines) {
    const match = NODE_SPEC_SUMMARY.exec(line.text);
    if (match !== null && ["tests", "pass", "fail"].includes(match[1] ?? "")) keys.add(match[1] ?? "");
  }
  return keys.size >= 2;
}

function specCounts(lines: readonly CapturedLine[]): AdapterCounts {
  const seen = new Map<string, number>();
  for (const line of lines) {
    const match = NODE_SPEC_SUMMARY.exec(line.text);
    if (match !== null) seen.set(match[1] ?? "", Number(match[2]));
  }
  const counts = emptyCounts();
  counts.passed = seen.get("pass") ?? 0;
  counts.failed = (seen.get("fail") ?? 0) + (seen.get("cancelled") ?? 0);
  counts.skipped = (seen.get("skipped") ?? 0) + (seen.get("todo") ?? 0);
  return counts;
}

/** A value that is one quoted string literal loses its quotes; anything else is unchanged. */
function inspectedString(value: string): string {
  const quote = value[0];
  if ((quote === "'" || quote === '"') && value.length >= 2 && value.endsWith(quote)) {
    const inner = value.slice(1, -1);
    if (!inner.includes(quote)) return inner;
  }
  return value;
}

/** One `test at ...` entry of the `✖ failing tests:` section. */
function readSpecEntry(lines: readonly CapturedLine[], start: number, end: number): NodeEntry | null {
  const at = SPEC_TEST_AT.exec(lines[start]?.text ?? "");
  const nameRow = SPEC_NAME_ROW.exec(lines[start + 1]?.text ?? "");
  if (at === null || nameRow === null) return null;

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
    last = index;
    if (/^at /.test(text)) inFrames = true;
    if (!inFrames) {
      messageLines.push(text);
    } else if (/^at /.test(text)) {
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
    fileLevel: message === "test failed" && path.resolve(name) === file,
    startLine: lines[start]?.line ?? 0,
    endLine: lines[last]?.line ?? 0,
  };
}

/**
 * Entries for a stream cut before its `✖ failing tests:` section: one per
 * failing leaf row printed before the summary. A `✖` row is a suite, not a
 * leaf, when an earlier `▶` row with the same name and indentation opened it.
 */
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
    if (opened.has(key)) continue;
    entries.push({
      name: row[3] ?? "",
      file: null,
      line: undefined,
      message: "",
      stack: [],
      fileLevel: false,
      startLine: line.line,
      endLine: line.line,
    });
  }
  return entries;
}

/** Contiguous non-blank runs of lines, split at tree rows and `ℹ` lines too. */
function textBlocks(lines: readonly CapturedLine[]): string[][] {
  const blocks: string[][] = [];
  let current: string[] = [];
  for (const line of lines) {
    if (line.text.trim() === "" || SPEC_ROW_START.test(line.text)) {
      if (current.length > 0) blocks.push(current);
      current = [];
    } else {
      current.push(line.text);
    }
  }
  if (current.length > 0) blocks.push(current);
  return blocks;
}

function firstErrorLine(block: readonly string[]): string | undefined {
  for (const text of block) {
    const error = errorLine(text);
    if (error !== undefined) return error;
  }
  return undefined;
}

/**
 * A whole test file that crashed is reported as `'test failed'`; node relayed
 * the subprocess's own error above the section. Take it from the block that
 * names the file, else (with a single crashed file) from the first error line.
 */
function adoptSubprocessErrors(before: readonly CapturedLine[], entries: readonly NodeEntry[]): void {
  const crashed = entries.filter((entry) => entry.fileLevel);
  if (crashed.length === 0) return;
  const blocks = textBlocks(before);
  for (const entry of crashed) {
    const absolute = entry.file ?? "";
    const mentions = (block: readonly string[]): boolean =>
      block.some((text) => text.includes(absolute) || text.includes(pathToFileURL(absolute).href));
    const error =
      firstErrorLine(blocks.find((block) => mentions(block) && firstErrorLine(block) !== undefined) ?? []) ??
      (crashed.length === 1 ? firstErrorLine(blocks.flat()) : undefined);
    if (error !== undefined) entry.subprocessError = error;
    // A file that died with no error we can attribute to it is a startup crash, never a behavioural failure.
    else entry.errorKind = "SYNTAX_IMPORT_ERROR";
  }
}

export function parseNodeSpec(lines: readonly CapturedLine[]): AdapterResult {
  const counts = specCounts(lines);
  const section = lines.findIndex((line) => SPEC_FAILING_HEADER.test(line.text));
  if (section < 0) return finish(readSpecLeafRows(lines), counts);

  const starts: number[] = [];
  for (let index = section + 1; index < lines.length; index += 1) {
    if (SPEC_TEST_AT.test(lines[index]?.text ?? "")) starts.push(index);
  }
  const entries: NodeEntry[] = [];
  starts.forEach((start, position) => {
    const entry = readSpecEntry(lines, start, starts[position + 1] ?? lines.length);
    if (entry !== null) entries.push(entry);
  });
  adoptSubprocessErrors(lines.slice(0, section), entries);
  return finish(entries, counts);
}
