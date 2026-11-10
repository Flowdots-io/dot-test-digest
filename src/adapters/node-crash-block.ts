import fs from "node:fs";

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

function firstErrorLine(block: readonly string[]): string | undefined {
  for (const text of block) {
    const error = errorLine(text);
    if (error !== undefined) return error;
  }
  return undefined;
}

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
export function crashBlockError(lines: readonly string[]): string | undefined {
  const trailer = lastIndexWhere(lines, (text) => CRASH_TRAILER.test(text));
  const location =
    trailer < 0 ? -1 : lastIndexWhere(lines, (text) => CRASH_LOCATION.test(text) && errorLine(text) === undefined, trailer);
  if (location >= 0) return firstErrorLine(lines.slice(location, trailer));
  return lines.find((text) => LATE_ERROR.test(text))?.trimEnd();
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
