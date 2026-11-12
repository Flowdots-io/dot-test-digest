import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterAll, it, vi } from "vitest";
import { main, type MainDeps } from "../../src/index.js";
import type { DigestEnvelope, FailureCluster } from "../../src/types/schema.js";
import { clustersOf } from "./digest.js";
import { hermeticEnv, markRepositoryRoot } from "./hermetic-env.js";

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "node-cart");

const created: string[] = [];

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

export async function runMain(
  argv: readonly string[],
  where: { cwd: string; home: string; deps?: MainDeps },
): Promise<MainRun> {
  const originalCwd = process.cwd();
  const originalHome = process.env["DOT_TEST_DIGEST_HOME"];
  const originalConfigHome = process.env["XDG_CONFIG_HOME"];
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
  // The user's own config file must never reach a test: an empty config home stands in for it.
  process.env["XDG_CONFIG_HOME"] = path.join(where.home, "config-home");
  try {
    // Color follows the terminal; a test sees a pipe unless it says otherwise.
    const code = await main([...argv], { stdoutIsTTY: false, env: hermeticEnv(), ...where.deps });
    return { stdout, stderr, code };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env["DOT_TEST_DIGEST_HOME"];
    else process.env["DOT_TEST_DIGEST_HOME"] = originalHome;
    if (originalConfigHome === undefined) delete process.env["XDG_CONFIG_HOME"];
    else process.env["XDG_CONFIG_HOME"] = originalConfigHome;
  }
}

export type CartArgs = readonly string[] | ((dir: string) => readonly string[]);

export interface CartOptions {
  subdir?: string;
  files?: Readonly<Record<string, string>>;
  deps?: MainDeps;
}

export interface CartRun {
  stdout: string;
  stderr: string;
  code: number;
  dir: string;
  home: string;
}

/** The child's stdout is a pipe, so node defaults to its TAP reporter. */
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

export async function runInCart(
  flags: readonly string[],
  command: CartArgs,
  options: CartOptions = {},
): Promise<CartRun> {
  const dir = tempDir("dtd-node-cart-");
  const home = tempDir("dtd-node-cart-home-");
  fs.cpSync(FIXTURE, dir, { recursive: true });
  markRepositoryRoot(dir);
  for (const [relative, contents] of Object.entries(options.files ?? {})) {
    fs.mkdirSync(path.dirname(path.join(dir, relative)), { recursive: true });
    fs.writeFileSync(path.join(dir, relative), contents);
  }

  const realDir = fs.realpathSync(dir);
  const cwd = options.subdir === undefined ? dir : path.join(dir, options.subdir);
  fs.mkdirSync(cwd, { recursive: true });
  const argv = typeof command === "function" ? command(realDir) : command;
  const run = await runMain([...flags, "--", ...argv], { cwd, home, ...(options.deps ? { deps: options.deps } : {}) });
  return { ...run, dir: realDir, home };
}

export const RED: readonly string[] = ["--tdd-phase=red"];
export const SPEC = "--test-reporter=spec";
export const MODULE_NOT_FOUND = "Error: Cannot find module '";
export const MISSING_EXPORT_MESSAGE =
  "SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'";

export function source(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

export type Reporter = "tap" | "spec";
export const REPORTERS: readonly Reporter[] = ["tap", "spec"];

/** TAP is node's default when its stdout is a pipe. */
export function reporterFlag(reporter: Reporter): string[] {
  return reporter === "spec" ? [SPEC] : [];
}

/** One test per reporter from one body; `titles` keeps each reporter's own title. */
export function eachReporter(
  titles: Readonly<Record<Reporter, string>>,
  body: (reporter: Reporter) => Promise<void>,
): void {
  for (const reporter of REPORTERS) it(titles[reporter], () => body(reporter));
}

export interface JsonRun {
  run: CartRun;
  envelope: DigestEnvelope;
}

export function jsonOf(run: CartRun): JsonRun {
  return { run, envelope: JSON.parse(run.stdout) as DigestEnvelope };
}

export async function runJson(
  args: CartArgs,
  options: CartOptions & { flags?: readonly string[] } = {},
): Promise<JsonRun> {
  const { flags = [], ...cart } = options;
  return jsonOf(await runNodeCart(["--no-jev", "--format=json", ...flags], args, cart));
}

export function clusterOf(envelope: DigestEnvelope, test: string): FailureCluster | undefined {
  return clustersOf(envelope).find((c) => c.sample_tests.includes(test));
}

/** The script that runs `node --test` once per file, so one stream holds several runs, each with its own summary. */
export function nodeRunsWrapperSource(
  reporter: Reporter,
  files: readonly string[],
  epilogue?: string,
): string {
  return source(
    "import { spawnSync } from 'node:child_process';",
    "let status = 0;",
    `for (const file of ${JSON.stringify(files)}) {`,
    `  const run = spawnSync(process.execPath, ['--test', '--test-reporter=${reporter}', file], { stdio: 'inherit' });`,
    "  status = status || (run.status ?? 1);",
    "}",
    ...(epilogue === undefined ? [] : [epilogue]),
    "process.exit(status);",
  );
}

/** One node run per file of `runs` (cart files, or the ones `options.files` adds) in one stream. */
export async function nodeRunsWrapper(
  reporter: Reporter,
  runs: readonly string[],
  options: { flags?: readonly string[]; epilogue?: string; files?: Readonly<Record<string, string>> } = {},
): Promise<JsonRun> {
  const files = { "wrapper.js": nodeRunsWrapperSource(reporter, runs, options.epilogue), ...options.files };
  const flags = ["--no-jev", "--format=json", ...(options.flags ?? [])];
  return jsonOf(await runInCart(flags, [process.execPath, "wrapper.js"], { files }));
}
