import { loadConfig } from "../config/load.js";
import { SETTINGS } from "../config/settings.js";
import type { Subcommand } from "./dispatch.js";
import { UsageError } from "./errors.js";

/** One `<key> = <value> (<source>)` line per setting; flags play no part. */
export const runConfig: Subcommand = (args, context) => {
  if (args.length > 0) throw new UsageError("config takes no arguments");
  const config = loadConfig({ cwd: context.cwd, env: context.env });
  for (const warning of config.warnings) context.warn(warning);
  const lines = SETTINGS.filter((spec) => !(spec.hiddenWhenDefault && config.sources[spec.key] === "default")).map(
    (spec) => `${spec.key} = ${spec.kind.show(config.values[spec.key])} (${config.sources[spec.key]})\n`,
  );
  context.write(lines.join(""));
  return 0;
};
