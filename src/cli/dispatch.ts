import { defaultLogDir } from "../runner/raw-log.js";
import { runConfig } from "./config.js";
import { CliError, EX_SOFTWARE, UsageError } from "./errors.js";
import { runShow } from "./show.js";
import type { SubcommandName } from "./subcommands.js";

export interface SubcommandContext {
  /** The cache's `logs/` directory. */
  logDir: string;
  cwd: string;
  env: NodeJS.ProcessEnv;
  write: (text: string) => void;
  /** One stderr line, without its newline. */
  warn: (line: string) => void;
}

/** Returns the exit code; a `CliError` it throws becomes a stderr line and that error's code. */
export type Subcommand = (args: readonly string[], context: SubcommandContext) => number | Promise<number>;

/** `undefined`: listed in the help and reserved, but not in this version yet. */
const HANDLERS: Record<SubcommandName, Subcommand | undefined> = {
  show: runShow,
  replay: undefined,
  digest: undefined,
  gc: undefined,
  stats: undefined,
  doctor: undefined,
  init: undefined,
  mcp: undefined,
  config: runConfig,
  schema: undefined,
};

export async function runSubcommand(
  name: SubcommandName,
  args: readonly string[],
  env: NodeJS.ProcessEnv = process.env,
): Promise<number> {
  const context: SubcommandContext = {
    logDir: defaultLogDir(),
    cwd: process.cwd(),
    env,
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
