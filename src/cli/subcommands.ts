/** The first bare words that name a subcommand; any other bare first word is a missing `--`. */
export const SUBCOMMANDS = [
  { name: "show", synopsis: "show <run> [range|cluster_id]", summary: "print a run's raw log lines, a range or a cluster's lines (--numbers, --record)" },
  { name: "replay", synopsis: "replay <run>", summary: "print the digest of a recorded run again, without running it (--format, --max-clusters, --context-lines)" },
  { name: "digest", synopsis: "digest <file|->", summary: "digest an existing log file, or stdin" },
  { name: "gc", synopsis: "gc", summary: "delete old runs and state files from the cache (--keep, --max-age-days, --state-max-age-days, --dry-run)" },
  { name: "stats", synopsis: "stats", summary: "total the bytes and tokens the digests saved (--last N, --json)" },
  { name: "doctor", synopsis: "doctor", summary: "check the setup and name the command for the detected runner" },
  { name: "init", synopsis: "init", summary: "write a starter config file" },
  { name: "mcp", synopsis: "mcp", summary: "serve the tools over MCP on stdio" },
  { name: "config", synopsis: "config", summary: "print the effective settings and where each came from" },
  { name: "schema", synopsis: "schema", summary: "print the JSON Schema of the envelope" },
] as const;

export type SubcommandName = (typeof SUBCOMMANDS)[number]["name"];

const NAMES: ReadonlySet<string> = new Set(SUBCOMMANDS.map((command) => command.name));

export function isSubcommandName(word: string): word is SubcommandName {
  return NAMES.has(word);
}
