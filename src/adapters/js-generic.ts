import type { LineSource } from "../runner/line-source.js";
import type { RawFailure } from "../pruner/cluster-dedup.js";
import { normalizeTestName } from "../pruner/failure-identity.js";
import {
  classifyMessage,
  emptyCounts,
  mergeCounts,
  readCountTokens,
  type AdapterCounts,
  type AdapterResult,
} from "./common.js";

export const HEADER = /^\s*(?:FAIL|✕|×|✗|●|not ok\s+\d+|\d+\))\s+(.+?)\s*$/;
export const SUMMARY = /\b(?:Tests|Test Files|Tests:)\b/;
export const FRAME = /^\s*(?:❯|at)\s+(.+?)\s*$/;
export const COMPACT_BANNER =
  /^\s*❯\s+(.+?)\s+\(\d+\s+tests?(?:\s*\|\s*\d+\s+failed)?\)(?:\s+\d+(?:\.\d+)?\s*(?:ms|s))?\s*$/;
export const EXPECTED_LINE = /^\s*Expected\s*:?\s*(.+)$/i;
export const RECEIVED_LINE = /^\s*Received\s*:?\s*(.+)$/i;
const ERROR_MESSAGE = /(?:^|\s)((?:[A-Za-z]*Error|AssertionError)[^\n]*)$/;

export function inlineDiff(text: string): { expected: string; received: string } | undefined {
  const inline = /\bexpected\s+(.+?)\s+to\s+(?:be|equal|match|contain|throw)\s+(.+)$/i.exec(
    text,
  );
  if (inline?.[1] === undefined || inline[2] === undefined) return undefined;
  return { expected: inline[2].trim(), received: inline[1].trim() };
}

export function parseGeneric(lines: LineSource): AdapterResult {
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

  for (const line of lines) {
    const text = line.text;

    if (COMPACT_BANNER.test(text)) continue;

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

    const expected = EXPECTED_LINE.exec(text);
    const received = RECEIVED_LINE.exec(text);
    if (expected !== null || received !== null) {
      const diff = current.diff ?? { expected: "", received: "" };
      if (expected?.[1] !== undefined) diff.expected = expected[1].trim();
      if (received?.[1] !== undefined) diff.received = received[1].trim();
      current.diff = diff;
      continue;
    }

    if (current.diff === undefined) {
      const diff = inlineDiff(text);
      if (diff !== undefined) current.diff = diff;
    }
  }

  flush();
  if (counts.failed === 0 && failures.length > 0) counts.failed = failures.length;
  return { adapter: "js-test", failures, counts };
}
