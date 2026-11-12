import path from "node:path";

/** What a grammar knows about the test a cluster starts with. */
export interface RerunTarget {
  file?: string | null;
  name?: string | null;
}

/** The runners a grammar's output can come from; a grammar looks only for its own. */
export type Runner = "node" | "vitest" | "jest" | "pytest" | "cargo" | "go" | "eslint";

/**
 * The runner and the command's words up to and including its token (`node --test` for node). A word with
 * whitespace is a script for a shell (`sh -c "... vitest"`), never a runner, even when its basename is one.
 */
function findRunner(
  command: readonly string[],
  runners: readonly Runner[],
): { runner: Runner; prefix: readonly string[] } | null {
  for (const [index, word] of command.entries()) {
    if (/\s/.test(word)) continue;
    const base = path.basename(word);
    if (base === "node") {
      if (!runners.includes("node")) continue;
      let flag = index + 1;
      while (command[flag]?.startsWith("-") === true && command[flag] !== "--test") flag += 1;
      if (command[flag] === "--test") return { runner: "node", prefix: command.slice(0, flag + 1) };
    } else if ((runners as readonly string[]).includes(base)) {
      return { runner: base as Runner, prefix: command.slice(0, index + 1) };
    }
  }
  return null;
}

function escapeRegExp(text: string): string {
  return text.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** A `-t` value that cannot be read as a flag: a leading `-` becomes `\-`, which the pattern still matches as `-`. */
function testPattern(leaf: string): string {
  const pattern = escapeRegExp(leaf);
  return pattern.startsWith("-") ? `\\${pattern}` : pattern;
}

const SHELL_SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** POSIX shell quoting: single quotes, an embedded `'` written `'\''`. */
function quote(word: string): string {
  return SHELL_SAFE.test(word) ? word : `'${word.replaceAll("'", "'\\''")}'`;
}

/** The arguments after the prefix that select one test, or `null` when the target lacks what the runner needs. */
function selector(runner: Runner, file: string | undefined, name: string | undefined): string[] | null {
  const leaf = name?.split(" > ").at(-1);
  switch (runner) {
    case "node":
      return file && leaf ? ["--test-name-pattern", `^${escapeRegExp(leaf)}$`, file] : null;
    case "vitest":
      return file && leaf ? ["run", file, "-t", testPattern(leaf)] : null;
    case "jest":
      return file && leaf ? [file, "-t", testPattern(leaf)] : null;
    case "pytest":
      return file && name ? [`${file}::${name}`] : null;
    case "cargo":
      return name ? ["test", name, "--", "--exact"] : null;
    case "go":
      return name ? ["test", "-run", `^${escapeRegExp(name)}$`, "./..."] : null;
    case "eslint":
      return file ? [file] : null;
  }
}

/** The shell command that reruns the target alone, or `undefined` when the command has no runner token. */
export function rerunFor(
  command: readonly string[],
  runners: readonly Runner[],
  target: RerunTarget,
): string | undefined {
  const found = findRunner(command, runners);
  if (found === null) return undefined;
  const args = selector(found.runner, target.file ?? undefined, target.name ?? undefined);
  return args === null ? undefined : [...found.prefix, ...args].map(quote).join(" ");
}
