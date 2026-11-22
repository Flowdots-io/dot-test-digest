import fs from "node:fs";
import path from "node:path";
import { PROJECT_FILE } from "../config/load.js";
import type { Subcommand } from "./dispatch.js";
import { CliError, EX_CANTCREAT, UsageError } from "./errors.js";

const INIT_USAGE = "dot-test-digest init [--force]";

/** The starter file: the defaults of the settings a project usually tunes. */
export const STARTER_CONFIG = { maxClusters: 5, contextLines: 2, format: "compact-md", noJev: false } as const;

interface InitOptions {
  force: boolean;
}

function parseInitArgs(args: readonly string[]): InitOptions {
  const options: InitOptions = { force: false };
  for (const arg of args) {
    if (arg === "--force") options.force = true;
    else throw new UsageError(`unexpected argument "${arg}": ${INIT_USAGE}`);
  }
  return options;
}

function lstatOrUndefined(file: string): fs.Stats | undefined {
  try {
    return fs.lstatSync(file);
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw error;
  }
}

/**
 * `init [--force]`: writes `.dot-test-digest.json` in the working directory and no other file. It never writes
 * through a symlink (a repository could ship the name as a link to `~/.bashrc`): `--force` removes the link itself.
 */
export const runInit: Subcommand = (args, context) => {
  const options = parseInitArgs(args);
  const file = path.join(context.cwd, PROJECT_FILE);
  const existing = lstatOrUndefined(file);
  if (existing?.isDirectory()) throw new UsageError(`${file} is a directory`);
  if (existing !== undefined && !options.force) {
    throw new UsageError(
      existing.isSymbolicLink()
        ? `${file} is a symlink (use --force to replace the link)`
        : `${file} already exists (use --force to overwrite)`,
    );
  }
  try {
    if (existing !== undefined) fs.unlinkSync(file);
    // `wx` creates the file or fails: no write follows a link, and a file created meanwhile is not overwritten.
    fs.writeFileSync(file, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, { flag: "wx" });
  } catch (error) {
    const code = (error as NodeJS.ErrnoException).code;
    if (code === "EEXIST") throw new UsageError(`${file} already exists (use --force to overwrite)`);
    throw new CliError(`cannot create ${file}: ${code ?? (error as Error).message}`, EX_CANTCREAT);
  }
  context.write(`wrote ${file}\n`);
  return 0;
};
