import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, vi } from "vitest";
import { main } from "../../src/index.js";

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "node-cart");

const created: string[] = [];

/** A fresh temporary directory, removed when the importing test file finishes. */
export function tempDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), prefix));
  created.push(dir);
  return dir;
}

afterAll(() => {
  for (const dir of created.splice(0)) fs.rmSync(dir, { recursive: true, force: true });
});

export interface MainRun {
  stdout: string;
  stderr: string;
  code: number;
}

/**
 * Runs `main(argv)` in-process (same argv, stdout and exit-code contract as the
 * built bin) from `cwd` with `DOT_TEST_DIGEST_HOME=home`, capturing what it
 * writes. The previous cwd and environment are restored afterwards.
 */
export async function runMain(
  argv: readonly string[],
  where: { cwd: string; home: string },
): Promise<MainRun> {
  const originalCwd = process.cwd();
  const originalHome = process.env["DOT_TEST_DIGEST_HOME"];
  let stdout = "";
  let stderr = "";
  const outSpy = vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  const errSpy = vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });

  process.chdir(where.cwd);
  process.env["DOT_TEST_DIGEST_HOME"] = where.home;
  try {
    const code = await main([...argv]);
    return { stdout, stderr, code };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env["DOT_TEST_DIGEST_HOME"];
    else process.env["DOT_TEST_DIGEST_HOME"] = originalHome;
  }
}

/** Child arguments, or a function of the cart copy's absolute directory (for absolute paths). */
export type CartArgs = readonly string[] | ((dir: string) => readonly string[]);

export interface CartOptions {
  /** Run from this subdirectory of the cart copy (created if missing). */
  subdir?: string;
}

export interface CartRun {
  stdout: string;
  stderr: string;
  code: number;
  /** The temporary copy of the node-cart fixture the run used as cwd. */
  dir: string;
  /** The temporary DOT_TEST_DIGEST_HOME of the run. */
  home: string;
}

/**
 * Runs `dot-test-digest <flags> -- node --test <args>` in-process (same argv,
 * stdout and exit-code contract as the built bin) inside a fresh copy of
 * `tests/fixtures/node-cart/`, with a temporary `DOT_TEST_DIGEST_HOME`. The
 * child's stdout is a pipe, so node picks its TAP reporter unless `args` say
 * otherwise. The previous cwd and environment are restored afterwards.
 */
export async function runNodeCart(
  flags: readonly string[],
  args: CartArgs,
  options: CartOptions = {},
): Promise<CartRun> {
  return runInCart(
    flags,
    (dir) => [process.execPath, "--test", ...(typeof args === "function" ? args(dir) : args)],
    options,
  );
}

/** Like `runNodeCart` but wraps an arbitrary child command, e.g. one that replays a recorded log. */
export async function runInCart(
  flags: readonly string[],
  command: CartArgs,
  options: CartOptions = {},
): Promise<CartRun> {
  const dir = tempDir("dtd-node-cart-");
  const home = tempDir("dtd-node-cart-home-");
  fs.cpSync(FIXTURE, dir, { recursive: true });

  const realDir = fs.realpathSync(dir);
  const cwd = options.subdir === undefined ? dir : path.join(dir, options.subdir);
  fs.mkdirSync(cwd, { recursive: true });
  const argv = typeof command === "function" ? command(realDir) : command;
  const run = await runMain([...flags, "--", ...argv], { cwd, home });
  return { ...run, dir: realDir, home };
}
