import { describe, expect, it } from "vitest";
import { useBuiltCli } from "./helpers/built-cli.js";

const cli = useBuiltCli("progress");
const FAST_BEATS = { DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS: "300" };
const SLOW_CHILD = ["sh", "-c", "echo a; sleep 1.2; echo b"];
const HEARTBEAT = /^dot-test-digest: running\.\.\. (\d+) lines, \d+\.\ds$/;

describe("--progress (spawned)", () => {
  it("Heartbeats while a slow child runs", async () => {
    const run = await cli.run([], ["--no-jev", "--progress", "--", ...SLOW_CHILD], cli.freshDir("beats-"), FAST_BEATS);
    const beats = run.stderr.split("\n").filter((line) => HEARTBEAT.test(line));
    expect(beats.length, run.stderr).toBeGreaterThanOrEqual(2);
    for (const beat of beats) expect(Number(HEARTBEAT.exec(beat)?.[1])).toBeGreaterThanOrEqual(1);
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
