import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, expect } from "vitest";
import { hermeticEnv, markRepositoryRoot } from "./hermetic-env.js";

const ROOT = path.resolve(import.meta.dirname, "..", "..");
const CACHE = path.join(ROOT, "node_modules", ".cache");

export interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

export interface BuiltCli {
  /** Runs the built CLI in `cwd` with a fresh home under it; `nodeFlags` go to the node that runs the CLI. */
  run(
    nodeFlags: readonly string[],
    args: readonly string[],
    cwd: string,
    env?: NodeJS.ProcessEnv,
    options?: { closeStderr?: boolean },
  ): Promise<Spawned>;
  /** A new working directory that is its own repository. */
  freshDir(prefix: string): string;
}

/** Builds `src/` into a temp directory under `node_modules/.cache` before the file's tests, and removes it after. */
export function useBuiltCli(name: string): BuiltCli {
  let build = "";
  let work = "";

  beforeAll(() => {
    fs.mkdirSync(CACHE, { recursive: true });
    build = fs.mkdtempSync(path.join(CACHE, `${name}-`));
    fs.writeFileSync(path.join(build, "package.json"), '{"type":"module"}');
    const tsc = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--outDir", build], {
      cwd: ROOT,
      encoding: "utf8",
    });
    expect(tsc.status, tsc.stdout).toBe(0);
    work = fs.mkdtempSync(path.join(tmpdir(), `dtd-${name}-`));
  }, 60_000);

  afterAll(() => {
    fs.rmSync(build, { recursive: true, force: true });
    fs.rmSync(work, { recursive: true, force: true });
  });

  return {
    run(nodeFlags, args, cwd, env = {}, options = {}) {
      const startedAt = Date.now();
      return new Promise((done, fail) => {
        const child = spawn(process.execPath, [...nodeFlags, path.join(build, "index.js"), ...args], {
          cwd,
          stdio: "pipe",
          env: {
            ...hermeticEnv(),
            DOT_TEST_DIGEST_HOME: path.join(cwd, "home"),
            XDG_CONFIG_HOME: path.join(cwd, "config-home"),
            ...env,
          },
        });
        let stdout = "";
        let stderr = "";
        child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
        // A reader that went away, as `2>&-` or a closed pipe would leave it.
        if (options.closeStderr === true) child.stderr.destroy();
        else child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
        child.on("error", fail);
        child.on("close", (code) => done({ code, stdout, stderr, ms: Date.now() - startedAt }));
      });
    },
    freshDir(prefix) {
      const dir = fs.mkdtempSync(path.join(work, prefix));
      markRepositoryRoot(dir);
      return dir;
    },
  };
}
