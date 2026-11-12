import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMain, runNodeCart, tempDir } from "./helpers/node-cart.js";
import { syntheticHome, workDirs } from "./helpers/run-home.js";

const dirs = workDirs("a", "b");

/** Three runs in two directories; the FAIL run is the oldest. */
function threeRuns(): string {
  return syntheticHome([
    { id: "run_stats0001", cwd: dirs.a, createdAt: "2026-11-01T09:00:00Z", record: { raw_bytes: 10000, digest_bytes: 1500, status: "FAIL" } },
    { id: "run_stats0002", cwd: dirs.b, createdAt: "2026-11-01T10:00:00Z", record: { raw_bytes: 4000, digest_bytes: 200, status: "PASS" } },
    { id: "run_stats0003", cwd: dirs.a, createdAt: "2026-11-01T11:00:00Z", record: { raw_bytes: 2000, digest_bytes: 150, status: "PASS" } },
  ]);
}

function stats(args: readonly string[], home: string) {
  return runMain(["stats", ...args], { cwd: dirs.a, home });
}

describe("stats (usage-stats)", () => {
  it("Three recorded runs", async () => {
    const run = await stats([], threeRuns());
    expect(run.stdout).toBe(
      [
        "runs: 3",
        "raw bytes: 16000",
        "digest bytes: 1850",
        "saved: 14150 bytes (88.4%), about 3538 tokens",
        "status: FAIL 1, PASS 2",
        "",
      ].join("\n"),
    );
    expect(run.code).toBe(0);
  });

  it("stats as JSON", async () => {
    const run = await stats(["--json"], threeRuns());
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      runs: 3,
      raw_bytes: 16000,
      digest_bytes: 1850,
      saved_bytes: 14150,
      saved_percent: 88.4,
      estimated_tokens_saved: 3538,
      statuses: { FAIL: 1, PASS: 2 },
    });
  });

  it("Only the newest runs", async () => {
    const run = await stats(["--last", "2"], threeRuns());
    expect(run.stdout).toBe(
      ["runs: 2", "raw bytes: 6000", "digest bytes: 350", "saved: 5650 bytes (94.2%), about 1413 tokens", "status: PASS 2", ""].join(
        "\n",
      ),
    );
    expect(run.code).toBe(0);
  });

  it("A digest larger than its raw output does not count as negative tokens", async () => {
    const home = syntheticHome([
      { id: "run_bigger01", cwd: dirs.a, createdAt: "2026-11-01T09:00:00Z", record: { raw_bytes: 100, digest_bytes: 130 } },
    ]);
    const run = await stats([], home);
    expect(run.stdout.split("\n")).toContain("saved: -30 bytes (-30.0%), about 0 tokens");
    expect(run.code).toBe(0);
  });

  it("No records", async () => {
    const run = await stats([], tempDir("dtd-stats-empty-"));
    expect(run.stdout).toBe("runs: 0\n");
    expect(run.code).toBe(0);
  });

  it("No records as JSON", async () => {
    const run = await stats(["--json"], tempDir("dtd-stats-empty-"));
    expect(run.code).toBe(0);
    expect(JSON.parse(run.stdout)).toEqual({
      runs: 0,
      raw_bytes: 0,
      digest_bytes: 0,
      saved_bytes: 0,
      saved_percent: 0,
      estimated_tokens_saved: 0,
      statuses: {},
    });
  });

  it("A real run is counted", async () => {
    const original = await runNodeCart(["--no-jev"], ["cart.test.js"]);
    const run = await runMain(["stats", "--json"], { cwd: original.dir, home: original.home });
    expect(run.code).toBe(0);
    const totals = JSON.parse(run.stdout) as Record<string, unknown>;
    const [log] = fs.readdirSync(path.join(original.home, "logs")).filter((name) => name.endsWith(".log"));
    expect(totals["runs"]).toBe(1);
    expect(totals["raw_bytes"]).toBe(fs.statSync(path.join(original.home, "logs", log ?? "")).size);
    expect(totals["digest_bytes"]).toBe(Buffer.byteLength(original.stdout));
    expect(totals["statuses"]).toEqual({ FAIL: 1 });
  });

  it("A bad --last is a usage error", async () => {
    for (const args of [["--last", "0"], ["--last", "x"], ["--last"], ["--bogus"]]) {
      const run = await stats(args, threeRuns());
      expect(run.code).toBe(64);
      expect(run.stdout).toBe("");
    }
  });
});
