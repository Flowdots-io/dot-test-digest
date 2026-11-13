import type { JevAsker } from "../gears/gear1-jev.js";
import type { FinishDeps } from "../runner/finish-run.js";
import type { LineSourceFactory } from "../runner/line-source.js";
import { defaultLogDir } from "../runner/raw-log.js";
import { runConfig } from "./config.js";
import { runDigest } from "./digest.js";
import { runGc } from "./gc.js";
import { CliError, EX_SOFTWARE, UsageError } from "./errors.js";
import { runReplay } from "./replay.js";
import { runShow } from "./show.js";
import { runSchema } from "./schema.js";
import { runStats } from "./stats.js";
import type { SubcommandName } from "./subcommands.js";

export interface SubcommandContext {
  /** The cache's `logs/` directory. */
  logDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  /** Whether stdout is a terminal, for `--color=auto`. */
  stdoutIsTTY: boolean;
  /** Whether stdin is a terminal: `digest -` refuses to wait on one. */
  stdinIsTTY: boolean;
  stdin: NodeJS.ReadableStream;
  /** How a subcommand that writes a run records it and prunes the cache afterwards. */
  finish: Omit<FinishDeps, "warn">;
  /** The Jev client a test injects; a subcommand that must stay offline never calls it. */
  client?: JevAsker;
  /** How `digest` holds the lines it reads; a test spies on it. */
  lineSources?: LineSourceFactory;
  write: (text: string) => void;
  /** One stderr line, without its newline. */
  warn: (line: string) => void;
}

/** Returns the exit code; a `CliError` it throws becomes a stderr line and that error's code. */
export type Subcommand = (args: readonly string[], context: SubcommandContext) => number | Promise<number>;

/** `undefined`: listed in the help and reserved, but not in this version yet. */
const HANDLERS: Record<SubcommandName, Subcommand | undefined> = {
  show: runShow,
  replay: runReplay,
  digest: runDigest,
  gc: runGc,
  stats: runStats,
  doctor: undefined,
  init: undefined,
  mcp: undefined,
  config: runConfig,
  schema: runSchema,
};

/** What the caller of `main()` injects; each defaults to the process's own. */
export interface SubcommandDeps extends Omit<FinishDeps, "warn"> {
  env?: NodeJS.ProcessEnv;
  stdoutIsTTY?: boolean;
  /** Whether stderr is a terminal: a `--progress` heartbeat then overwrites itself. */
  stderrIsTTY?: boolean;
  stdinIsTTY?: boolean;
  /** The clock a `--progress` heartbeat reads its elapsed time from, in milliseconds. */
  now?: () => number;
  /** What `digest -` reads; defaults to `process.stdin`. */
  stdin?: NodeJS.ReadableStream;
  client?: JevAsker;
  /** How a run holds its captured lines: in memory up to 4 MiB, else read back from the log. */
  lineSources?: LineSourceFactory;
}

export async function runSubcommand(
  name: SubcommandName,
  args: readonly string[],
  deps: SubcommandDeps = {},
): Promise<number> {
  const context: SubcommandContext = {
    logDir: defaultLogDir(),
    cwd: process.cwd(),
    env: deps.env ?? process.env,
    stdoutIsTTY: deps.stdoutIsTTY ?? process.stdout.isTTY === true,
    stdinIsTTY: deps.stdinIsTTY ?? process.stdin.isTTY === true,
    stdin: deps.stdin ?? process.stdin,
    finish: {
      ...(deps.writeRecord ? { writeRecord: deps.writeRecord } : {}),
      ...(deps.prune ? { prune: deps.prune } : {}),
    },
    ...(deps.client ? { client: deps.client } : {}),
    ...(deps.lineSources ? { lineSources: deps.lineSources } : {}),
    write: (text) => {
      process.stdout.write(text);
    },
    warn: (line) => {
      process.stderr.write(`${line}\n`);
    },
  };
  try {
    const handler = HANDLERS[name];
    if (handler === undefined) throw new UsageError(`${name} is not available in this version`);
    return await handler(args, context);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      return error.exitCode;
    }
    const message = error instanceof Error ? error.message : String(error);
    process.stderr.write(`dot-test-digest: ${message}\n`);
    return EX_SOFTWARE;
  }
}
