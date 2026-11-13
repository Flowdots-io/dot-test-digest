/** What a tool call returns, before the SDK wraps it. */
export interface ToolOutcome {
  text: string;
  isError: boolean;
  structured?: { run_id: string; status: string; exit_code: number };
}

export interface ToolsOptions {
  /** The argv prefixes `run_tests` may run. */
  allow: readonly (readonly string[])[];
  /** The server's working directory: a `cwd` must resolve inside it. */
  root: string;
  logDir: string;
  env: NodeJS.ProcessEnv;
  /** One stderr line, without its newline. */
  warn: (line: string) => void;
}

const NOT_YET: ToolOutcome = { text: "not available in this version", isError: true };

export class McpTools {
  constructor(readonly options: ToolsOptions) {}

  async runTests(_args: object): Promise<ToolOutcome> {
    return NOT_YET;
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
