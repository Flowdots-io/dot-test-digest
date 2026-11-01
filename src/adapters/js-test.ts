import path from "node:path";
import { fileURLToPath } from "node:url";
import type { CapturedLine } from "../runner/capture.js";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import { canonicalTestId, normalizeTestName } from "../pruner/failure-identity.js";
import {
  classifyMessage,
  emptyCounts,
  mergeCounts,
  readCountTokens,
  type Adapter,
  type AdapterCounts,
  type AdapterResult,
} from "./common.js";

const HEADER = /^\s*(?:FAIL|✕|×|✗|●|not ok\s+\d+|\d+\))\s+(.+?)\s*$/;
const TAP_SUMMARY = /^#\s+(?:tests|pass|fail)\s+\d+\s*$/;
const PLAYWRIGHT_HEADER = /^\s*\d+\)\s+\[[^\]]+\]\s+›/;
const FRAME = /^\s*(?:❯|at)\s+(.+?)\s*$/;
const ERROR_MESSAGE = /(?:^|\s)((?:[A-Za-z]*Error|AssertionError)[^\n]*)$/;
const SUMMARY = /\b(?:Tests|Test Files|Tests:)\b/;

/**
 * Vitest's non-TTY ("basic") reporter puts every failure in two sections: an
 * inline block per file, then one `Failed Tests` summary with the stacks (see
 * SPEC-002 §4.2.1). These markers let the adapter pick that grammar.
 */
const COMPACT_SUMMARY = /Failed Tests\s+\d+/;
const COMPACT_BANNER =
  /^\s*❯\s+(.+?)\s+\(\d+\s+tests?(?:\s*\|\s*\d+\s+failed)?\)(?:\s+\d+(?:\.\d+)?\s*(?:ms|s))?\s*$/;
const COMPACT_FAIL_ROW =
  /^\s*(?:×|✕|✗)\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*(?:ms|s))?\s*$/;
const SUMMARY_FAIL_ROW = /^\s*FAIL\s+(.+?)\s+>\s+(.+?)\s*$/;
const ARROW_MESSAGE = /^\s*→\s+(.+?)\s*$/;
const GROUP_BREAK = /\[\d+\/\d+\]/;
const GROUP_SEPARATOR = /^\s*⎯{3,}/;
const ERROR_LINE = /^(?:[A-Za-z_$][\w.$]*Error|Error):\s/;
const EXPECTED_LINE = /^\s*Expected\s*:?\s*(.+)$/i;
const RECEIVED_LINE = /^\s*Received\s*:?\s*(.+)$/i;
const MINUS_VALUE = /^-\s+(.*)$/;
const PLUS_VALUE = /^\+\s+(.*)$/;

interface InlineFailure {
  file: string | null;
  name: string;
  message: string;
  frames: string[];
  diff?: { expected: string; received: string };
  startLine: number;
  endLine: number;
}

interface SummaryRow {
  file: string;
  name: string;
  startLine: number;
  endLine: number;
}

interface SummaryGroup {
  rows: SummaryRow[];
  message: string;
  frames: string[];
  diff?: { expected: string; received: string };
  endLine: number;
}

function inlineDiff(text: string): { expected: string; received: string } | undefined {
  const inline = /\bexpected\s+(.+?)\s+to\s+(?:be|equal|match|contain|throw)\s+(.+)$/i.exec(
    text,
  );
  if (inline?.[1] === undefined || inline[2] === undefined) return undefined;
  return { expected: inline[2].trim(), received: inline[1].trim() };
}

function isCompactStream(lines: readonly CapturedLine[]): boolean {
  // A failed *suite* (`Failed Suites`, e.g. a broken import) has a banner but
  // no inline `×` rows; it must stay on the generic grammar so its error kind
  // and failure block are preserved.
  if (lines.some((line) => COMPACT_SUMMARY.test(line.text))) return true;
  return (
    lines.some((line) => COMPACT_BANNER.test(line.text)) &&
    lines.some((line) => COMPACT_FAIL_ROW.test(line.text))
  );
}

/**
 * Parses the piped Vitest/Jest compact reporter. Inline rows carry the test
 * name and message; the summary carries the file, one shared stack per error
 * group, and the counts. Both sections describe the same tests, so they are
 * merged by canonical identity (§4.2.2) and never counted twice.
 */
function parseCompact(lines: readonly CapturedLine[]): AdapterResult {
  const inline: InlineFailure[] = [];
  const groups: SummaryGroup[] = [];
  let counts = emptyCounts();
  let mode: "inline" | "summary" = "inline";
  let bannerFile: string | null = null;
  let currentInline: InlineFailure | null = null;
  let group: SummaryGroup | null = null;
  let diffStarted = false;
  let diffExpected = "";
  let diffReceived = "";

  const seal = (): void => {
    if (group !== null) {
      if (group.diff === undefined && diffExpected !== "" && diffReceived !== "") {
        group.diff = { expected: diffExpected, received: diffReceived };
      }
      groups.push(group);
      group = null;
    }
    diffStarted = false;
    diffExpected = "";
    diffReceived = "";
  };

  for (const line of lines) {
    const text = line.text;

    if (COMPACT_SUMMARY.test(text)) {
      seal();
      mode = "summary";
      currentInline = null;
      continue;
    }

    if (GROUP_BREAK.test(text) || GROUP_SEPARATOR.test(text)) {
      seal();
      continue;
    }

    if (SUMMARY.test(text)) {
      const tokens = readCountTokens(text);
      if (tokens !== null) counts = mergeCounts(counts, tokens);
      continue;
    }

    const banner = COMPACT_BANNER.exec(text);
    if (banner !== null) {
      currentInline = null;
      bannerFile = banner[1]?.trim() ?? null;
      continue;
    }

    const failingRow = COMPACT_FAIL_ROW.exec(text);
    if (failingRow !== null) {
      const name = normalizeTestName(failingRow[1] ?? "");
      const failure: InlineFailure = {
        file: bannerFile,
        name,
        message: "",
        frames: [],
        startLine: line.line,
        endLine: line.line,
      };
      inline.push(failure);
      currentInline = failure;
      continue;
    }

    const arrow = ARROW_MESSAGE.exec(text);
    if (arrow !== null) {
      const message = arrow[1]?.trim() ?? "";
      if (currentInline !== null) {
        currentInline.message = message;
        const diff = inlineDiff(message);
        if (diff !== undefined) currentInline.diff = diff;
        currentInline.endLine = line.line;
      }
      continue;
    }

    if (mode === "summary") {
      const failRow = SUMMARY_FAIL_ROW.exec(text);
      if (failRow !== null) {
        // A new FAIL row after a group already learned its error starts the
        // next adjacency group; consecutive rows share the block that follows.
        if (group !== null && (group.frames.length > 0 || group.message !== "")) {
          seal();
        }
        if (group === null) {
          group = { rows: [], message: "", frames: [], endLine: line.line };
        }
        group.rows.push({
          file: (failRow[1] ?? "").trim(),
          name: normalizeTestName(failRow[2] ?? ""),
          startLine: line.line,
          endLine: line.line,
        });
        group.endLine = line.line;
        continue;
      }

      if (group === null) continue;

      if (group.message === "" && ERROR_LINE.test(text.trim())) {
        group.message = text.trim();
        group.endLine = line.line;
        continue;
      }

      const frame = FRAME.exec(text);
      if (frame !== null) {
        group.frames.push(frame[1] ?? "");
        group.endLine = line.line;
        continue;
      }

      const trimmed = text.trim();
      if (/^- Expected$/.test(trimmed)) {
        diffStarted = true;
        diffExpected = "";
        diffReceived = "";
        group.endLine = line.line;
        continue;
      }
      if (/^\+ Received$/.test(trimmed)) {
        diffStarted = true;
        group.endLine = line.line;
        continue;
      }
      if (diffStarted) {
        const minus = MINUS_VALUE.exec(text);
        if (minus !== null) {
          diffExpected = (minus[1] ?? "").trim();
          if (diffReceived !== "") group.diff ??= { expected: diffExpected, received: diffReceived };
          group.endLine = line.line;
          continue;
        }
        const plus = PLUS_VALUE.exec(text);
        if (plus !== null) {
          diffReceived = (plus[1] ?? "").trim();
          if (diffExpected !== "") group.diff ??= { expected: diffExpected, received: diffReceived };
          group.endLine = line.line;
          continue;
        }
        if (trimmed !== "") diffStarted = false;
      }

      const expected = EXPECTED_LINE.exec(text);
      if (expected?.[1] !== undefined) {
        group.diff = {
          expected: expected[1].trim(),
          received: group.diff?.received ?? "",
        };
        group.endLine = line.line;
        continue;
      }
      const received = RECEIVED_LINE.exec(text);
      if (received?.[1] !== undefined) {
        group.diff = {
          expected: group.diff?.expected ?? "",
          received: received[1].trim(),
        };
        group.endLine = line.line;
        continue;
      }
      continue;
    }

    // TTY reporters print the stack inline, right after the message.
    const frame = FRAME.exec(text);
    if (frame !== null && currentInline !== null) {
      currentInline.frames.push(frame[1] ?? "");
      currentInline.endLine = line.line;
    }
  }

  seal();

  const emitted = new Map<string, RawFailure>();
  const keyOf = (file: string | null, name: string): string =>
    canonicalTestId(file, name) ?? name;

  for (const summaryGroup of groups) {
    for (const row of summaryGroup.rows) {
      const key = keyOf(row.file, row.name);
      if (emitted.has(key)) continue;
      emitted.set(key, {
        testFile: row.file,
        testName: row.name,
        errorKind: "RUNTIME_EXCEPTION",
        message: summaryGroup.message,
        frames: [...summaryGroup.frames],
        ...(summaryGroup.diff !== undefined ? { diff: summaryGroup.diff } : {}),
        startLine: row.startLine,
        endLine: Math.max(row.endLine, summaryGroup.endLine),
      });
    }
  }

  for (const item of inline) {
    const key = keyOf(item.file, item.name);
    const existing = emitted.get(key);
    if (existing !== undefined) {
      if (existing.message === "") existing.message = item.message;
      if (existing.diff === undefined && item.diff !== undefined) existing.diff = item.diff;
      existing.startLine = Math.min(existing.startLine, item.startLine);
      existing.endLine = Math.max(existing.endLine, item.endLine);
      continue;
    }
    emitted.set(key, {
      testFile: item.file,
      testName: item.name,
      errorKind: "RUNTIME_EXCEPTION",
      message: item.message,
      frames: [...item.frames],
      ...(item.diff !== undefined ? { diff: item.diff } : {}),
      startLine: item.startLine,
      endLine: item.endLine,
    });
  }

  const failures = [...emitted.values()]
    .map((failure) => ({
      ...failure,
      errorKind: classifyMessage(`${failure.message}\n${failure.frames.join("\n")}`),
    }))
    .sort((a, b) => a.startLine - b.startLine || a.endLine - b.endLine);

  if (counts.failed === 0 && failures.length > 0) counts.failed = failures.length;
  return { adapter: "js-test", failures, counts };
}

const TAP_NOT_OK = /^(\s*)not ok\s+\d+\s*(?:-\s*)?(.*?)\s*$/;
const YAML_KEY = /^([A-Za-z_][\w-]*):(?:\s+(.*?))?\s*$/;
const FILE_URL = /file:\/\/[^\s()]*/g;

interface NodeBlock {
  fields: Map<string, string[]>;
  /** Index (in the lines array) of the closing `...`. */
  endIndex: number;
}

function leadingSpaces(text: string): number {
  return text.length - text.trimStart().length;
}

function unquote(value: string): string {
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
function readTapBlock(lines: readonly CapturedLine[], headerIndex: number): NodeBlock | null {
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
    if (inline !== "" && !scalarBlock) bucket.push(unquote(inline));
  }
  return null;
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

function nodeFailure(
  name: string,
  block: NodeBlock,
  startLine: number,
  endLine: number,
): RawFailure {
  const field = (key: string): string[] => block.fields.get(key) ?? [];
  const errorName = field("name").join(" ").trim();
  let message = field("error")
    .filter((line) => line !== "")
    .join(" ")
    .replace(/\s+/g, " ")
    .replace(/^([A-Za-z_$][\w.$]*) \[[A-Z][A-Z0-9_]*\]:/, "$1:")
    .trim();
  if (errorName !== "" && !message.startsWith(errorName)) message = `${errorName}: ${message}`;

  const location = field("location")[0];
  const locationFile = location === undefined ? undefined : /^(.*?)(?::\d+){1,2}$/.exec(location)?.[1];
  const testFile = locationFile === undefined ? null : relativeToCwd(locationFile);

  const expected = field("expected");
  const actual = field("actual");
  const diff =
    expected.length > 0 && actual.length > 0
      ? { expected: expected.join(", "), received: actual.join(", ") }
      : undefined;

  const frames = field("stack").map(nodePath);
  return {
    testName: name === "" ? null : name,
    testFile,
    errorKind: classifyMessage(`${message}\n${frames.join("\n")}`),
    message: message === "" ? "Unknown test failure" : message,
    frames,
    ...(diff !== undefined ? { diff } : {}),
    startLine,
    endLine,
  };
}

/** The v0.1.1 grammar for TTY-style streams, TAP and Playwright headers. */
function parseGeneric(lines: readonly CapturedLine[]): AdapterResult {
  const failures: RawFailure[] = [];
  let counts: AdapterCounts = emptyCounts();
  let current: RawFailure | null = null;

  const flush = (): void => {
    if (current === null) return;
    current.errorKind = classifyMessage(`${current.message}\n${current.frames.join("\n")}`);
    if (current.message === "") current.message = "Unknown test failure";
    failures.push(current);
    current = null;
  };

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index] as CapturedLine;
    const text = line.text;

    // SPEC-002 §4.2.1(a): a file banner is metadata, never a frame/failure.
    if (COMPACT_BANNER.test(text)) continue;

    // A `not ok` entry whose YAML block has a top-level `failureType:` key is
    // node's own diagnostic block: one failure, read by key.
    const notOk = TAP_NOT_OK.exec(text);
    if (notOk !== null) {
      const block = readTapBlock(lines, index);
      if (block?.fields.has("failureType") === true) {
        flush();
        const endLine = lines[block.endIndex]?.line ?? line.line;
        failures.push(nodeFailure(notOk[2] ?? "", block, line.line, endLine));
        index = block.endIndex;
        continue;
      }
    }

    const header = HEADER.exec(text);
    if (header !== null) {
      flush();
      const rawName = header[1] ?? "";
      const fileMatch = /^(\S+\.(?:spec|test)\.[cm]?[jt]sx?)\s*>\s*/.exec(rawName.trim());
      const name = normalizeTestName(rawName);
      current = {
        testName: name === "" ? null : name,
        testFile: fileMatch?.[1] ?? null,
        errorKind: "RUNTIME_EXCEPTION",
        message: "",
        frames: [],
        startLine: line.line,
        endLine: line.line,
      };
      continue;
    }

    if (SUMMARY.test(text)) {
      const tokens = readCountTokens(text);
      if (tokens !== null) counts = mergeCounts(counts, tokens);
      continue;
    }

    const tap = /^#\s+(tests|pass|fail)\s+(\d+)\s*$/.exec(text);
    if (tap !== null) {
      const value = Number(tap[2]);
      if (tap[1] === "pass") counts.passed = Math.max(counts.passed, value);
      if (tap[1] === "fail") counts.failed = Math.max(counts.failed, value);
      continue;
    }

    if (current === null) {
      if (!FRAME.test(text) && !ERROR_MESSAGE.test(text)) continue;
      current = {
        testName: null,
        testFile: null,
        errorKind: "RUNTIME_EXCEPTION",
        message: "",
        frames: [],
        startLine: line.line,
        endLine: line.line,
      };
    }

    current.endLine = line.line;

    if (current.message === "") {
      const message = ERROR_MESSAGE.exec(text);
      if (message?.[1] !== undefined) current.message = message[1].trim();
    }

    const frame = FRAME.exec(text);
    if (frame?.[1] !== undefined) {
      current.frames.push(frame[1]);
      continue;
    }

    const expected = /^\s*Expected\s*:?\s*(.+)$/i.exec(text);
    const received = /^\s*Received\s*:?\s*(.+)$/i.exec(text);
    if (expected !== null || received !== null) {
      const diff = current.diff ?? { expected: "", received: "" };
      if (expected?.[1] !== undefined) diff.expected = expected[1].trim();
      if (received?.[1] !== undefined) diff.received = received[1].trim();
      current.diff = diff;
      continue;
    }

    if (current.diff === undefined) {
      const inline = /\bexpected\s+(.+?)\s+to\s+(?:be|equal|match|contain|throw)\s+(.+)$/i.exec(
        text,
      );
      if (inline?.[1] !== undefined && inline[2] !== undefined) {
        current.diff = { expected: inline[2].trim(), received: inline[1].trim() };
      }
    }
  }

  flush();
  if (counts.failed === 0 && failures.length > 0) counts.failed = failures.length;
  return { adapter: "js-test", failures, counts };
}

export const jsTestAdapter: Adapter = {
  name: "js-test",

  detect(lines) {
    let score = 0;
    let hasBanner = false;
    let hasCompactRow = false;
    for (const line of lines) {
      if (HEADER.test(line)) score += 1;
      if (SUMMARY.test(line) || /^\s*\d+\s+passing\s*\(/.test(line)) score += 3;
      if (TAP_SUMMARY.test(line)) score += 3;
      if (PLAYWRIGHT_HEADER.test(line)) score += 2;
      if (COMPACT_SUMMARY.test(line)) score += 4;
      if (COMPACT_BANNER.test(line)) {
        hasBanner = true;
        score += 2;
      }
      if (COMPACT_FAIL_ROW.test(line)) hasCompactRow = true;
    }
    if (hasBanner && hasCompactRow) score += 2;
    return score;
  },

  parse(lines: readonly CapturedLine[]): AdapterResult {
    return isCompactStream(lines) ? parseCompact(lines) : parseGeneric(lines);
  },
};
