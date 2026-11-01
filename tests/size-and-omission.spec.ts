import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { buildEnvelope, estimateTokens, formatEnvelope } from "../src/formatters/envelope.js";
import { main } from "../src/index.js";
import type { FailureCluster } from "../src/types/schema.js";

const TSC_12 = path.resolve(import.meta.dirname, "fixtures", "logs", "tsc-12.log");

let originalCwd: string;
let home: string;
let project: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  originalCwd = process.cwd();
  home = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-home-"));
  project = fs.mkdtempSync(path.join(os.tmpdir(), "dtd-project-"));
  process.env["DOT_TEST_DIGEST_HOME"] = home;
  process.chdir(project);
  stdout = "";
  stderr = "";
  vi.spyOn(process.stdout, "write").mockImplementation((chunk: string | Uint8Array) => {
    stdout += String(chunk);
    return true;
  });
  vi.spyOn(process.stderr, "write").mockImplementation((chunk: string | Uint8Array) => {
    stderr += String(chunk);
    return true;
  });
});

afterEach(() => {
  vi.restoreAllMocks();
  process.chdir(originalCwd);
  delete process.env["DOT_TEST_DIGEST_HOME"];
});

function replayLog(logPath: string): string[] {
  return [
    process.execPath,
    "-e",
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(logPath)},'utf8')); process.exit(2)`,
  ];
}

describe("source-order ranking through the CLI", () => {
  it("--max-clusters keeps the first clusters in source order", async () => {
    const code = await main(["--no-jev", "--format=json", "--max-clusters=5", "--", ...replayLog(TSC_12)]);
    expect(code).toBe(2);
    const envelope = JSON.parse(stdout) as { clusters: { raw_log_lines: string }[] };
    expect(envelope.clusters.map((c) => c.raw_log_lines)).toEqual([
      "L1-L1",
      "L2-L2",
      "L3-L3",
      "L4-L4",
      "L5-L5",
    ]);
    expect(stderr).toBe("");
  });
});

function omissionCluster(overrides: Partial<FailureCluster> & Pick<FailureCluster, "cluster_id">): FailureCluster {
  return {
    fingerprint: "f".repeat(64),
    error_kind: "ASSERTION_FAILURE",
    affected_count: 1,
    sample_tests: [],
    message: "",
    top_frame: "unknown:0:0",
    pruned_stack: [],
    signal_window: "",
    raw_log_lines: "L1-L1",
    ...overrides,
  };
}

function failEnvelope(failed: number, logPath: string, clusters: FailureCluster[], durationMs = 10) {
  return buildEnvelope({
    status: "FAIL",
    phase: "none",
    exitCode: 1,
    signal: null,
    gear: "GEAR_0_GRAMMAR",
    durationMs,
    counts: { passed: 0, failed, skipped: 0 },
    clusters,
    rawLogPath: logPath,
  });
}

describe("omitted-cluster footer", () => {
  it("Clusters beyond --max-clusters are listed instead of silently dropped", () => {
    const envelope = failEnvelope(4, "/tmp/logs/run_b.log", [
      omissionCluster({
        cluster_id: "c_aaaaaaa1",
        top_frame: "tests/cart.test.ts:7:66",
        message: "AssertionError: expected 100 to be 900",
        sample_tests: ["cart > discount 10% leaves 90%"],
        raw_log_lines: "L5-L27",
      }),
      omissionCluster({
        cluster_id: "c_bbbbbbb2",
        error_kind: "RUNTIME_EXCEPTION",
        top_frame: "src/cart.ts:10:50",
        message: "TypeError: Cannot read properties of undefined (reading 'name')",
        sample_tests: ["cart > first of an empty cart is undefined"],
        raw_log_lines: "L28-L40",
      }),
    ]);
    const omitted = [
      omissionCluster({
        cluster_id: "c_ccccccc3",
        top_frame: "tests/cart.test.ts:9:58",
        sample_tests: ["cart > total without discount"],
      }),
      omissionCluster({
        cluster_id: "c_ddddddd4",
        error_kind: "TYPE_COMPILE_ERROR",
        top_frame: "src/a.ts:2:14",
        message: "TS2322: Type 'number' is not assignable to type 'string'.",
      }),
    ];
    const expected = [
      "[FAIL] 4 failed, 0 passed in 10ms | 2 clusters | log: /tmp/logs/run_b.log",
      "c_aaaaaaa1 ASSERTION_FAILURE x1 tests/cart.test.ts:7:66",
      "  AssertionError: expected 100 to be 900",
      "  tests: cart > discount 10% leaves 90%",
      "  raw: L5-L27",
      "c_bbbbbbb2 RUNTIME_EXCEPTION x1 src/cart.ts:10:50",
      "  TypeError: Cannot read properties of undefined (reading 'name')",
      "  tests: cart > first of an empty cart is undefined",
      "  raw: L28-L40",
      "+2 more clusters (see log)",
      "  c_ccccccc3 ASSERTION_FAILURE x1 tests/cart.test.ts:9:58 cart > total without discount",
      "  c_ddddddd4 TYPE_COMPILE_ERROR x1 src/a.ts:2:14 TS2322: Type 'number' is not assignable to type 'string'.",
    ].join("\n");
    const out = formatEnvelope(envelope, "compact-md", { omitted });
    expect(out).toBe(`${expected}\n`);
    expect(Buffer.byteLength(out, "utf8")).toBe(630);
  });

  it("Clusters dropped by the token budget are listed", () => {
    const clusters = [1, 2, 3, 4, 5].map((n) =>
      omissionCluster({
        cluster_id: `c_1000000${n}`,
        top_frame: `src/mod${n}.ts:10:5`,
        message: `AssertionError: expected ${n} to be 0`,
        sample_tests: [`suite > case ${n}`],
        raw_log_lines: `L${10 * n}-L${10 * n + 5}`,
        signal_window: Array.from({ length: 5 }, (_, row) => `${row}`.padEnd(105, "w")).join("\n"),
      }),
    );
    const out = formatEnvelope(failEnvelope(5, "/tmp/logs/run_c.log", clusters), "compact-md");
    const lines = out.split("\n");
    expect(lines[0]).toBe("[FAIL] 5 failed, 0 passed in 10ms | 3 clusters | log: /tmp/logs/run_c.log");
    expect(lines.filter((line) => line.startsWith("c_"))).toEqual([
      "c_10000001 ASSERTION_FAILURE x1 src/mod1.ts:10:5",
      "c_10000002 ASSERTION_FAILURE x1 src/mod2.ts:10:5",
      "c_10000003 ASSERTION_FAILURE x1 src/mod3.ts:10:5",
    ]);
    expect(lines.slice(-4)).toEqual([
      "+2 more clusters (see log)",
      "  c_10000004 ASSERTION_FAILURE x1 src/mod4.ts:10:5 suite > case 4",
      "  c_10000005 ASSERTION_FAILURE x1 src/mod5.ts:10:5 suite > case 5",
      "",
    ]);
    expect(estimateTokens(out)).toBeLessThanOrEqual(600);
  });
});
