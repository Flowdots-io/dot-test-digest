import fs from "node:fs";
import type { Subcommand } from "./dispatch.js";
import { UsageError } from "./errors.js";

/** The package's `schema/` directory sits two levels above both `src/cli/` and `dist/cli/`. */
const SCHEMA_FILE = new URL("../../schema/digest-envelope.schema.json", import.meta.url);

/** `schema`: the JSON Schema of the `--format=json` envelope, as shipped in the package. */
export const runSchema: Subcommand = (args, context) => {
  const [extra] = args;
  if (extra !== undefined) throw new UsageError(`unexpected argument "${extra}": dot-test-digest schema`);
  context.write(fs.readFileSync(SCHEMA_FILE, "utf8"));
  return 0;
};
