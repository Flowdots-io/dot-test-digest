import fs from "node:fs";
import { classifyMessage } from "./common.js";

const NODE_ERROR_LINE = /^([A-Za-z]*Error)(?: \[[^\]]+\])?: (.*\S)\s*$/;
const CRASH_TRAILER = /^Node\.js v\d/;
/** A non-indented line ending in `:<N>`; a stack frame is indented and an error line is excluded where it is used. */
const CRASH_LOCATION = /^\S.*:\d+$/;
/** node's own diagnostic for a test file whose tests ran and then failed on a late error: it names no crash. */
const LATE_ERROR = /^Error: .* generated asynchronous activity after the test ended\./;
/** node could not read the test file at all, so no test ran: the runner's startup crash. */
const FILE_READ_FAILURE = /^Error: (?:EACCES|EPERM)\b/;

function errorLine(text: string): string | undefined {
  const match = NODE_ERROR_LINE.exec(text);
  return match === null ? undefined : `${match[1] ?? ""}: ${match[2] ?? ""}`;
}

function isLocationLine(text: string): boolean {
  return CRASH_LOCATION.test(text) && errorLine(text) === undefined;
}

function lastIndexWhere(lines: readonly string[], test: (text: string) => boolean): number {
  let index = lines.length - 1;
  while (index >= 0 && !test(lines[index] ?? "")) index -= 1;
  return index;
}

/** The error of the crash block whose trailer ends `segment`: the first error line after its location line. */
function blockError(segment: readonly string[]): string | undefined {
  const lastError = lastIndexWhere(segment, (text) => errorLine(text) !== undefined);
  if (lastError < 0) return undefined;
  const location = lastIndexWhere(segment.slice(0, lastError), isLocationLine);
  if (location < 0) return undefined;
  return segment.slice(location + 1).map(errorLine).find((error) => error !== undefined);
}

function blockErrors(lines: readonly string[]): string[] {
  const errors: string[] = [];
  let start = 0;
  lines.forEach((text, index) => {
    if (!CRASH_TRAILER.test(text)) return;
    const error = blockError(lines.slice(start, index));
    if (error !== undefined) errors.push(error);
    start = index + 1;
  });
  return errors;
}

/**
 * The error node printed for a crashed file, from the lines above the file's own entry. Each crash block is
 * a location-only line, the source and caret, the error, its stack, and the trailer `Node.js v<version>`.
 * Several blocks can sit there (a process the setup module started crashed too): the first import or syntax
 * error wins, so a broken import is never hidden, else the last block. A setup log, another file's output or
 * a stack frame that names another file is outside every block and never stands in for the error. With no
 * block, node's late-error diagnostic among the lines is the message: that file's tests ran, it did not
 * crash at startup.
 */
export function fileErrorAbove(lines: readonly string[]): string | undefined {
  const errors = blockErrors(lines);
  const error = errors.find((candidate) => classifyMessage(candidate) === "SYNTAX_IMPORT_ERROR") ?? errors.at(-1);
  return error ?? lines.find((text) => LATE_ERROR.test(text))?.trimEnd();
}

function realPathOf(file: string): string {
  try {
    return fs.realpathSync(file);
  } catch {
    return file;
  }
}

/**
 * A read failure counts only when it names the test file itself, quoted: `open '/dir/a.test.js'`, not
 * `'/dir/a.test.json'`. The entry carries the path as given, node's error the real path: either counts.
 */
export function isFileReadFailure(subprocessError: string, file: string | null): boolean {
  if (!FILE_READ_FAILURE.test(subprocessError) || file === null) return false;
  return [file, realPathOf(file)].some((candidate) => subprocessError.includes(`'${candidate}'`));
}
