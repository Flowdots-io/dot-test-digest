import fs from "node:fs";
import path from "node:path";
import { PROJECT_FILE } from "../config/load.js";
import type { Subcommand } from "./dispatch.js";
import { UsageError } from "./errors.js";

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

/** `init [--force]`: writes `.dot-test-digest.json` in the working directory and no other file. */
export const runInit: Subcommand = (args, context) => {
  const options = parseInitArgs(args);
  const file = path.join(context.cwd, PROJECT_FILE);
  try {
    // `wx` refuses an existing file in the same call that creates it, so a concurrent init cannot be overwritten.
    fs.writeFileSync(file, `${JSON.stringify(STARTER_CONFIG, null, 2)}\n`, { flag: options.force ? "w" : "wx" });
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "EEXIST") {
      throw new UsageError(`${file} already exists (use --force to overwrite)`);
    }
    throw error;
  }
  context.write(`wrote ${file}\n`);
  return 0;
};
