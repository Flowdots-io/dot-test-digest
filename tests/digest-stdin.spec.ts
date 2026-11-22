import { spawnSync } from "node:child_process";
import { copyFileSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hermeticEnv, markRepositoryRoot } from "./helpers/hermetic-env.js";

const ROOT = resolve(import.meta.dirname, "..");
const CACHE = join(ROOT, "node_modules", ".cache");
const TAP_LOG = "tests/fixtures/logs/node-tap-cart.log";

let build: string;
let work: string;

beforeAll(() => {
  mkdirSync(CACHE, { recursive: true });
  build = mkdtempSync(join(CACHE, "digest-stdin-"));
  writeFileSync(join(build, "package.json"), '{"type":"module"}');
  const tsc = spawnSync(join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--outDir", build], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(tsc.status, tsc.stdout).toBe(0);
  work = mkdtempSync(join(tmpdir(), "dtd-digest-stdin-"));
  markRepositoryRoot(work);
  mkdirSync(join(work, "tests", "fixtures", "logs"), { recursive: true });
  copyFileSync(join(ROOT, TAP_LOG), join(work, TAP_LOG));
}, 60_000);

afterAll(() => {
  rmSync(build, { recursive: true, force: true });
  rmSync(work, { recursive: true, force: true });
});

function digest(args: readonly string[], input?: string) {
  return spawnSync(process.execPath, [join(build, "index.js"), "digest", ...args, "--no-jev"], {
    cwd: work,
    encoding: "utf8",
    ...(input === undefined ? {} : { input }),
    env: { ...hermeticEnv(), DOT_TEST_DIGEST_HOME: join(work, "home"), XDG_CONFIG_HOME: join(work, "xdg") },
  });
}

/** The log path and the run id are the only parts that differ between two digests of the same lines. */
function withoutRunIdentity(stdout: string): string {
  return stdout.replace(/log: \S+\.log/g, "log: <log>").replace(/run_[0-9a-z]+/g, "<run>");
}

describe("digest - (digest-input, spawned)", () => {
  it("digest reads stdin", () => {
    const fromFile = digest([TAP_LOG]);
    const fromStdin = digest(["-"], readFileSync(join(work, TAP_LOG), "utf8"));
    expect(fromFile.status, fromFile.stderr).toBe(1);
    expect(fromStdin.stderr).toBe(fromFile.stderr);
    expect(fromStdin.status).toBe(fromFile.status);
    expect(withoutRunIdentity(fromStdin.stdout)).toBe(withoutRunIdentity(fromFile.stdout));
    expect(fromStdin.stdout).toMatch(/^\[FAIL\] 4 failed, 2 passed/);
  });
});
