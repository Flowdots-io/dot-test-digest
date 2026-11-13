import fs from "node:fs";

export type StreamName = "stdout" | "stderr";

export interface CapturedLine {
  stream: StreamName;
  text: string;
  line: number;
}

/** Output up to this size is held in memory; above it, lines are read back from the log. */
export const MEMORY_LIMIT_BYTES = 4 * 1024 * 1024;
export const CHUNK_BYTES = 1024 * 1024;
/** The most log bytes a file-backed source keeps decoded at once. */
export const CHUNK_CACHE_BYTES = 8 * 1024 * 1024;

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

export interface LineSourceStats {
  /** Chunks decoded from the log file. */
  chunkReads: number;
  /** Slices that covered every line: the whole output materialized at once. */
  fullReads: number;
}

export type LineSourceFactory = (span: LogSpan) => LogLines;

export const defaultLineSources: LineSourceFactory = (span) => new LogLines(span);

interface Chunk {
  start: number;
  end: number;
  firstIndex: number;
  count: number;
}

/** `[from, to)` the way `Array.prototype.slice` reads its arguments. */
function sliceBounds(length: number, start = 0, end = length): [number, number] {
  const clamp = (value: number): number => (value < 0 ? Math.max(0, length + value) : Math.min(value, length));
  return [clamp(start), clamp(end)];
}

function readFully(fd: number, buffer: Buffer, length: number, position: number): number {
  let filled = 0;
  while (filled < length) {
    const read = fs.readSync(fd, buffer, filled, length - filled, position + filled);
    if (read === 0) break;
    filled += read;
  }
  return filled;
}

/**
 * The lines of one capture. They are kept in memory while the output is at most `memoryLimitBytes`; past that the
 * array is dropped and, once sealed, lines are read back from the log through a cache of at most
 * `CHUNK_CACHE_BYTES` of chunks. The log does not store which stream a line came from, so a file-backed line is
 * always `stdout` (no adapter reads the stream).
 */
export class LogLines implements LineSource {
  readonly stats: LineSourceStats = { chunkReads: 0, fullReads: 0 };

  private memory: CapturedLine[] | null = [];
  private count = 0;
  private size = 0;
  private chunks: Chunk[] = [];
  private readonly cache = new Map<number, string[]>();
  private cachedBytes = 0;
  private lastChunk = -1;

  constructor(
    private readonly span: LogSpan,
    private readonly memoryLimitBytes = MEMORY_LIMIT_BYTES,
  ) {}

  /** An existing log, whole. */
  static read(path: string, memoryLimitBytes = MEMORY_LIMIT_BYTES): LogLines {
    const lines = new LogLines({ path, firstLine: 1, startByte: 0 }, memoryLimitBytes);
    const size = fs.statSync(path).size;
    if (size <= memoryLimitBytes) {
      const texts = fs.readFileSync(path, "utf8").split("\n");
      if (texts.at(-1) === "") texts.pop();
      lines.append("stdout", texts, size);
    } else {
      lines.size = size;
      lines.memory = null;
    }
    return lines.seal();
  }

  get mode(): "memory" | "file" {
    return this.memory === null ? "file" : "memory";
  }

  get length(): number {
    return this.count;
  }

  /** Bytes of output, as written to the log. */
  get bytes(): number {
    return this.size;
  }

  /** Lines just written to the log, and the bytes they took there. */
  append(stream: StreamName, texts: readonly string[], bytes: number): void {
    this.size += bytes;
    if (this.memory !== null && this.size > this.memoryLimitBytes) this.memory = null;
    if (this.memory !== null) {
      for (const [offset, text] of texts.entries()) {
        this.memory.push({ stream, text, line: this.span.firstLine + this.count + offset });
      }
    }
    this.count += texts.length;
  }

  /** Ends the capture; a file-backed source indexes its chunks of the log here. */
  seal(): this {
    if (this.memory === null) this.indexChunks();
    return this;
  }

  at(index: number): CapturedLine | undefined {
    const position = index < 0 ? this.count + index : index;
    if (position < 0 || position >= this.count) return undefined;
    if (this.memory !== null) return this.memory[position];
    const chunk = this.chunkOf(position);
    const texts = this.load(chunk);
    const descriptor = this.chunks[chunk];
    const text = descriptor === undefined ? undefined : texts[position - descriptor.firstIndex];
    return text === undefined ? undefined : { stream: "stdout", text, line: this.span.firstLine + position };
  }

  slice(start?: number, end?: number): CapturedLine[] {
    const [from, to] = sliceBounds(this.count, start, end);
    if (from === 0 && to === this.count && this.count > 0) this.stats.fullReads += 1;
    if (this.memory !== null) return this.memory.slice(from, to);
    const out: CapturedLine[] = [];
    for (let index = from; index < to; index += 1) {
      const line = this.at(index);
      if (line !== undefined) out.push(line);
    }
    return out;
  }

  *[Symbol.iterator](): Iterator<CapturedLine> {
    if (this.memory !== null) {
      yield* this.memory;
      return;
    }
    for (let index = 0; index < this.count; index += 1) {
      const line = this.at(index);
      if (line !== undefined) yield line;
    }
  }

  /** Cuts the span of the log into chunks of about `CHUNK_BYTES` that end on a line boundary. */
  private indexChunks(): void {
    const fd = fs.openSync(this.span.path, "r");
    try {
      const end = this.span.startByte + this.size;
      let buffer = Buffer.allocUnsafe(Math.min(CHUNK_BYTES, this.size));
      let position = this.span.startByte;
      let firstIndex = 0;
      while (position < end) {
        let length = Math.min(CHUNK_BYTES, end - position);
        let cut = -1;
        for (;;) {
          if (buffer.length < length) buffer = Buffer.allocUnsafe(length);
          length = readFully(fd, buffer, length, position);
          cut = buffer.subarray(0, length).lastIndexOf(10);
          // A line longer than a chunk gets a chunk of its own.
          if (cut >= 0 || position + length >= end || length === 0) break;
          length = Math.min(length * 2, end - position);
        }
        if (length === 0) break;
        const chunkLength = cut >= 0 ? cut + 1 : length;
        let count = 0;
        for (let at = buffer.indexOf(10, 0); at >= 0 && at < chunkLength; at = buffer.indexOf(10, at + 1)) count += 1;
        if (cut < 0) count += 1;
        this.chunks.push({ start: position, end: position + chunkLength, firstIndex, count });
        firstIndex += count;
        position += chunkLength;
      }
      this.count = firstIndex;
    } finally {
      fs.closeSync(fd);
    }
  }

  private chunkOf(position: number): number {
    const last = this.chunks[this.lastChunk];
    if (last !== undefined && position >= last.firstIndex && position < last.firstIndex + last.count) {
      return this.lastChunk;
    }
    let low = 0;
    let high = this.chunks.length - 1;
    while (low < high) {
      const middle = (low + high + 1) >> 1;
      if ((this.chunks[middle]?.firstIndex ?? 0) <= position) low = middle;
      else high = middle - 1;
    }
    this.lastChunk = low;
    return low;
  }

  private load(chunk: number): string[] {
    const cached = this.cache.get(chunk);
    if (cached !== undefined) {
      this.cache.delete(chunk);
      this.cache.set(chunk, cached);
      return cached;
    }
    const descriptor = this.chunks[chunk];
    if (descriptor === undefined) return [];
    const bytes = descriptor.end - descriptor.start;
    const buffer = Buffer.allocUnsafe(bytes);
    const fd = fs.openSync(this.span.path, "r");
    try {
      readFully(fd, buffer, bytes, descriptor.start);
    } finally {
      fs.closeSync(fd);
    }
    const texts = buffer.toString("utf8").split("\n");
    if (texts.at(-1) === "") texts.pop();
    this.stats.chunkReads += 1;
    this.cache.set(chunk, texts);
    this.cachedBytes += bytes;
    for (const [key] of this.cache) {
      if (this.cachedBytes <= CHUNK_CACHE_BYTES || this.cache.size <= 1) break;
      this.cachedBytes -= (this.chunks[key]?.end ?? 0) - (this.chunks[key]?.start ?? 0);
      this.cache.delete(key);
    }
    return texts;
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
