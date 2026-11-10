const NODE_ERROR_LINE = /^([A-Za-z]*Error)(?: \[[^\]]+\])?: (.*\S)\s*$/;
const CRASH_TRAILER = /^Node\.js v\d/;
const CRASH_LOCATION = /^(?:file:\/\/|node:|\/|[A-Za-z]:[\\/])\S*:\d+$/;
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
  const location = trailer < 0 ? -1 : lastIndexWhere(lines, (text) => CRASH_LOCATION.test(text), trailer);
  return location < 0 ? undefined : firstErrorLine(lines.slice(location, trailer));
}

/** A read failure counts only when it names the test file itself, quoted: `open '/dir/a.test.js'`, not `'/dir/a.test.json'`. */
export function isFileReadFailure(subprocessError: string, file: string | null): boolean {
  return FILE_READ_FAILURE.test(subprocessError) && file !== null && subprocessError.includes(`'${file}'`);
}
