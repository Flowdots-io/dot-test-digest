import fs from "node:fs";

export type StreamName = "stdout" | "stderr";

export interface CapturedLine {
  stream: StreamName;
  text: string;
  line: number;
}

/**
 * Read access to captured lines by 0-based index, shaped like a read-only array so that a `CapturedLine[]` is one.
 * `at` counts a negative index from the end, as arrays do.
 */
export interface LineSource extends Iterable<CapturedLine> {
  readonly length: number;
  at(index: number): CapturedLine | undefined;
  slice(start?: number, end?: number): CapturedLine[];
}

/** Where a run's lines start in its log: a retry appends a second capture to the same log. */
export interface LogSpan {
  path: string;
  /** The log line number of the first line. */
  firstLine: number;
  /** The byte offset of the first line in the log. */
  startByte: number;
}

export type LineSourceFactory = (span: LogSpan) => LogLines;

export const defaultLineSources: LineSourceFactory = (span) => new LogLines(span);

/** The lines of one capture, held in memory. */
export class LogLines implements LineSource {
  private readonly memory: CapturedLine[] = [];

  constructor(private readonly span: LogSpan) {}

  /** An existing log, whole. */
  static read(path: string): LogLines {
    const lines = new LogLines({ path, firstLine: 1, startByte: 0 });
    const texts = fs.readFileSync(path, "utf8").split("\n");
    if (texts.at(-1) === "") texts.pop();
    lines.append("stdout", texts, 0);
    return lines.seal();
  }

  get length(): number {
    return this.memory.length;
  }

  /** Lines just written to the log, and the bytes they took there. */
  append(stream: StreamName, texts: readonly string[], _bytes: number): void {
    for (const text of texts) {
      this.memory.push({ stream, text, line: this.span.firstLine + this.memory.length });
    }
  }

  seal(): this {
    return this;
  }

  at(index: number): CapturedLine | undefined {
    return this.memory.at(index);
  }

  slice(start?: number, end?: number): CapturedLine[] {
    return this.memory.slice(start, end);
  }

  [Symbol.iterator](): Iterator<CapturedLine> {
    return this.memory[Symbol.iterator]();
  }
}

/** A view of `source` whose texts pass through `transform` as they are read. */
export function mapLines(source: LineSource, transform: (text: string) => string): LineSource {
  const map = (line: CapturedLine): CapturedLine => ({ ...line, text: transform(line.text) });
  return {
    get length() {
      return source.length;
    },
    at: (index) => {
      const line = source.at(index);
      return line === undefined ? undefined : map(line);
    },
    slice: (start, end) => source.slice(start, end).map(map),
    *[Symbol.iterator]() {
      for (const line of source) yield map(line);
    },
  };
}

/** The texts of a source, read lazily. */
export function textsOf(source: LineSource): Iterable<string> {
  return {
    *[Symbol.iterator]() {
      for (const line of source) yield line.text;
    },
  };
}

/** The line at `index`, or `undefined` outside the source; unlike `at`, a negative index is never counted from the end. */
export function lineAt(source: LineSource, index: number): CapturedLine | undefined {
  return index < 0 ? undefined : source.at(index);
}

/** The index of the first line whose text passes `test`, or -1. */
export function findLineIndex(source: LineSource, test: (text: string) => boolean): number {
  let index = 0;
  for (const line of source) {
    if (test(line.text)) return index;
    index += 1;
  }
  return -1;
}
