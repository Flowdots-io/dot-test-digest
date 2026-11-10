import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { beforeEach, describe, expect, it } from "vitest";
import { buildEnvelope, estimateTokens, FAIL_BYTE_CEILING, formatEnvelope } from "../src/formatters/envelope.js";
import type { DigestEnvelope, FailureCluster } from "../src/types/schema.js";
import { clustersOf } from "./helpers/digest.js";
import { vitestCascadeOutput } from "./fixtures/generate.js";
import { runMain, runNodeCart, tempDir } from "./helpers/node-cart.js";

const TSC_12 = path.resolve(import.meta.dirname, "fixtures", "logs", "tsc-12.log");

let home: string;
let project: string;
let stdout: string;
let stderr: string;

beforeEach(() => {
  home = tempDir("dtd-home-");
  project = tempDir("dtd-project-");
  stdout = "";
  stderr = "";
});

async function run(argv: readonly string[]): Promise<number> {
  const result = await runMain(argv, { cwd: project, home });
  ({ stdout, stderr } = result);
  return result.code;
}

function replayLog(logPath: string): string[] {
  return [
    process.execPath,
    "-e",
    `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(logPath)},'utf8')); process.exit(2)`,
  ];
}

describe("source-order ranking through the CLI", () => {
  it("--max-clusters keeps the first clusters in source order", async () => {
    const code = await run(["--no-jev", "--format=json", "--max-clusters=5", "--", ...replayLog(TSC_12)]);
    expect(code).toBe(2);
    const envelope = JSON.parse(stdout) as DigestEnvelope;
    expect(clustersOf(envelope).map((c) => c.raw_log_lines)).toEqual([
      "L1-L1",
      "L2-L2",
      "L3-L3",
      "L4-L4",
      "L5-L5",
    ]);
    expect(stderr).toBe("");
  });
});

describe("omitted clusters through the CLI", () => {
  it("lists the clusters beyond --max-clusters and keeps JSON capped", async () => {
    const twelveErrorsUnderBulkyOutput = [
      process.execPath,
      "-e",
      `for (let i = 0; i < 60; i++) console.log('step ' + i + ' ' + 'x'.repeat(60));` +
        `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(TSC_12)},'utf8')); process.exit(2)`,
    ];
    const code = await run(["--no-jev", "--max-clusters=5", "--", ...twelveErrorsUnderBulkyOutput]);
    expect(code).toBe(2);
    const lines = stdout.split("\n");
    expect(lines[0]).toMatch(/\| 5 clusters \|/);
    const footerAt = lines.indexOf("+7 more clusters (see log)");
    expect(footerAt).toBeGreaterThan(0);
    const listed = lines.slice(footerAt + 1).filter((line) => line !== "");
    expect(listed).toHaveLength(7);
    for (const line of listed) {
      expect(line).toMatch(/^ {2}c_[0-9a-f]{8} TYPE_COMPILE_ERROR x1 src\/m\.ts:\d+:1 /);
    }

    stdout = "";
    await run(["--no-jev", "--format=json", "--max-clusters=5", "--", ...twelveErrorsUnderBulkyOutput]);
    const envelope = JSON.parse(stdout) as DigestEnvelope;
    expect(envelope.summary.total_clusters).toBe(5);
    expect(clustersOf(envelope)).toHaveLength(5);
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

  it("When the listing itself does not fit, the tail is only counted", () => {
    const longTest =
      "cart > a test name that is deliberately long so that the omitted-cluster label has to be truncated at eighty bytes";
    const omitted = Array.from({ length: 14 }, (_, i) =>
      omissionCluster({
        cluster_id: `c_2000000${(i + 1).toString(16)}`,
        top_frame: `src/features/module-${i + 1}/handlers/very-long-handler-name.ts:120:40`,
        sample_tests: [longTest],
      }),
    );
    const only = omissionCluster({
      cluster_id: "c_20000000",
      top_frame: "src/cart.ts:3:10",
      message: "AssertionError: expected 100 to be 900",
      raw_log_lines: "L1-L4",
    });
    const out = formatEnvelope(failEnvelope(15, "/tmp/logs/run_d.log", [only]), "compact-md", { omitted });
    const lines = out.split("\n");
    const footerAt = lines.indexOf("+14 more clusters (see log)");
    expect(footerAt).toBeGreaterThan(0);
    const listed = lines.slice(footerAt + 1, -1);
    const label = "cart > a test name that is deliberately long so that the omitted-cluster labe...";
    expect(Buffer.byteLength(label, "utf8")).toBe(80);
    expect(listed).toEqual(
      Array.from(
        { length: 12 },
        (_, i) =>
          `  c_2000000${(i + 1).toString(16)} ASSERTION_FAILURE x1 src/features/module-${i + 1}/handlers/very-long-handler-name.ts:120:40 ${label}`,
      ),
    );
    expect(estimateTokens(out)).toBeLessThanOrEqual(600);
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(FAIL_BYTE_CEILING);
  });

  it("Clusters beyond --max-clusters are listed instead of silently dropped (oversize block: the one kept block alone exceeds the ceiling)", () => {
    const huge = omissionCluster({
      cluster_id: "c_40000000",
      top_frame: "tests/cart.test.ts:7:66",
      message: "AssertionError: expected values to be strictly deep-equal",
      diff: { expected: "e".repeat(3000), received: "r".repeat(3000) },
      sample_tests: ["cart > huge diff"],
      raw_log_lines: "L5-L27",
    });
    const omitted = [
      omissionCluster({ cluster_id: "c_40000001", top_frame: "src/a.ts:1:1", sample_tests: ["cart > second"] }),
      omissionCluster({ cluster_id: "c_40000002", top_frame: "src/b.ts:2:2", sample_tests: ["cart > third"] }),
    ];
    const out = formatEnvelope(failEnvelope(3, "/tmp/logs/run_f.log", [huge]), "compact-md", { omitted });

    const lines = out.split("\n");
    expect(lines[0]).toBe("[FAIL] 3 failed, 0 passed in 10ms | 1 cluster | log: /tmp/logs/run_f.log");
    expect(lines.at(-2)).toBe("+2 more clusters (see log)");
    expect(Buffer.byteLength(out, "utf8")).toBeLessThanOrEqual(FAIL_BYTE_CEILING);
    expect(estimateTokens(out)).toBeLessThanOrEqual(600);
  });
});

describe("omitted-cluster footer at volume", () => {
  it("When the listing itself does not fit, the tail is only counted (5000 omitted clusters)", () => {
    const COUNT = 5000;
    const only = omissionCluster({
      cluster_id: "c_30000000",
      top_frame: "src/cart.ts:3:10",
      message: "AssertionError: expected 100 to be 900",
      raw_log_lines: "L1-L4",
    });
    const omittedLine = (n: number): string =>
      `  c_3${String(n).padStart(7, "0")} TYPE_COMPILE_ERROR x1 src/mod${n}.ts:1:1 TS2322: Type ${n} is not assignable`;
    const omitted = Array.from({ length: COUNT }, (_, i) =>
      omissionCluster({
        cluster_id: `c_3${String(i + 1).padStart(7, "0")}`,
        error_kind: "TYPE_COMPILE_ERROR",
        top_frame: `src/mod${i + 1}.ts:1:1`,
        message: `TS2322: Type ${i + 1} is not assignable`,
      }),
    );

    const base = [
      "[FAIL] 5001 failed, 0 passed in 10ms | 1 cluster | log: /tmp/logs/run_e.log",
      "c_30000000 ASSERTION_FAILURE x1 src/cart.ts:3:10",
      "  AssertionError: expected 100 to be 900",
      "  raw: L1-L4",
      `+${COUNT} more clusters (see log)`,
    ].join("\n");
    let expected = base;
    for (let n = 1; n <= COUNT; n += 1) {
      const next = `${expected}\n${omittedLine(n)}`;
      if (Buffer.byteLength(next, "utf8") > FAIL_BYTE_CEILING) break;
      expected = next;
    }
    const withoutNewline = FAIL_BYTE_CEILING - 1;
    if (Buffer.byteLength(expected, "utf8") > withoutNewline) {
      expected = `${expected.slice(0, withoutNewline - "...".length)}...`;
    }

    const envelope = failEnvelope(COUNT + 1, "/tmp/logs/run_e.log", [only]);
    const started = performance.now();
    const out = formatEnvelope(envelope, "compact-md", { omitted });
    const elapsed = performance.now() - started;

    expect(out).toBe(`${expected}\n`);
    expect(elapsed).toBeLessThan(2000);
  }, 120_000);
});

const HEADER_A = "[FAIL] 1 failed, 0 passed in 10ms | 1 cluster | log: /tmp/logs/run_a.log";

function thresholdEnvelope() {
  return failEnvelope(
    1,
    "/tmp/logs/run_a.log",
    [
      omissionCluster({
        cluster_id: "c_0123abcd",
        top_frame: "src/cart.ts:3:10",
        message: "AssertionError: expected 100 to be 900",
        diff: { expected: "900", received: "100" },
        pruned_stack: ["src/cart.ts:3:10", "at total (src/cart.ts:5:20)"],
        sample_tests: ["cart > discount 10% leaves 90%"],
        raw_log_lines: "L5-L27",
        signal_window: [
          "1 | export const subtotal = (n: number) => n;",
          "2 | export const tax = (n: number) => Math.round(n * 0.21);",
          "3 > export const discount = (n: number, p: number) => n - Math.round((n * p) / 10);",
          "4 | export const total = (n: number) => discount(n, 0) + tax(n);",
          "5 | export const first = (items: string[]) => items[0];",
        ].join("\n"),
      }),
    ],
  );
}

function rawOf(size: number): string {
  return `${"r".repeat(size - 1)}\n`;
}

const BLOCK_HEAD = [
  "c_0123abcd ASSERTION_FAILURE x1 src/cart.ts:3:10",
  "  AssertionError: expected 100 to be 900",
  "  diff: expected 900 / received 100",
];
const BLOCK_STACK = "  at total (src/cart.ts:5:20)";
const BLOCK_WINDOW = [
  "  1 | export const subtotal = (n: number) => n;",
  "  2 | export const tax = (n: number) => Math.round(n * 0.21);",
  "  3 > export const discount = (n: number, p: number) => n - Math.round((n * p) / 10);",
  "  4 | export const total = (n: number) => discount(n, 0) + tax(n);",
  "  5 | export const first = (items: string[]) => items[0];",
];
const BLOCK_TAIL = ["  tests: cart > discount 10% leaves 90%", "  raw: L5-L27"];

const LEVEL_1 = [HEADER_A, ...BLOCK_HEAD, BLOCK_STACK, ...BLOCK_WINDOW, ...BLOCK_TAIL].join("\n") + "\n";
const LEVEL_2 = [HEADER_A, ...BLOCK_HEAD, BLOCK_STACK, ...BLOCK_TAIL].join("\n") + "\n";
const LEVEL_3 = [HEADER_A, ...BLOCK_HEAD, ...BLOCK_TAIL].join("\n") + "\n";
const LEVEL_4 =
  `${HEADER_A}\nc_0123abcd ASSERTION_FAILURE x1 src/cart.ts:3:10 L5-L27 AssertionError: expected 100 to be 900\n`;

const TSC_SMALL = path.resolve(import.meta.dirname, "fixtures", "tsc-small");

function useTscSmall(): string {
  fs.cpSync(TSC_SMALL, project, { recursive: true });
  return fs.readFileSync(path.join(project, "tsc.log"), "utf8");
}

const REPLAY_TSC_LOG = [
  process.execPath,
  "-e",
  "process.stdout.write(require('node:fs').readFileSync('tsc.log','utf8')); process.exit(2)",
];

describe("the size rule through the CLI", () => {
  it("Five tsc errors print the raw diagnostics under the header", async () => {
    const tscLog = useTscSmall();
    expect(Buffer.byteLength(tscLog, "utf8")).toBe(419);
    const code = await run(["--no-jev", "--", ...REPLAY_TSC_LOG]);
    expect(code).toBe(2);
    const newline = stdout.indexOf("\n");
    expect(stdout.slice(0, newline)).toMatch(
      /^\[FAIL\] 5 failed, 0 passed in \d+ms \| 5 clusters \| log: \S+\.log$/,
    );
    expect(stdout.slice(newline + 1)).toBe(tscLog);
    expect(Buffer.byteLength(stdout, "utf8")).toBe(419 + newline + 1);
  });

  it("Large raw output keeps the full form and INV-2", async () => {
    fs.mkdirSync(path.join(project, "src", "auth"), { recursive: true });
    const source = Array.from({ length: 32 }, (_, index) => `const line${index + 1} = ${index + 1};`);
    source[27] = "  return parts.split('.');";
    fs.writeFileSync(path.join(project, "src", "auth", "jwt.ts"), `${source.join("\n")}\n`);
    const child = path.join(project, "cascade.mjs");
    fs.writeFileSync(
      child,
      `process.stdout.write(${JSON.stringify(vitestCascadeOutput(50, 35))}); process.exit(1);`,
    );
    const code = await run(["--", process.execPath, child]);
    expect(code).toBe(1);
    expect(stdout).toContain("RUNTIME_EXCEPTION x50");
    expect(stdout.split("\n")).toContain("  28 >   return parts.split('.');");
    expect(estimateTokens(stdout)).toBeLessThanOrEqual(600);
  });

  it("The JSON envelope of the same run is unchanged", async () => {
    useTscSmall();
    const code = await run(["--no-jev", "--format=json", "--", ...REPLAY_TSC_LOG]);
    expect(code).toBe(2);
    const envelope = JSON.parse(stdout) as DigestEnvelope;
    expect(envelope.summary.total_clusters).toBe(5);
    expect(clustersOf(envelope)).toHaveLength(5);
    for (const cluster of clustersOf(envelope)) expect(cluster.signal_window).not.toBe("");
    expect(clustersOf(envelope)[0]?.top_frame).toBe("src/a.ts:2:14");
    expect(clustersOf(envelope)[0]?.pruned_stack).toEqual(["src/a.ts:2:14"]);
  });

  it("Level 5 has no footer even when --max-clusters cut clusters", async () => {
    const tscLog = useTscSmall();
    const code = await run(["--no-jev", "--max-clusters=2", "--", ...REPLAY_TSC_LOG]);
    expect(code).toBe(2);
    const newline = stdout.indexOf("\n");
    expect(stdout.slice(0, newline)).toMatch(
      /^\[FAIL\] 5 failed, 0 passed in \d+ms \| 2 clusters \| log: \S+\.log$/,
    );
    expect(stdout.slice(newline + 1)).toBe(tscLog);
    expect(stdout).not.toContain("more clusters");

    stdout = "";
    const jsonCode = await run(["--no-jev", "--max-clusters=2", "--format=json", "--", ...REPLAY_TSC_LOG]);
    expect(jsonCode).toBe(2);
    const envelope = JSON.parse(stdout) as DigestEnvelope;
    expect(envelope.status).toBe("FAIL");
    expect(envelope.summary).toEqual({ passed: 0, failed: 5, skipped: 0, total_clusters: 2 });
    expect(clustersOf(envelope).map((c) => [c.cluster_id, c.top_frame, c.raw_log_lines])).toEqual([
      ["c_42a23d40", "src/a.ts:2:14", "L1-L1"],
      ["c_39d5c117", "src/a.ts:3:31", "L2-L2"],
    ]);
  });
});

describe("tiny failures through the CLI", () => {
  it("A failure with no output prints only the header", async () => {
    const code = await run(["--no-jev", "--", process.execPath, "-e", "process.exit(3)"]);
    expect(code).toBe(3);
    expect(stdout).toMatch(/^\[BUILD_ERROR\] 0 failed, 0 passed in \d+ms \| 1 cluster \| log: \S+\.log\n$/);

    stdout = "";
    const jsonCode = await run(["--no-jev", "--format=json", "--", process.execPath, "-e", "process.exit(3)"]);
    expect(jsonCode).toBe(3);
    const envelope = JSON.parse(stdout) as DigestEnvelope;
    expect(clustersOf(envelope).map((c) => c.error_kind)).toEqual(["UNSTRUCTURED_BUILD_ERROR"]);
  });

  it("A tiny unstructured failure prints the header and the raw line", async () => {
    const code = await run(["--no-jev", "--", process.execPath, "-e", "console.log('boom'); process.exit(1)"]);
    expect(code).toBe(1);
    const [header, ...rest] = stdout.split("\n");
    expect(header).toMatch(/^\[BUILD_ERROR\] 0 failed, 0 passed in \d+ms \| 1 cluster \| log: \S+\.log$/);
    expect(rest).toEqual(["boom", ""]);
  });
});

function logPointerBytes(header: string): string {
  const pointer = /log: (\S+\.log)$/.exec(header)?.[1] ?? "";
  const resolved = pointer.startsWith("~") ? path.join(os.homedir(), pointer.slice(1)) : pointer;
  return fs.readFileSync(resolved, "utf8");
}

describe("the log pointer", () => {
  it("The log pointer resolves at every level", async () => {
    const tscLog = useTscSmall();
    await run(["--no-jev", "--", ...REPLAY_TSC_LOG]);
    expect(logPointerBytes(stdout.split("\n")[0] ?? "")).toBe(tscLog);

    stdout = "";
    await run(["--no-jev", "--", process.execPath, "-e", "console.log('boom'); process.exit(1)"]);
    expect(logPointerBytes(stdout.split("\n")[0] ?? "")).toBe("boom\n");
  });
});

describe("the size ladder", () => {
  it("Each level is chosen at its exact threshold", () => {
    const envelope = thresholdEnvelope();
    expect(Buffer.byteLength(`${HEADER_A}\n`, "utf8")).toBe(73);
    const at = (size: number) => formatEnvelope(envelope, "compact-md", { rawText: rawOf(size) });

    expect(at(531)).toBe(LEVEL_1);
    expect(Buffer.byteLength(LEVEL_1, "utf8")).toBe(604);
    expect(at(530)).toBe(LEVEL_2);
    expect(Buffer.byteLength(LEVEL_2, "utf8")).toBe(283);
    expect(at(200)).toBe(LEVEL_3);
    expect(Buffer.byteLength(LEVEL_3, "utf8")).toBe(253);
    expect(at(120)).toBe(LEVEL_4);
    expect(Buffer.byteLength(LEVEL_4, "utf8")).toBe(168);
    const level5 = at(60);
    expect(level5).toBe(`${HEADER_A}\n${rawOf(60)}`);
    expect(Buffer.byteLength(level5, "utf8")).toBe(133);
  });
});

describe("the size rule without a render context", () => {
  it("Without raw text the size rule is not applied", () => {
    const out = formatEnvelope(thresholdEnvelope(), "compact-md");
    expect(out).toBe(LEVEL_1);
    expect(Buffer.byteLength(out, "utf8")).toBe(604);
  });
});

describe("a stack row equal to top_frame is not rendered", () => {
  it("The duplicate row is dropped and the other frames stay", () => {
    const envelope = thresholdEnvelope();
    const lines = formatEnvelope(envelope, "compact-md").split("\n");
    expect(lines).not.toContain("  src/cart.ts:3:10");
    expect(lines.filter((line) => line === "  at total (src/cart.ts:5:20)")).toHaveLength(1);
    const json = JSON.parse(formatEnvelope(envelope, "json")) as DigestEnvelope;
    expect(clustersOf(json)[0]?.pruned_stack).toEqual(["src/cart.ts:3:10", "at total (src/cart.ts:5:20)"]);
  });
});

describe("omitted clusters on the real node cart run", () => {
  it("Every failure of the node cart run is visible somewhere", async () => {
    const run = await runNodeCart(["--no-jev"], ["cart.test.js"]);
    const lines = run.stdout.split("\n");

    const listedIds: string[] = [];
    for (const id of ["c_9721831d", "c_6edce10a", "c_fdff652c", "c_53a8182a"]) {
      const starts = lines.filter((line) => line.startsWith(`${id} `) || line.startsWith(`  ${id} `));
      expect(starts, `${id} starts exactly one line`).toHaveLength(1);
      if (starts[0]?.startsWith("  ")) listedIds.push(id);
    }
    if (listedIds.length > 0) {
      expect(lines).toContain(`+${listedIds.length} more clusters (see log)`);
    }
  });

  it("--max-clusters on a real run lists the rest and keeps JSON capped", async () => {
    const run = await runNodeCart(["--no-jev", "--max-clusters=2"], ["cart.test.js"]);
    const lines = run.stdout.split("\n").filter((line) => line !== "");
    expect(lines[0]).toContain("| 2 clusters |");
    expect(lines.slice(-3)).toEqual([
      "+2 more clusters (see log)",
      "  c_fdff652c ASSERTION_FAILURE x1 cart.test.js:9:50 total with 100% off is free",
      "  c_53a8182a RUNTIME_EXCEPTION x1 cart.js:5:42 first of an empty cart is undefined",
    ]);

    const json = await runNodeCart(["--no-jev", "--format=json", "--max-clusters=2"], ["cart.test.js"]);
    const envelope = JSON.parse(json.stdout) as DigestEnvelope;
    expect(clustersOf(envelope).map((c) => c.cluster_id)).toEqual(["c_9721831d", "c_6edce10a"]);
    expect(envelope.summary.total_clusters).toBe(2);
  });

  it("Clusters beyond --max-clusters are listed instead of silently dropped (oversize block: a huge deep-equal diff beside two small failures)", async () => {
    const source = [
      "import test from 'node:test';",
      "import assert from 'node:assert/strict';",
      "const left = Array.from({ length: 300 }, (_, id) => ({ id }));",
      "const right = Array.from({ length: 300 }, (_, id) => ({ id: id + 1 }));",
      "test('big diff', () => { assert.deepStrictEqual(left, right); });",
      "test('small one', () => { assert.equal(1, 2); });",
      "test('small two', () => { assert.equal(3, 4); });",
      "",
    ].join("\n");
    const run = await runNodeCart(["--no-jev"], ["huge-diff.test.js"], {
      files: { "huge-diff.test.js": source },
    });

    expect(run.code).toBe(1);
    expect(Buffer.byteLength(run.stdout, "utf8")).toBeLessThanOrEqual(FAIL_BYTE_CEILING);
    const lines = run.stdout.split("\n");
    expect(lines[0]).toMatch(/^\[FAIL\] 3 failed, 0 passed in \d+ms \| 1 cluster \| log: /);
    expect(lines.at(-2)).toBe("+2 more clusters (see log)");
  });
});
