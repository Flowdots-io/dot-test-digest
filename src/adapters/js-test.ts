import type { CapturedLine } from "../runner/capture.js";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import { canonicalTestId, normalizeTestName } from "../pruner/failure-identity.js";
import {
  classifyMessage,
  emptyCounts,
  mergeCounts,
  readCountTokens,
  type Adapter,
  type AdapterResult,
} from "./common.js";
import {
  COMPACT_BANNER,
  EXPECTED_LINE,
  FRAME,
  HEADER,
  inlineDiff,
  parseGeneric,
  RECEIVED_LINE,
  SUMMARY,
} from "./js-generic.js";
import { rerunFor } from "./rerun.js";
import { isNodeTapStream, isSpecStream, NODE_SPEC_SUMMARY, parseNodeSpec, parseNodeTap } from "./node-test.js";

const TAP_SUMMARY = /^#\s+(?:tests|pass|fail)\s+\d+\s*$/;
const PLAYWRIGHT_HEADER = /^\s*\d+\)\s+\[[^\]]+\]\s+›/;

/**
 * Vitest's non-TTY ("basic") reporter puts every failure in two sections: an
 * inline block per file, then one `Failed Tests` summary with the stacks (see
 * SPEC-002 §4.2.1). These markers let the adapter pick that grammar.
 */
const COMPACT_SUMMARY = /Failed Tests\s+\d+/;
const COMPACT_FAIL_ROW =
  /^\s*(?:×|✕|✗)\s+(.+?)(?:\s+\d+(?:\.\d+)?\s*(?:ms|s))?\s*$/;
const SUMMARY_FAIL_ROW = /^\s*FAIL\s+(.+?)\s+>\s+(.+?)\s*$/;
const ARROW_MESSAGE = /^\s*→\s+(.+?)\s*$/;
const GROUP_BREAK = /\[\d+\/\d+\]/;
const GROUP_SEPARATOR = /^\s*⎯{3,}/;
const ERROR_LINE = /^(?:[A-Za-z_$][\w.$]*Error|Error):\s/;
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

export const jsTestAdapter: Adapter = {
  name: "js-test",

  detect(lines) {
    let score = 0;
    let hasBanner = false;
    let hasCompactRow = false;
    for (const line of lines) {
      if (HEADER.test(line)) score += 1;
      if (SUMMARY.test(line) || /^\s*\d+\s+passing\s*\(/.test(line)) score += 3;
      if (TAP_SUMMARY.test(line) || NODE_SPEC_SUMMARY.test(line)) score += 3;
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

  parse(lines: readonly CapturedLine[], command: readonly string[] = []): AdapterResult {
    const result = isSpecStream(lines)
      ? parseNodeSpec(lines)
      : isCompactStream(lines)
        ? parseCompact(lines)
        : isNodeTapStream(lines)
          ? parseNodeTap(lines)
          : parseGeneric(lines);
    for (const failure of result.failures) {
      const rerun = rerunFor(command, ["node", "vitest", "jest"], { file: failure.testFile, name: failure.testName });
      if (rerun !== undefined) failure.rerun = rerun;
    }
    return result;
  },
};
