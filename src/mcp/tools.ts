import fs from "node:fs";
import { runWrapped } from "../cli/run.js";
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

export interface RunTestsArgs {
  command: string[];
  cwd?: string | undefined;
  format?: "compact-md" | "json" | undefined;
  max_clusters?: number | undefined;
  context_lines?: number | undefined;
  tdd_phase?: "red" | "green" | "refactor" | "none" | undefined;
  timeout_seconds?: number | undefined;
}

export const DEFAULT_TIMEOUT_SECONDS = 300;

const NOT_YET: ToolOutcome = { text: "not available in this version", isError: true };

function failure(text: string): ToolOutcome {
  return { text, isError: true };
}

/** The CLI flags a `run_tests` call sets; the rest come from the configuration, as for a wrapped run. */
function flagsOf(args: RunTestsArgs): string[] {
  const flags: [string, string | number | undefined][] = [
    ["--format", args.format],
    ["--max-clusters", args.max_clusters],
    ["--context-lines", args.context_lines],
    ["--tdd-phase", args.tdd_phase],
  ];
  return flags.flatMap(([flag, value]) => (value === undefined ? [] : [`${flag}=${value}`]));
}

export class McpTools {
  private readonly realRoot: string;

  constructor(readonly options: ToolsOptions) {
    this.realRoot = fs.realpathSync(options.root);
  }

  /** Runs an allowed command as `dot-test-digest [flags] -- <command>` would, in process; nothing else starts a process. */
  async runTests(args: RunTestsArgs): Promise<ToolOutcome> {
    const { allow, root, env } = this.options;
    if (!isAllowed(args.command, allow)) return failure(notAllowedMessage(args.command, allow));
    let cwd = root;
    if (args.cwd !== undefined) {
      const checked = resolveCwd(this.realRoot, args.cwd);
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

  showLog(_args: object): ToolOutcome {
    return NOT_YET;
  }

  async replay(_args: object): Promise<ToolOutcome> {
    return NOT_YET;
  }

  listRuns(_args: object): ToolOutcome {
    return NOT_YET;
  }
}
