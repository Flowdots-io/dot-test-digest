import type { ColorMode } from "../types/schema.js";

/** `auto` colors a terminal unless `NO_COLOR` is set or `TERM` is `dumb`. */
export function wantsColor(mode: ColorMode, isTTY: boolean, env: NodeJS.ProcessEnv): boolean {
  if (mode !== "auto") return mode === "always";
  return isTTY && !env["NO_COLOR"] && env["TERM"] !== "dumb";
}
