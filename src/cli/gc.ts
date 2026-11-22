import { pruneCache, type PruneOptions } from "../cache/prune.js";
import { loadConfig } from "../config/load.js";
import { cacheRoot } from "../runner/raw-log.js";
import type { Subcommand } from "./dispatch.js";
import { UsageError } from "./errors.js";

const NUMBER_FLAGS = {
  "--keep": "keepRuns",
  "--max-age-days": "maxAgeDays",
  "--state-max-age-days": "stateMaxAgeDays",
} as const satisfies Record<string, keyof PruneOptions>;

type NumberFlag = keyof typeof NUMBER_FLAGS;

function isNumberFlag(flag: string): flag is NumberFlag {
  return Object.hasOwn(NUMBER_FLAGS, flag);
}

function nonNegative(flag: string, raw: string | undefined): number {
  if (raw === undefined || !/^\d+$/.test(raw)) {
    throw new UsageError(`${flag} must be a non-negative integer, got ${raw ?? "nothing"}`);
  }
  return Number(raw);
}

/** `gc [--keep N] [--max-age-days D] [--state-max-age-days D] [--dry-run]`; the defaults are the retention settings. */
export const runGc: Subcommand = (args, context) => {
  const config = loadConfig({ cwd: context.cwd, env: context.env });
  for (const warning of config.warnings) context.warn(warning);
  const options: PruneOptions = {
    keepRuns: config.values["retention.keepRuns"],
    maxAgeDays: config.values["retention.maxAgeDays"],
    stateMaxAgeDays: config.values["retention.stateMaxAgeDays"],
  };

  for (let index = 0; index < args.length; index += 1) {
    const arg = args[index] ?? "";
    const equals = arg.indexOf("=");
    const flag = equals === -1 ? arg : arg.slice(0, equals);
    const inline = equals === -1 ? undefined : arg.slice(equals + 1);
    if (flag === "--dry-run" && inline === undefined) {
      options.dryRun = true;
    } else if (isNumberFlag(flag)) {
      const raw = inline ?? args[(index += 1)];
      options[NUMBER_FLAGS[flag]] = nonNegative(flag, raw);
    } else {
      throw new UsageError(`unknown gc argument: ${arg}`);
    }
  }

  const result = pruneCache(cacheRoot(), options);
  const counts = `${result.removedRuns} runs (${result.removedStates} state files)`;
  context.write(
    options.dryRun === true
      ? `would remove ${counts}, keeping ${result.keptRuns} runs\n`
      : `removed ${counts}, kept ${result.keptRuns} runs\n`,
  );
  return 0;
};
