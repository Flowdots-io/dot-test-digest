#!/usr/bin/env node
import { realpathSync } from "node:fs";
import { pathToFileURL } from "node:url";
import { runSubcommand, type SubcommandDeps } from "./cli/dispatch.js";
import { runWrapped } from "./cli/run.js";
import { isSubcommandName } from "./cli/subcommands.js";

/** Injection points for tests; each defaults to the process's own (production builds a JevClient inside triageUnstructured). */
export type MainDeps = SubcommandDeps;

export async function main(argv: readonly string[], deps: MainDeps = {}): Promise<number> {
  const [first, ...rest] = argv;
  const env = deps.env ?? process.env;
  if (first !== undefined && isSubcommandName(first)) return runSubcommand(first, rest, { ...deps, env });
  const result = await runWrapped(argv, deps, {
    cwd: process.cwd(),
    env,
    stdout: (text) => process.stdout.write(text),
    stderr: (text) => process.stderr.write(text),
  });
  return result.exitCode;
}

/** True when this module is the process entrypoint, also when the bin is reached through a symlink. Never throws. */
function isEntrypoint(entry: string | undefined): boolean {
  if (entry === undefined) return false;
  try {
    return import.meta.url === pathToFileURL(realpathSync(entry)).href;
  } catch {
    return false;
  }
}

/** A reader that closed stdout (`| head`) or stderr early misses that stream; the exit code and the log stay (INV-3). */
function ignoreClosedPipe(error: NodeJS.ErrnoException): void {
  if (error.code !== "EPIPE") throw error;
}

if (isEntrypoint(process.argv[1])) {
  process.stdout.on("error", ignoreClosedPipe);
  process.stderr.on("error", ignoreClosedPipe);
  void main(process.argv.slice(2)).then((code) => {
    process.exitCode = code;
  });
}
