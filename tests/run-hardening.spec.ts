import { describe, expect, it } from "vitest";
import { PASS_BYTE_CEILING, buildEnvelope, formatEnvelope } from "../src/formatters/envelope.js";
import type { DigestEnvelope } from "../src/types/schema.js";
import { runInCart, runNodeCart, source } from "./helpers/node-cart.js";

const NO_JEV = ["--no-jev"];

function header(stdout: string): string {
  return stdout.split("\n")[0] ?? "";
}

const SKIP_AND_TODO = source(
  'import test from "node:test";',
  'test("a", () => {});',
  'test("b", { skip: true }, () => {});',
  'test("c", { todo: true }, () => {});',
);

const PASS_SKIP_FAIL = source(
  'import test from "node:test";',
  'test("a", () => {});',
  'test("b", { skip: true }, () => {});',
  'test("c", () => { throw new Error("x"); });',
);

const WARNING = "  3:5  warning  'x' is assigned a value but never used  no-unused-vars";
const LINT = source("/abs/src/a.ts", WARNING, WARNING, WARNING);

describe("skipped and warning counts in the header (run-hardening)", () => {
  it("Skipped and todo tests are shown on a pass", async () => {
    const run = await runNodeCart(NO_JEV, ["sk.test.js"], { files: { "sk.test.js": SKIP_AND_TODO } });
    expect(header(run.stdout)).toMatch(/^\[PASS\] 1 passed, 0 failed, 2 skipped in \d+ms \| log: \S+\.log$/);
    expect(run.code).toBe(0);
  });

  it("Skipped tests are shown on a failure", async () => {
    const run = await runNodeCart(NO_JEV, ["f.test.js"], { files: { "f.test.js": PASS_SKIP_FAIL } });
    expect(header(run.stdout)).toMatch(
      /^\[FAIL\] 1 failed, 1 passed, 1 skipped in \d+ms \| 1 cluster \| log: \S+\.log$/,
    );
  });

  it("eslint warnings are warnings, not skipped tests", async () => {
    const command = ["sh", "-c", "cat lint.txt; exit 0"];
    const files = { "lint.txt": LINT };
    const text = await runInCart(NO_JEV, command, { files });
    expect(header(text.stdout)).toMatch(/^\[PASS\] 0 passed, 0 failed, 3 warnings in \d+ms \| log: \S+\.log$/);
    expect(text.code).toBe(0);

    const json = await runInCart([...NO_JEV, "--format=json"], command, { files });
    expect(json.code).toBe(0);
    expect((JSON.parse(json.stdout) as DigestEnvelope).summary).toEqual({
      passed: 0,
      failed: 0,
      skipped: 0,
      warnings: 3,
      total_clusters: 0,
    });
  });

  it("A run with no skipped test is unchanged", async () => {
    const run = await runNodeCart(NO_JEV, ["passing.test.js"]);
    expect(header(run.stdout)).toMatch(/^\[PASS\] 1 passed, 0 failed in \d+ms \| log: \S+\.log$/);
  });

  it("A long pass line still fits the ceiling", () => {
    const home = `/tmp/${"h".repeat(115)}`;
    expect(home).toHaveLength(120);
    const envelope = buildEnvelope({
      status: "PASS",
      phase: "none",
      exitCode: 0,
      signal: null,
      gear: "GEAR_0_GRAMMAR",
      durationMs: 5,
      counts: { passed: 1, failed: 0, skipped: 2, warnings: 3 },
      clusters: [],
      rawLogPath: `${home}/logs/run_mwcuxzpd721a7e36.log`,
    });
    const line = formatEnvelope(envelope, "compact-md");
    expect(line).toMatch(/^\[PASS\] 1 passed, 0 failed, 2 skipped, 3 warnings in 5ms \| log: \/tmp\/h+\.\.\.\n$/);
    expect(Buffer.byteLength(line, "utf8")).toBeLessThanOrEqual(PASS_BYTE_CEILING);
  });
});

describe("count-free pass line (run-hardening)", () => {
  it("A command with no test output", async () => {
    const run = await runInCart(NO_JEV, ["sh", "-c", "echo hi"]);
    expect(header(run.stdout)).toMatch(/^\[PASS\] exit 0 in \d+ms \| log: \S+\.log$/);
    expect(run.code).toBe(0);
  });

  it("The JSON of an unrecognized run is unchanged", async () => {
    const run = await runInCart([...NO_JEV, "--format=json"], ["sh", "-c", "echo hi"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;
    expect(envelope.summary).toEqual({ passed: 0, failed: 0, skipped: 0, total_clusters: 0 });
    expect(envelope.execution_gear).toBe("GEAR_0_HEURISTIC_FALLBACK");
  });

  it("a grammar that counted zero passed and zero failed keeps its counts", async () => {
    const skipOnly = source('import test from "node:test";', 'test("s", { skip: true }, () => {});');
    const run = await runNodeCart(NO_JEV, ["skip.test.js"], { files: { "skip.test.js": skipOnly } });
    expect(header(run.stdout)).toMatch(/^\[PASS\] 0 passed, 0 failed, 1 skipped in \d+ms \| log: \S+\.log$/);
  });
});
