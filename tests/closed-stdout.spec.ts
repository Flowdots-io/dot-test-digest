import { spawn, spawnSync } from "node:child_process";
import { mkdirSync, mkdtempSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";

const ROOT = resolve(import.meta.dirname, "..");
const CACHE = join(ROOT, "node_modules", ".cache");

let build: string;
let work: string;

beforeAll(() => {
  mkdirSync(CACHE, { recursive: true });
  build = mkdtempSync(join(CACHE, "closed-stdout-"));
  writeFileSync(join(build, "package.json"), '{"type":"module"}');
  const tsc = spawnSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--outDir", build], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(tsc.status, tsc.stdout).toBe(0);
  work = mkdtempSync(join(tmpdir(), "dtd-closed-stdout-"));
}, 60_000);

afterAll(() => {
  rmSync(build, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

interface ClosedRun {
  code: number | null;
  stderr: string;
  home: string;
}

/** Spawns the built CLI and destroys the read end of its stdout right away, as `| head -0` would. */
function runWithClosedStdout(script: string): Promise<ClosedRun> {
  const home = mkdtempSync(join(work, "home-"));
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [join(build, "index.js"), "--no-jev", "--", "sh", "-c", script], {
      cwd: work,
      stdio: "pipe",
      env: { ...process.env, DOT_TEST_DIGEST_HOME: home },
    });
    child.stdout.destroy();
    let stderr = "";
    child.stderr.setEncoding("utf8");
    child.stderr.on("data", (chunk: string) => {
      stderr += chunk;
    });
    child.on("error", fail);
    child.on("close", (code) => done({ code, stderr, home }));
  });
}

describe("closed stdout (run-hardening)", () => {
  it("A reader that closes stdout early does not change a failing child's code", async () => {
    const run = await runWithClosedStdout("sleep 1; exit 7");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(7);
    expect(readdirSync(join(run.home, "logs")).filter((name) => /^run_.*\.log$/.test(name))).toHaveLength(1);
  }, 20_000);

  it("A reader that closes stdout early does not change a passing run", async () => {
    const run = await runWithClosedStdout("sleep 1; exit 0");
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  }, 20_000);
});
