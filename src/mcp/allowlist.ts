import fs from "node:fs";
import path from "node:path";
import { isWithin } from "../cli/run-ref.js";

export type ArgvPrefix = readonly string[];

/** True when the command's leading elements equal, one by one, those of an allowed prefix. */
export function isAllowed(command: readonly string[], allow: readonly ArgvPrefix[]): boolean {
  return allow.some(
    (prefix) => prefix.length > 0 && prefix.length <= command.length && prefix.every((word, index) => command[index] === word),
  );
}

export function notAllowedMessage(command: readonly string[], allow: readonly ArgvPrefix[]): string {
  const prefixes = allow.length === 0 ? "none" : allow.map((prefix) => prefix.join(" ")).join(", ");
  return `command not allowed: ${command.join(" ")}; allowed prefixes: ${prefixes}`;
}

export type CwdCheck = { ok: true; dir: string } | { ok: false; message: string };

/**
 * `cwd`, relative to the project root, with every symlink followed, must be the root or a directory below it. The
 * child runs in that real path, not in the link the caller named.
 */
export function resolveCwd(realRoot: string, cwd: string): CwdCheck {
  let dir: string;
  try {
    dir = fs.realpathSync(path.resolve(realRoot, cwd));
  } catch {
    return { ok: false, message: `cwd not found: ${cwd}` };
  }
  if (!isWithin(dir, realRoot)) return { ok: false, message: `cwd outside the project: ${cwd}` };
  if (!fs.statSync(dir).isDirectory()) return { ok: false, message: `cwd is not a directory: ${cwd}` };
  return { ok: true, dir };
}
