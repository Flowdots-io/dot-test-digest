import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { useBuiltCli } from "./helpers/built-cli.js";

const cli = useBuiltCli("progress");
const FAST_BEATS = { DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS: "300" };
const SLOW_CHILD = ["sh", "-c", "echo a; sleep 1.2; echo b"];
// Long enough that a slow machine still sees several heartbeats after `echo a` has reached the log.
const SLOWER_CHILD = ["sh", "-c", "echo a; sleep 2; echo b"];
const HEARTBEAT = /^dot-test-digest: running\.\.\. (\d+) lines, \d+\.\ds$/;

describe("--progress (spawned)", () => {
  it("A closed stderr does not change the exit code or lose the digest", async () => {
    const dir = cli.freshDir("closed-stderr-");
    const run = await cli.run(
      [],
      ["--no-jev", "--progress", "--", "sh", "-c", "echo a; sleep 1; exit 3"],
      dir,
      { DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS: "200" },
      { closeStderr: true },
    );
    expect(run.code).toBe(3);
    expect(run.stdout).toMatch(/^\[(FAIL|BUILD_ERROR)\]/);
    const logs = path.join(dir, "home", "logs");
    expect(fs.readdirSync(logs).filter((name) => name.endsWith(".json"))).toHaveLength(1);
  }, 30_000);

  it("Heartbeats while a slow child runs", async () => {
    const run = await cli.run([], ["--no-jev", "--progress", "--", ...SLOWER_CHILD], cli.freshDir("beats-"), FAST_BEATS);
    const beats = run.stderr.split("\n").filter((line) => HEARTBEAT.test(line));
    const counts = beats.map((beat) => Number(HEARTBEAT.exec(beat)?.[1]));
    // A heartbeat that fires before the shell's first `echo` reaches the log may say 0; the count never goes down.
    expect(counts.filter((count) => count >= 1).length, run.stderr).toBeGreaterThanOrEqual(2);
    expect(counts).toEqual([...counts].sort((a, b) => a - b));
    expect(run.stdout).toMatch(/^\[PASS\] exit 0 in \d+ms \| log: \S+\.log\n$/);
    expect(run.code).toBe(0);
  }, 30_000);

  it("Without the flag nothing is printed", async () => {
    const run = await cli.run([], ["--no-jev", "--", ...SLOW_CHILD], cli.freshDir("quiet-"), FAST_BEATS);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  }, 30_000);

  it("Progress never goes to stdout", async () => {
    const run = await cli.run([], ["--no-jev", "--progress", "--format=json", "--", ...SLOW_CHILD], cli.freshDir("json-"), FAST_BEATS);
    expect(run.code, run.stderr).toBe(0);
    expect(() => JSON.parse(run.stdout) as unknown).not.toThrow();
  }, 30_000);
});
