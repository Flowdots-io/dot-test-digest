import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { vi } from "vitest";
import { main } from "../../src/index.js";

const FIXTURE = path.join(process.cwd(), "tests", "fixtures", "node-cart");

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
  args: readonly string[],
): Promise<CartRun> {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-node-cart-"));
  const home = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-node-cart-home-"));
  fs.cpSync(FIXTURE, dir, { recursive: true });

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

  process.chdir(dir);
  process.env["DOT_TEST_DIGEST_HOME"] = home;
  try {
    const code = await main([...flags, "--", process.execPath, "--test", ...args]);
    return { stdout, stderr, code, dir: fs.realpathSync(dir), home };
  } finally {
    outSpy.mockRestore();
    errSpy.mockRestore();
    process.chdir(originalCwd);
    if (originalHome === undefined) delete process.env["DOT_TEST_DIGEST_HOME"];
    else process.env["DOT_TEST_DIGEST_HOME"] = originalHome;
  }
}
