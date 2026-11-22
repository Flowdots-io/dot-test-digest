import { loadConfig } from "../config/load.js";
import type { Subcommand } from "./dispatch.js";
import { UsageError } from "./errors.js";

const MCP_USAGE = 'dot-test-digest mcp [--allow "<word> <word>"]...';

/** Each `--allow` value is one argv prefix, its words separated by single spaces. */
function parseMcpArgs(args: readonly string[]): string[][] {
  const allow: string[][] = [];
  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const value = arg === "--allow" ? args[(index += 1)] : arg.startsWith("--allow=") ? arg.slice("--allow=".length) : null;
    if (value === null) throw new UsageError(`unexpected argument "${arg}": ${MCP_USAGE}`);
    if (value === undefined) throw new UsageError("--allow requires a value");
    const words = value.split(" ");
    if (words.some((word) => word.length === 0)) {
      throw new UsageError(`--allow takes words separated by single spaces, got ${JSON.stringify(value)}`);
    }
    allow.push(words);
  }
  return allow;
}

/**
 * `mcp`: a Model Context Protocol server on stdin and stdout until stdin ends. The SDK is imported here and nowhere
 * else, so a wrapped run never loads it. The allowlist is the user config's `mcp.allow` and the `--allow` arguments:
 * a project file cannot add to it (the loader drops its `mcp` key with a warning).
 */
export const runMcp: Subcommand = async (args, context) => {
  const allow = parseMcpArgs(args);
  const config = loadConfig({ cwd: context.cwd, env: context.env });
  for (const warning of config.warnings) context.warn(warning);
  const { serveMcp } = await import("../mcp/server.js");
  await serveMcp({
    allow: [...config.values["mcp.allow"], ...allow],
    root: context.cwd,
    logDir: context.logDir,
    env: context.env,
    stderr: (text) => process.stderr.write(text),
  });
  return 0;
};
