import { spawn } from "node:child_process";
import { constants } from "node:os";
import { StringDecoder } from "node:string_decoder";
import { defaultLineSources, type LineSourceFactory, type LogLines, type StreamName } from "./line-source.js";
import type { RawLogWriter } from "./raw-log.js";

export type { CapturedLine, StreamName } from "./line-source.js";

export interface CaptureResult {
  lines: LogLines;
  exitCode: number;
  signal: NodeJS.Signals | null;
  durationMs: number;
}

export interface CaptureOptions {
  rawLog: RawLogWriter;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  lineSources?: LineSourceFactory;
  progress?: ProgressOptions;
}

/** `--progress`: a heartbeat on stderr while the child runs. */
export interface ProgressOptions {
  intervalMs: number;
  /** On a terminal each heartbeat overwrites the previous one, and the last is cleared at the end. */
  isTTY: boolean;
  now: () => number;
  write: (text: string) => void;
}

export const PROGRESS_INTERVAL_MS = 10_000;
const CLEAR_LINE = "\r\u001b[K";

/** Starts the heartbeat; the returned function stops it, clearing a terminal's line if one was printed. */
function startHeartbeat(progress: ProgressOptions, rawLog: RawLogWriter): () => void {
  const startedAt = progress.now();
  let printed = false;
  const timer = setInterval(() => {
    const seconds = ((progress.now() - startedAt) / 1000).toFixed(1);
    const beat = `dot-test-digest: running... ${rawLog.linesWritten} lines, ${seconds}s`;
    progress.write(progress.isTTY ? `\r${beat}` : `${beat}\n`);
    printed = true;
  }, progress.intervalMs);
  return () => {
    clearInterval(timer);
    if (printed && progress.isTTY) progress.write(CLEAR_LINE);
  };
}

/** POSIX convention: a signal death is reported as 128 + signal number. */
export function signalExitCode(signal: NodeJS.Signals | null): number {
  if (signal === null) return 0;
  const number = constants.signals[signal];
  return 128 + (typeof number === "number" ? number : 0);
}

/**
 * Splits byte streams into whole lines, appends them to the raw log and to a line source. Only whole lines reach
 * the log, so its line numbers are the source's; `end` writes each stream's unterminated rest as a line.
 */
export class LogLineSink {
  readonly lines: LogLines;

  private readonly pending: Record<StreamName, string> = { stdout: "", stderr: "" };
  private readonly decoders: Record<StreamName, StringDecoder> = {
    stdout: new StringDecoder("utf8"),
    stderr: new StringDecoder("utf8"),
  };

  constructor(
    private readonly rawLog: RawLogWriter,
    lineSources: LineSourceFactory = defaultLineSources,
  ) {
    this.lines = lineSources({ path: rawLog.path, firstLine: rawLog.linesWritten + 1, startByte: rawLog.bytesWritten });
  }

  write(stream: StreamName, chunk: Buffer): void {
    this.ingest(stream, this.decoders[stream].write(chunk));
  }

  end(): LogLines {
    this.ingest("stdout", this.decoders.stdout.end());
    this.ingest("stderr", this.decoders.stderr.end());
    for (const stream of ["stdout", "stderr"] as const) {
      const rest = this.pending[stream];
      if (rest.length === 0) continue;
      this.pending[stream] = "";
      this.append(stream, [rest]);
    }
    return this.lines.seal();
  }

  private ingest(stream: StreamName, text: string): void {
    this.pending[stream] += text;
    const parts = this.pending[stream].split("\n");
    this.pending[stream] = parts.pop() ?? "";
    if (parts.length > 0) this.append(stream, parts);
  }

  private append(stream: StreamName, parts: string[]): void {
    const before = this.rawLog.bytesWritten;
    this.rawLog.write(parts.map((part) => `${part}\n`).join(""));
    this.lines.append(stream, parts, this.rawLog.bytesWritten - before);
  }
}

export function runChild(
  command: readonly string[],
  options: CaptureOptions,
): Promise<CaptureResult> {
  const [binary, ...args] = command;
  if (binary === undefined) return Promise.reject(new Error("runChild: empty command"));

  const startedAt = Date.now();
  const child = spawn(binary, args, {
    cwd: options.cwd ?? process.cwd(),
    env: options.env ?? process.env,
    stdio: ["ignore", "pipe", "pipe"],
    windowsHide: true,
  });

  const sink = new LogLineSink(options.rawLog, options.lineSources);
  const stopHeartbeat = options.progress ? startHeartbeat(options.progress, options.rawLog) : () => {};
  child.stdout.on("data", (chunk: Buffer) => sink.write("stdout", chunk));
  child.stderr.on("data", (chunk: Buffer) => sink.write("stderr", chunk));

  return new Promise<CaptureResult>((resolve, reject) => {
    child.on("error", (error) => {
      stopHeartbeat();
      reject(error);
    });
    child.on("close", (code, signal) => {
      stopHeartbeat();
      resolve({
        lines: sink.end(),
        exitCode: code ?? signalExitCode(signal),
        signal: signal ?? null,
        durationMs: Date.now() - startedAt,
      });
    });
  });
}
