import fs from "node:fs";
import { Readable } from "node:stream";
import type { Subcommand, SubcommandContext } from "../cli/dispatch.js";
import { CliError } from "../cli/errors.js";
import { runReplay } from "../cli/replay.js";
import { newestFirst } from "../cli/run-ref.js";
import { runWrapped } from "../cli/run.js";
import { runShow } from "../cli/show.js";
import { loadRunRecords } from "../runner/run-record.js";
import type { OutputFormat, TddPhase } from "../types/schema.js";
import { isAllowed, notAllowedMessage, resolveCwd, type ArgvPrefix } from "./allowlist.js";

/** What a tool call returns, before the SDK wraps it. */
export interface ToolOutcome {
  text: string;
  isError: boolean;
  structured?: { run_id: string; status: string; exit_code: number };
}

export interface ToolsOptions {
  /** The argv prefixes `run_tests` may run. */
  allow: readonly ArgvPrefix[];
  /** The server's working directory: a `cwd` must resolve inside it. */
  root: string;
  logDir: string;
  env: NodeJS.ProcessEnv;
  /** Where a run's diagnostics go: never stdout, which carries only protocol messages. */
  stderr: (text: string) => void;
}

/** The digest options a tool passes on as the CLI's flags. */
interface DigestFlags {
  format?: OutputFormat | undefined;
  max_clusters?: number | undefined;
  context_lines?: number | undefined;
  tdd_phase?: TddPhase | undefined;
}

export interface RunTestsArgs extends DigestFlags {
  command: string[];
  cwd?: string | undefined;
  format?: "compact-md" | "json" | undefined;
  timeout_seconds?: number | undefined;
}

export interface ShowLogArgs {
  run: string;
  selector?: string | undefined;
}

export interface ReplayArgs extends Omit<DigestFlags, "tdd_phase"> {
  run: string;
}

export const DEFAULT_TIMEOUT_SECONDS = 300;
export const DEFAULT_LIST_LIMIT = 10;

function failure(text: string): ToolOutcome {
  return { text, isError: true };
}

/** The CLI flags a `run_tests` call sets; the rest come from the configuration, as for a wrapped run. */
function flagsOf(args: DigestFlags): string[] {
  const flags: [string, string | number | undefined][] = [
    ["--format", args.format],
    ["--max-clusters", args.max_clusters],
    ["--context-lines", args.context_lines],
    ["--tdd-phase", args.tdd_phase],
  ];
  return flags.flatMap(([flag, value]) => (value === undefined ? [] : [`${flag}=${value}`]));
}

/** A run reference or a selector never starts with `-`: the subcommand would read it as a flag. */
function positionals(values: readonly (string | undefined)[]): string[] | ToolOutcome {
  const given = values.filter((value): value is string => value !== undefined);
  const flag = given.find((value) => value.startsWith("-"));
  return flag === undefined ? given : failure(`invalid argument ${JSON.stringify(flag)}: it must not start with -`);
}

export class McpTools {
  /** The project: the server's directory, symlinks resolved. Runs are made, listed and found here or below. */
  private readonly root: string;

  constructor(readonly options: ToolsOptions) {
    this.root = fs.realpathSync(options.root);
  }

  /** Runs an allowed command as `dot-test-digest [flags] -- <command>` would, in process; nothing else starts a process. */
  async runTests(args: RunTestsArgs): Promise<ToolOutcome> {
    const { allow, env } = this.options;
    if (!isAllowed(args.command, allow)) return failure(notAllowedMessage(args.command, allow));
    let cwd = this.root;
    if (args.cwd !== undefined) {
      const checked = resolveCwd(this.root, args.cwd);
      if (!checked.ok) return failure(checked.message);
      cwd = checked.dir;
    }

    const timeoutSeconds = args.timeout_seconds ?? DEFAULT_TIMEOUT_SECONDS;
    let stdout = "";
    let stderr = "";
    const result = await runWrapped(
      [...flagsOf(args), "--", ...args.command],
      // A pipe, not a terminal: no color by `auto`, no overwritten heartbeat.
      { stdoutIsTTY: false, stderrIsTTY: false },
      {
        cwd,
        env,
        stdout: (text) => (stdout += text),
        stderr: (text) => {
          stderr += text;
          this.options.stderr(text);
        },
        timeoutMs: timeoutSeconds * 1000,
      },
    );
    if (result.run === undefined) return failure(stderr.trimEnd() || `exit ${result.exitCode}`);
    const structured = { run_id: result.run.runId, status: result.run.status, exit_code: result.exitCode };
    if (result.run.timedOut) return { text: `timed out after ${timeoutSeconds}s\n${stdout}`, isError: true, structured };
    return { text: stdout, isError: false, structured };
  }

  showLog(args: ShowLogArgs): Promise<ToolOutcome> {
    const words = positionals([args.run, args.selector]);
    return Array.isArray(words) ? this.subcommand(runShow, words) : Promise.resolve(words);
  }

  replay(args: ReplayArgs): Promise<ToolOutcome> {
    const words = positionals([args.run]);
    return Array.isArray(words) ? this.subcommand(runReplay, [...words, ...flagsOf(args)]) : Promise.resolve(words);
  }

  /** The newest runs recorded in the server's directory, one `<run_id> <status> <created_at> <command>` line each. */
  listRuns(args: { limit?: number | undefined }): ToolOutcome {
    const lines = loadRunRecords(this.options.logDir)
      .filter((record) => record.cwd === this.root)
      .sort(newestFirst)
      .slice(0, args.limit ?? DEFAULT_LIST_LIMIT)
      .map((record) => `${record.run_id} ${record.status} ${record.created_at} ${record.command.join(" ")}`.trimEnd());
    return { text: lines.length === 0 ? "no run recorded for this directory\n" : `${lines.join("\n")}\n`, isError: false };
  }

  /** What the subcommand prints, as `dot-test-digest <name> <args>` in the server's directory would; its usage or not-found error is an error result. */
  private async subcommand(handler: Subcommand, args: readonly string[]): Promise<ToolOutcome> {
    let text = "";
    const context: SubcommandContext = {
      logDir: this.options.logDir,
      cwd: this.root,
      within: this.root,
      env: this.options.env,
      stdoutIsTTY: false,
      stdinIsTTY: false,
      // stdin carries the protocol; neither subcommand reads it.
      stdin: Readable.from([]),
      finish: {},
      write: (chunk) => (text += chunk),
      warn: (line) => this.options.stderr(`${line}\n`),
    };
    try {
      await handler(args, context);
    } catch (error) {
      if (error instanceof CliError) return failure(error.message);
      throw error;
    }
    return { text, isError: false };
  }
}
