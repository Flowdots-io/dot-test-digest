import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DigestEnvelope, FailureCluster } from "../src/types/schema.js";
import { clustersOf } from "./helpers/digest.js";
import { runInCart, runNodeCart, type CartArgs, type CartOptions, type CartRun } from "./helpers/node-cart.js";

const SYNTAX_MESSAGE =
  "Test failed due to syntax or unresolved module import rather than a behavioral assertion.";
const PASSED_MESSAGE = "New test passed before implementation; expected a failing behavioral assertion.";
const MODULE_NOT_FOUND = "Error: Cannot find module '";
const MISSING_EXPORT_MESSAGE =
  "SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'";
const SPEC = "--test-reporter=spec";

type Reporter = "tap" | "spec";
const REPORTERS: readonly Reporter[] = ["tap", "spec"];

/** TAP is node's default when its stdout is a pipe. */
function reporterFlag(reporter: Reporter): string[] {
  return reporter === "spec" ? [SPEC] : [];
}

/** One test per reporter from one body; `titles` keeps each reporter's own title. */
function eachReporter(titles: Readonly<Record<Reporter, string>>, body: (reporter: Reporter) => Promise<void>): void {
  for (const reporter of REPORTERS) it(titles[reporter], () => body(reporter));
}

function source(...lines: string[]): string {
  return `${lines.join("\n")}\n`;
}

function baselineOf(home: string, scope: string): string[] {
  const raw = fs.readFileSync(path.join(home, `state-${scope}.json`), "utf8");
  return (JSON.parse(raw) as { baseline: string[] }).baseline;
}

interface JsonRun {
  run: CartRun;
  envelope: DigestEnvelope;
}

function jsonOf(run: CartRun): JsonRun {
  return { run, envelope: JSON.parse(run.stdout) as DigestEnvelope };
}

async function runJson(
  args: CartArgs,
  options: CartOptions & { flags?: readonly string[] } = {},
): Promise<JsonRun> {
  const { flags = [], ...cart } = options;
  return jsonOf(await runNodeCart(["--no-jev", "--format=json", ...flags], args, cart));
}

function digestOf(reporter: Reporter, file: string, contents?: string, flags: readonly string[] = []): Promise<JsonRun> {
  const files = contents === undefined ? {} : { [file]: contents };
  return runJson([`--test-reporter=${reporter}`, file], { files, flags });
}

async function bothReporters(file: string, contents?: string): Promise<Record<Reporter, JsonRun>> {
  return { tap: await digestOf("tap", file, contents), spec: await digestOf("spec", file, contents) };
}

/** Two node runs in one stream, each printing its own summary. */
async function nodeRunsWrapper(
  reporter: Reporter,
  tests: Readonly<Record<string, string>>,
  options: { flags?: readonly string[]; epilogue?: string } = {},
): Promise<JsonRun> {
  const wrapper = source(
    "import { spawnSync } from 'node:child_process';",
    "let status = 0;",
    `for (const file of ${JSON.stringify(Object.keys(tests))}) {`,
    `  const run = spawnSync(process.execPath, ['--test', '--test-reporter=${reporter}', file], { stdio: 'inherit' });`,
    "  status = status || (run.status ?? 1);",
    "}",
    ...(options.epilogue === undefined ? [] : [options.epilogue]),
    "process.exit(status);",
  );
  const flags = ["--no-jev", "--format=json", ...(options.flags ?? [])];
  return jsonOf(
    await runInCart(flags, [process.execPath, "wrapper.js"], { files: { "wrapper.js": wrapper, ...tests } }),
  );
}

function expectOneLine(stdout: string, prefix: string): void {
  expect(stdout.trimEnd().split("\n")).toHaveLength(1);
  expect(Buffer.byteLength(stdout.trimEnd())).toBeLessThanOrEqual(160);
  expect(stdout.startsWith(prefix)).toBe(true);
}

/** A run whose fault is a syntax or unresolved import: the red phase is invalid. */
function expectSyntaxFault({ run, envelope }: JsonRun): void {
  expect(run.code).toBe(64);
  expect(envelope.status).toBe("INVALID_RED");
  expect(new Set(clustersOf(envelope).map((c) => c.error_kind))).toEqual(new Set(["SYNTAX_IMPORT_ERROR"]));
  expect(run.stderr).toContain(SYNTAX_MESSAGE);
}

function clusterOf(envelope: DigestEnvelope, test: string): FailureCluster | undefined {
  return clustersOf(envelope).find((c) => c.sample_tests.includes(test));
}

/**
 * Split in two so a failing run does not print the words "SyntaxError: ..." that the digest of this
 * very test run would classify as an invalid red.
 */
function expectUnexpectedEnd(cluster: FailureCluster | undefined): void {
  const prefix = "SyntaxError: ";
  expect(cluster?.message.startsWith(prefix)).toBe(true);
  expect(cluster?.message.slice(prefix.length)).toBe("Unexpected end of input");
}

function totalAffected(envelope: DigestEnvelope): number {
  return clustersOf(envelope).reduce((sum, c) => sum + c.affected_count, 0);
}

const CART_BASELINE = [
  "cart.test.js::discount 10% leaves 90%",
  "cart.test.js::first of an empty cart is undefined",
  "cart.test.js::total with 10% off",
  "cart.test.js::total with 100% off is free",
];

describe("node --test, TAP diagnostic blocks", () => {
  it("The cart run with the default (TAP) reporter yields four distinct clusters", async () => {
    const { run, envelope } = await runJson(["cart.test.js"]);

    expect(run.code).toBe(1);
    expect(envelope.status).toBe("FAIL");
    expect(envelope.execution_gear).toBe("GEAR_0_GRAMMAR");
    expect(envelope.summary).toEqual({ passed: 2, failed: 4, skipped: 0, total_clusters: 4 });

    const view = clustersOf(envelope).map((c) => ({
      cluster_id: c.cluster_id,
      error_kind: c.error_kind,
      affected_count: c.affected_count,
      top_frame: c.top_frame,
      message: c.message,
      diff: c.diff,
      sample_tests: c.sample_tests,
    }));
    expect(view).toEqual([
      {
        cluster_id: "c_9721831d",
        error_kind: "ASSERTION_FAILURE",
        affected_count: 1,
        top_frame: "cart.test.js:7:46",
        message: "AssertionError: Expected values to be strictly equal: 0 !== 900",
        diff: { expected: "900", received: "0" },
        sample_tests: ["discount 10% leaves 90%"],
      },
      {
        cluster_id: "c_6edce10a",
        error_kind: "ASSERTION_FAILURE",
        affected_count: 1,
        top_frame: "cart.test.js:8:41",
        message: "AssertionError: Expected values to be strictly equal: 0 !== 1634",
        diff: { expected: "1634", received: "0" },
        sample_tests: ["total with 10% off"],
      },
      {
        cluster_id: "c_fdff652c",
        error_kind: "ASSERTION_FAILURE",
        affected_count: 1,
        top_frame: "cart.test.js:9:50",
        message: "AssertionError: Expected values to be strictly equal: -16335 !== 0",
        diff: { expected: "0", received: "-16335" },
        sample_tests: ["total with 100% off is free"],
      },
      {
        cluster_id: "c_53a8182a",
        error_kind: "RUNTIME_EXCEPTION",
        affected_count: 1,
        top_frame: "cart.js:5:42",
        message: "TypeError: Cannot read properties of undefined (reading 'name')",
        diff: undefined,
        sample_tests: ["first of an empty cart is undefined"],
      },
    ]);
    for (const cluster of clustersOf(envelope)) {
      expect(cluster.top_frame).not.toBe("unknown:0:0");
      expect(cluster.message).not.toBe("Unknown test failure");
    }
  });

  it("Each node failure gets a SignalWindow from the right file", async () => {
    const { envelope } = await runJson(["cart.test.js"]);
    const byId = (id: string): FailureCluster => {
      const found = clustersOf(envelope).find((c) => c.cluster_id === id);
      if (found === undefined) throw new Error(`no cluster ${id}`);
      return found;
    };

    expect(byId("c_9721831d").signal_window).toContain(
      '7 > test("discount 10% leaves 90%", () => assert.equal(discount(1000, 10), 900));',
    );
    expect(byId("c_53a8182a").signal_window).toBe(
      [
        "3 | export const discount = (n, p) => n - Math.round(n * p / 10); // bug: /10",
        "4 | export const total = (items, p = 0) => { const d = discount(subtotal(items), p); return d + tax(d); };",
        "5 > export const first = (items) => items[0].name;",
      ].join("\n"),
    );
    for (const cluster of clustersOf(envelope)) {
      for (const frame of cluster.pruned_stack) {
        expect(frame).not.toContain("file://");
        expect(frame).not.toContain("node:internal");
      }
    }
  });

  it("The compact-md digest of the cart run no longer merges the failures", async () => {
    const run = await runNodeCart(["--no-jev"], ["cart.test.js"]);

    expect(run.code).toBe(1);
    expect(run.stdout.startsWith("[FAIL] 4 failed, 2 passed in ")).toBe(true);
    expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(2400);
    expect(run.stdout).toContain("diff: expected 900 / received 0");
    expect(run.stdout).not.toContain("unknown:0:0");
    expect(run.stdout).not.toContain("Unknown test failure");
    expect(run.stdout).not.toContain("file://");
    for (const line of run.stdout.split("\n")) {
      expect(line.endsWith("received ")).toBe(false);
    }
  });
});

describe("node --test, nested suite and timeout", () => {
  eachReporter(
    {
      tap: "Nested suite with a deep-equal failure and a timeout",
      spec: "Nested suite and timeout under the spec reporter",
    },
    async (reporter) => {
      const { run, envelope } = await runJson([...reporterFlag(reporter), "suite.test.js"]);

      expect(run.code).toBe(1);
      expect(envelope.summary).toMatchObject({ passed: 1, failed: 3, skipped: 0 });
      expect(clustersOf(envelope).flatMap((c) => c.sample_tests).sort()).toEqual([
        "discount 10% leaves 90%",
        "names match",
        "slow",
      ]);
      expect(totalAffected(envelope)).toBe(3);

      const names = clusterOf(envelope, "names match");
      expect(names?.error_kind).toBe("ASSERTION_FAILURE");
      expect(names?.top_frame).toBe("suite.test.js:7:34");
      expect(names?.message).toBe(
        "AssertionError: Expected values to be strictly deep-equal: + actual - expected { + a: 1 - a: 2 }",
      );
      if (reporter === "tap") expect(names?.diff).toEqual({ expected: "a: 2", received: "a: 1" });

      const slow = clusterOf(envelope, "slow");
      expect(slow?.error_kind).toBe("TIMEOUT_OR_CONN_REFUSED");
      expect(slow?.message).toBe("test timed out after 20ms");
      expect(slow?.top_frame).toBe("unknown:0:0");
      expect(slow?.signal_window).toBe("");
    },
  );
});

describe("node --test, same-named failures", () => {
  eachReporter(
    {
      tap: "Two same-named failing tests in one file stay two failures under TAP",
      spec: "Two same-named failing tests in one file stay two failures under the spec reporter",
    },
    async (reporter) => {
      const { run, envelope } = await runJson([...reporterFlag(reporter), "same-name.test.js"]);

      expect(run.code).toBe(1);
      expect(envelope.summary).toEqual({ passed: 0, failed: 2, skipped: 0, total_clusters: 2 });
      expect(totalAffected(envelope)).toBe(2);
      expect(
        clustersOf(envelope).map((c) => ({
          cluster_id: c.cluster_id,
          error_kind: c.error_kind,
          affected_count: c.affected_count,
          message: c.message,
          top_frame: c.top_frame,
          sample_tests: c.sample_tests,
        })),
      ).toEqual([
        {
          cluster_id: "c_20e326b9",
          error_kind: "ASSERTION_FAILURE",
          affected_count: 1,
          message: "AssertionError: Expected values to be strictly equal: 0 !== 1",
          top_frame: "same-name.test.js:4:36",
          sample_tests: ["handles empty @4"],
        },
        {
          cluster_id: "c_0044f190",
          error_kind: "ASSERTION_FAILURE",
          affected_count: 1,
          message: "AssertionError: Expected values to be strictly equal: 0 !== 1",
          top_frame: "same-name.test.js:7:36",
          sample_tests: ["handles empty @7"],
        },
      ]);

      const red = await runNodeCart(
        ["--no-jev", "--tdd-phase=red", `--scope-id=same-${reporter}`],
        [...reporterFlag(reporter), "same-name.test.js"],
      );
      expect(red.code).toBe(0);
      expect(baselineOf(red.home, `same-${reporter}`).sort()).toEqual([
        "same-name.test.js::handles empty @4",
        "same-name.test.js::handles empty @7",
      ]);
    },
  );
});

describe("node --test, file-level failures", () => {
  eachReporter(
    {
      tap: "A missing module is one SYNTAX_IMPORT_ERROR failure",
      spec: "A missing module under the spec reporter is one SYNTAX_IMPORT_ERROR failure",
    },
    async (reporter) => {
      const { run, envelope } = await runJson([...reporterFlag(reporter), "missing-module.test.js"]);

      expect(run.code).toBe(1);
      expect(envelope.status).toBe("FAIL");
      expect(envelope.summary.failed).toBe(1);
      expect(envelope.summary.total_clusters).toBe(1);
      const cluster = clustersOf(envelope)[0];
      expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
      expect(cluster?.affected_count).toBe(1);
      expect(cluster?.sample_tests).toEqual(["missing-module.test.js"]);
      expect(cluster?.message.startsWith(MODULE_NOT_FOUND)).toBe(true);
      expect(cluster?.message).toContain("missing.js' imported from ");
    },
  );

  eachReporter(
    {
      tap: "A missing export is a RUNTIME_EXCEPTION failure, not a syntax error",
      spec: "A missing export under the spec reporter is a RUNTIME_EXCEPTION failure",
    },
    async (reporter) => {
      const { run, envelope } = await runJson([...reporterFlag(reporter), "missing-export.test.js"]);

      expect(run.code).toBe(1);
      expect(envelope.summary.total_clusters).toBe(1);
      expect(clustersOf(envelope)[0]?.error_kind).toBe("RUNTIME_EXCEPTION");
      expect(clustersOf(envelope)[0]?.message).toBe(MISSING_EXPORT_MESSAGE);
    },
  );

  eachReporter(
    {
      tap: "Two crashing files under TAP each carry their own subprocess error",
      spec: "Two crashing files under the spec reporter each carry their own subprocess error",
    },
    async (reporter) => {
      const files = [...reporterFlag(reporter), "missing-module.test.js", "missing-export.test.js"];
      const { run, envelope } = await runJson(files);

      expect(run.code).toBe(1);
      expect(envelope.status).toBe("FAIL");
      expect(envelope.summary).toEqual({ passed: 0, failed: 2, skipped: 0, total_clusters: 2 });
      expect(totalAffected(envelope)).toBe(2);
      const moduleCluster = clusterOf(envelope, "missing-module.test.js");
      const exportCluster = clusterOf(envelope, "missing-export.test.js");
      expect(moduleCluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
      expect(moduleCluster?.message.startsWith(MODULE_NOT_FOUND)).toBe(true);
      expect(moduleCluster?.message).toContain("missing.js' imported from ");
      expect(moduleCluster?.message.endsWith("/missing-module.test.js")).toBe(true);
      expect(exportCluster?.error_kind).toBe("RUNTIME_EXCEPTION");
      expect(exportCluster?.message).toBe(MISSING_EXPORT_MESSAGE);

      const red = await runNodeCart(["--no-jev", "--tdd-phase=red"], files);
      expect(red.code).toBe(64);
      expect(red.stdout).toContain("INVALID_RED");
      expect(red.stdout).toContain("SYNTAX_IMPORT_ERROR");
    },
  );
});

describe("node --test, which printed line is a crashed file's error", () => {
  const LOG_LINE = 'data:text/javascript,console.log("Error: config.json not found, using defaults")';

  it("A log line above the crash is not mistaken for the file's error", async () => {
    const { run, envelope } = await runJson(["--import", LOG_LINE, "missing-module.test.js"], {
      flags: ["--tdd-phase=red"],
    });

    expect(run.code).toBe(64);
    expect(envelope.status).toBe("INVALID_RED");
    expect(clustersOf(envelope)).toHaveLength(1);
    const cluster = clustersOf(envelope)[0];
    expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(cluster?.sample_tests).toEqual(["missing-module.test.js"]);
    expect(cluster?.message.startsWith(MODULE_NOT_FOUND)).toBe(true);
  });

  it("A syntax error in a test file is attributed to that file under TAP", async () => {
    const { envelope } = await runJson(["missing-module.test.js", "syntax-error.test.js"]);

    const cluster = clusterOf(envelope, "syntax-error.test.js");
    expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expectUnexpectedEnd(cluster);
  });

  it("A syntax error block with blank lines is attributed to its file", async () => {
    const { envelope } = await runJson([SPEC, "missing-module.test.js", "syntax-error.test.js"]);

    const cluster = clusterOf(envelope, "syntax-error.test.js");
    expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expectUnexpectedEnd(cluster);
    expect(clusterOf(envelope, "missing-module.test.js")?.message.startsWith(MODULE_NOT_FOUND)).toBe(true);
  });

  const ONE_RUN_PER_FILE = source(
    'import { spawnSync } from "node:child_process";',
    "const [reporter, ...files] = process.argv.slice(2);",
    "let code = 0;",
    'for (const f of files) { const r = spawnSync(process.execPath, ["--test", "--test-reporter=" + reporter, f], { stdio: "inherit" }); code = code || (r.status ?? 1); }',
    "process.exit(code);",
  );

  eachReporter(
    {
      tap: "A crashed file in a later run of a multi-run stream keeps its error (tap)",
      spec: "A crashed file in a later run of a multi-run stream keeps its error (spec)",
    },
    async (reporter) => {
      const result = jsonOf(
        await runInCart(
          ["--no-jev", "--format=json", "--tdd-phase=red"],
          [process.execPath, "wrap.mjs", reporter, "cart.test.js", "missing-export.test.js"],
          { files: { "wrap.mjs": ONE_RUN_PER_FILE } },
        ),
      );

      expect(result.run.code).toBe(0);
      expect(result.envelope.status).toBe("VALID_RED");
      const cluster = clusterOf(result.envelope, "missing-export.test.js");
      expect(cluster?.error_kind).toBe("RUNTIME_EXCEPTION");
      expect(cluster?.message).toBe(MISSING_EXPORT_MESSAGE);
    },
  );

  eachReporter(
    {
      tap: "A startup crash is not blamed on another run's output (tap)",
      spec: "A startup crash is not blamed on another run's output (spec)",
    },
    async (reporter) => {
      const result = jsonOf(
        await runInCart(
          ["--no-jev", "--format=json", "--tdd-phase=red"],
          [process.execPath, "wrap.mjs", reporter, "exitload.test.js", "logc.test.js"],
          {
            files: {
              "wrap.mjs": ONE_RUN_PER_FILE,
              "exitload.test.js": source("process.exit(1);"),
              "logc.test.js": source(
                'import test from "node:test";',
                'console.log("TypeError: cfg.get is not a function (handled)");',
                'test("x", () => {});',
              ),
            },
          },
        ),
      );

      expect(result.run.code).toBe(64);
      expect(result.envelope.status).toBe("INVALID_RED");
      const cluster = clusterOf(result.envelope, "exitload.test.js");
      expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
      expect(cluster?.message).toBe("test failed");
    },
  );
});

describe("node --test, a runtime error thrown at load keeps its error line", () => {
  eachReporter(
    {
      tap: "A missing export is VALID_RED with exit 0 (a ReferenceError at load time, whose stack frame names the file, tap)",
      spec: "A missing export is VALID_RED with exit 0 (a ReferenceError at load time, whose stack frame names the file, spec)",
    },
    async (reporter) => {
      const { run, envelope } = await runJson([...reporterFlag(reporter), "load-error.test.js"], {
        flags: ["--tdd-phase=red"],
        files: { "load-error.test.js": source("import test from 'node:test';", "notDefinedYet();", "test('x', () => {});") },
      });

      expect(run.code).toBe(0);
      expect(envelope.status).toBe("VALID_RED");
      expect(clustersOf(envelope).map((c) => [c.error_kind, c.message])).toEqual([
        ["RUNTIME_EXCEPTION", "ReferenceError: notDefinedYet is not defined"],
      ]);
    },
  );
});

describe("node --test, a test file the runner cannot read", () => {
  const TITLES: Readonly<Record<Reporter, string>> = {
    tap: "An unreadable test file is INVALID_RED with exit 64",
    spec: "An unreadable test file is INVALID_RED with exit 64 under the spec reporter",
  };

  for (const reporter of REPORTERS) {
    it.skipIf(process.getuid?.() === 0)(TITLES[reporter], async () => {
      let unreadable = "";
      try {
        const { run, envelope } = await runJson(
          (dir) => {
            unreadable = path.join(dir, "noread.test.js");
            fs.chmodSync(unreadable, 0o000);
            return [...reporterFlag(reporter), "noread.test.js"];
          },
          {
            flags: ["--tdd-phase=red"],
            files: { "noread.test.js": source("import test from 'node:test';", "test('x', () => {});") },
          },
        );

        expect(run.code).toBe(64);
        expect(envelope.status).toBe("INVALID_RED");
        expect(clustersOf(envelope)).toHaveLength(1);
        expect(clustersOf(envelope)[0]?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
        expect(clustersOf(envelope)[0]?.message.startsWith("Error: EACCES: permission denied")).toBe(true);
      } finally {
        if (unreadable !== "") fs.chmodSync(unreadable, 0o644);
      }
    });
  }
});

describe("node --test, a read failure of another file at load", () => {
  const TITLES: Readonly<Record<Reporter, string>> = {
    tap: "A read failure of another file at load stays a behavioural red",
    spec: "A read failure of another file at load stays a behavioural red under the spec reporter",
  };

  for (const reporter of REPORTERS) {
    it.skipIf(process.getuid?.() === 0)(TITLES[reporter], async () => {
      let secret = "";
      try {
        const { run, envelope } = await runJson(
          (dir) => {
            secret = path.join(dir, "secret.txt");
            fs.chmodSync(secret, 0o000);
            return [...reporterFlag(reporter), "loadsecret.test.js"];
          },
          {
            flags: ["--tdd-phase=red"],
            files: {
              "secret.txt": "hidden\n",
              "loadsecret.test.js": source(
                "import fs from 'node:fs';",
                "import test from 'node:test';",
                "fs.readFileSync(new URL('./secret.txt', import.meta.url));",
                "test('uses it', () => {});",
              ),
            },
          },
        );

        expect(run.code).toBe(0);
        expect(envelope.status).toBe("VALID_RED");
        expect(clustersOf(envelope)).toHaveLength(1);
        expect(clustersOf(envelope)[0]?.error_kind).toBe("RUNTIME_EXCEPTION");
        expect(clustersOf(envelope)[0]?.message.startsWith("Error: EACCES: permission denied")).toBe(true);
      } finally {
        if (secret !== "") fs.chmodSync(secret, 0o644);
      }
    });
  }
});

describe("node --test, red-phase guards", () => {
  eachReporter(
    {
      tap: "Assertion failures are VALID_RED with exit 0 and the baseline holds canonical ids",
      spec: "Assertion failures are VALID_RED with the real counts",
    },
    async (reporter) => {
      const run = await runNodeCart(
        ["--no-jev", "--tdd-phase=red", `--scope-id=${reporter}-red`],
        [...reporterFlag(reporter), "cart.test.js"],
      );

      expect(run.code).toBe(0);
      expectOneLine(run.stdout, "[VALID_RED | RED] 2 passed, 4 failed in ");
      expect(baselineOf(run.home, `${reporter}-red`).sort()).toEqual(CART_BASELINE);
    },
  );

  eachReporter(
    {
      tap: "A missing module is INVALID_RED with exit 64",
      spec: "A missing module is INVALID_RED with exit 64 and the syntax message",
    },
    async (reporter) => {
      const run = await runNodeCart(["--no-jev", "--tdd-phase=red"], [...reporterFlag(reporter), "missing-module.test.js"]);

      expect(run.code).toBe(64);
      expect(run.stdout).toContain("INVALID_RED");
      expect(run.stdout).toContain("SYNTAX_IMPORT_ERROR");
      expect(run.stderr).toContain(SYNTAX_MESSAGE);
    },
  );

  eachReporter(
    {
      tap: "A missing export is VALID_RED with exit 0",
      spec: "A missing export is VALID_RED with exit 0 under the spec reporter",
    },
    async (reporter) => {
      const run = await runNodeCart(["--no-jev", "--tdd-phase=red"], [...reporterFlag(reporter), "missing-export.test.js"]);

      expect(run.code).toBe(0);
      expect(run.stdout.startsWith("[VALID_RED | RED]")).toBe(true);
    },
  );

  eachReporter(
    {
      tap: "A test that already passes is INVALID_RED with exit 64",
      spec: "A test that already passes is INVALID_RED with exit 64 under the spec reporter",
    },
    async (reporter) => {
      const run = await runNodeCart(["--no-jev", "--tdd-phase=red"], [...reporterFlag(reporter), "passing.test.js"]);

      expect(run.code).toBe(64);
      expect(run.stdout).toContain("INVALID_RED");
      expect(run.stdout).toContain("0 failed, 1 passed");
      expect(run.stderr).toContain(PASSED_MESSAGE);
    },
  );

  eachReporter(
    {
      tap: "A missing module is INVALID_RED with exit 64 (a test file that exits at load time)",
      spec: "A missing module is INVALID_RED with exit 64 and the syntax message (a test file that exits at load time)",
    },
    async (reporter) => {
      expectSyntaxFault(
        await runJson([...reporterFlag(reporter), "exit.test.js"], {
          flags: ["--tdd-phase=red"],
          files: { "exit.test.js": "process.exit(1);\n" },
        }),
      );
    },
  );

  const PATH_FORMS: ReadonlyArray<{
    title: string;
    args: CartArgs;
    options?: CartOptions;
    message?: string;
  }> = [
    {
      title: "absolute path",
      args: (dir) => [SPEC, path.join(dir, "missing-module.test.js")],
      message: "Cannot find module",
    },
    {
      title: "parent-relative path",
      args: [SPEC, "../missing-module.test.js"],
      options: { subdir: "sub" },
      message: "Cannot find module",
    },
    {
      title: "absolute path to a file with a syntax error",
      args: (dir) => [SPEC, path.join(dir, "syntax-error.test.js")],
    },
  ];
  for (const { title, args, options, message } of PATH_FORMS) {
    it(`A missing module is INVALID_RED with exit 64 and the syntax message (${title})`, async () => {
      const result = await runJson(args, { ...options, flags: ["--tdd-phase=red"] });

      expectSyntaxFault(result);
      if (message !== undefined) expect(clustersOf(result.envelope)[0]?.message).toContain(message);
    });
  }

  it("A missing module is INVALID_RED with exit 64 and the syntax message (two files crash through a shared import)", async () => {
    const passing = "import './lib.js'; import test from 'node:test'; test('x',()=>{});\n";
    expectSyntaxFault(
      await runJson([SPEC, "a.test.js", "b.test.js"], {
        flags: ["--tdd-phase=red"],
        files: { "lib.js": "import './missing-helper.js';\n", "a.test.js": passing, "b.test.js": passing },
      }),
    );
  });

  it("A missing module is INVALID_RED with exit 64 and the syntax message (unindented wrapper line after the section)", async () => {
    const { run, envelope } = await nodeRunsWrapper(
      "spec",
      { "mm.test.js": "import './missing.js'; import test from 'node:test'; test('x',()=>{});\n" },
      {
        flags: ["--tdd-phase=red"],
        epilogue: "console.log(' ELIFECYCLE  Test failed. See above for more details.');",
      },
    );

    expect(run.code).toBe(64);
    expect(envelope.status).toBe("INVALID_RED");
    expect(clustersOf(envelope)[0]?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(clustersOf(envelope)[0]?.message.startsWith(MODULE_NOT_FOUND)).toBe(true);
    expect(clustersOf(envelope)[0]?.message).not.toContain("ELIFECYCLE");
  });
});

describe("node --test, exit-code transparency", () => {
  eachReporter(
    {
      tap: "Without a TDD phase the child's exit code passes through",
      spec: "Without a TDD phase the child's exit code passes through under the spec reporter",
    },
    async (reporter) => {
      const failing = await runNodeCart(["--no-jev"], [...reporterFlag(reporter), "cart.test.js"]);
      const passing = await runNodeCart(["--no-jev"], [...reporterFlag(reporter), "passing.test.js"]);

      expect(failing.code).toBe(1);
      expect(passing.code).toBe(0);
      expectOneLine(passing.stdout, "[PASS] 1 passed, 0 failed in ");
    },
  );

  it("A passing spec run is one line with the real count", async () => {
    const run = await runNodeCart(["--no-jev"], [SPEC, "passing.test.js"]);

    expect(run.code).toBe(0);
    expectOneLine(run.stdout, "[PASS] 1 passed, 0 failed in ");
  });
});

describe("node --test, spec reporter recognition", () => {
  it("The cart run with the spec reporter is parsed, not reported as BUILD_ERROR", async () => {
    const { run, envelope } = await runJson([SPEC, "cart.test.js"]);

    expect(run.code).toBe(1);
    expect(envelope.status).toBe("FAIL");
    expect(envelope.execution_gear).toBe("GEAR_0_GRAMMAR");
    expect(envelope.summary).toEqual({ passed: 2, failed: 4, skipped: 0, total_clusters: 4 });
    expect(clustersOf(envelope).map((c) => c.error_kind)).not.toContain("UNSTRUCTURED_BUILD_ERROR");
  });

  it("The compact-md digest of the spec run names the failures", async () => {
    const run = await runNodeCart(["--no-jev"], [SPEC, "cart.test.js"]);

    expect(run.stdout.split("\n")[0]?.startsWith("[FAIL] 4 failed, 2 passed in ")).toBe(true);
    expect(run.stdout).toContain("ASSERTION_FAILURE x1 cart.test.js:7:46");
    expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(2400);
    expect(run.stdout).not.toContain("UNSTRUCTURED_BUILD_ERROR");
    expect(run.stdout).not.toContain("BUILD_ERROR");
    expect(run.stdout).not.toContain("file://");
  });

  it("A spec run cut before the failing-tests section still yields its failures", async () => {
    const log = path.join(process.cwd(), "tests", "fixtures", "logs", "node-spec-truncated.log");
    expect(fs.readFileSync(log, "utf8").trimEnd().split("\n")).toHaveLength(14);
    const script = `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(log)},'utf8')); process.exit(1)`;
    const { run, envelope } = jsonOf(
      await runInCart(["--no-jev", "--format=json"], [process.execPath, "-e", script]),
    );

    expect(run.code).toBe(1);
    expect(envelope.status).toBe("FAIL");
    expect(envelope.execution_gear).toBe("GEAR_0_GRAMMAR");
    expect(envelope.summary).toEqual({ passed: 2, failed: 4, skipped: 0, total_clusters: 1 });
    expect(clustersOf(envelope)).toHaveLength(1);
    const cluster = clustersOf(envelope)[0];
    expect(cluster?.cluster_id).toBe("c_11eac407");
    expect(cluster?.error_kind).toBe("RUNTIME_EXCEPTION");
    expect(cluster?.affected_count).toBe(4);
    expect(cluster?.top_frame).toBe("unknown:0:0");
    expect(cluster?.message).toBe("Unknown test failure");
    expect(cluster?.sample_tests).toEqual([
      "discount 10% leaves 90%",
      "total with 10% off",
      "total with 100% off is free",
    ]);
    expect(cluster?.raw_log_lines).toBe("L3-L6");
  });
});

describe("node --test, spec reporter parity with TAP", () => {
  it("The spec reporter yields the same clusters as the TAP reporter", async () => {
    const { tap, spec } = await bothReporters("cart.test.js");

    const ids = ["c_9721831d", "c_6edce10a", "c_fdff652c", "c_53a8182a"];
    expect(clustersOf(spec.envelope).map((c) => c.cluster_id)).toEqual(ids);
    expect(clustersOf(tap.envelope).map((c) => c.cluster_id)).toEqual(ids);
    const view = (e: DigestEnvelope) =>
      clustersOf(e).map((c) => [c.error_kind, c.top_frame, c.message, c.sample_tests]);
    expect(view(spec.envelope)).toEqual(view(tap.envelope));
    expect(clustersOf(spec.envelope).map((c) => c.diff)).toEqual([
      { expected: "900", received: "0" },
      { expected: "1634", received: "0" },
      { expected: "0", received: "-16335" },
      undefined,
    ]);
  });

  it("The spec reporter yields the same clusters as the TAP reporter (a message node prints in backticks)", async () => {
    const { tap, spec } = await bothReporters(
      "html.test.js",
      source("import test from 'node:test';", "test('html', () => { JSON.parse('<html>'); });"),
    );

    expect(clustersOf(tap.envelope).map((c) => c.message)).toEqual([
      `SyntaxError: Unexpected token '<', "<html>" is not valid JSON`,
    ]);
    expect(clustersOf(spec.envelope).map((c) => c.message)).toEqual(clustersOf(tap.envelope).map((c) => c.message));
    expect(clustersOf(spec.envelope).map((c) => c.cluster_id)).toEqual(
      clustersOf(tap.envelope).map((c) => c.cluster_id),
    );
  });

  it("The spec reporter yields the same clusters as the TAP reporter (names containing #)", async () => {
    const { tap, spec } = await bothReporters("hash-name.test.js");

    expect(clustersOf(spec.envelope).map((c) => c.sample_tests)).toEqual([["issue #12 works"]]);
    expect(clustersOf(tap.envelope).map((c) => c.sample_tests)).toEqual([["issue #12 works"]]);
    expect(clustersOf(tap.envelope).map((c) => c.cluster_id)).toEqual(
      clustersOf(spec.envelope).map((c) => c.cluster_id),
    );
  });

  it("String values in diffs are unquoted under both reporters", async () => {
    for (const reporter of REPORTERS) {
      const { run, envelope } = await digestOf(reporter, "string-diff.test.js");

      expect(run.code).toBe(1);
      expect(clustersOf(envelope)).toHaveLength(1);
      const cluster = clustersOf(envelope)[0];
      expect(cluster?.cluster_id).toBe("c_42febbe1");
      expect(cluster?.error_kind).toBe("ASSERTION_FAILURE");
      expect(cluster?.top_frame).toBe("string-diff.test.js:3:35");
      expect(cluster?.message).toBe(
        "AssertionError: Expected values to be strictly equal: 'pan' !== 'pen'",
      );
      expect(cluster?.diff).toEqual({ expected: "pen", received: "pan" });
      expect(cluster?.sample_tests).toEqual(["label is pen"]);
    }
  });
});

function clusterIds(envelope: DigestEnvelope): string[] {
  return clustersOf(envelope)
    .map((c) => c.cluster_id)
    .sort();
}

describe("node --test, the same failure reads the same under both reporters", () => {
  it("Plain errors and hook errors read as Error under both reporters", async () => {
    const { tap, spec } = await bothReporters("plain.test.js");

    for (const { envelope } of [tap, spec]) {
      const message = (test: string): string | undefined => clusterOf(envelope, test)?.message;
      expect([message("plain"), message("empty"), message("typed"), message("suite")]).toEqual([
        "Error: z",
        "Error",
        "TypeError: t",
        "Error: hb",
      ]);
    }
    expect(clusterIds(tap.envelope)).toEqual(clusterIds(spec.envelope));
  });

  it("A thrown number keeps its text under both reporters", async () => {
    const contents = source(
      "import test from 'node:test';",
      "test('num', () => { throw 42; });",
      "test('obj', () => { throw { a: 1 }; });",
    );
    const { tap, spec } = await bothReporters("thrown.test.js", contents);

    for (const { envelope } of [tap, spec]) {
      expect(clusterOf(envelope, "num")?.message).toBe("42");
      expect(clusterOf(envelope, "obj")?.message).toBe("{ a: 1 }");
    }
    expect(clusterIds(tap.envelope)).toEqual(clusterIds(spec.envelope));
  });

  it("A failed t.plan keeps its text under both reporters", async () => {
    const contents = source(
      "import test from 'node:test';",
      "test('planned', (t) => { t.plan(2); t.assert.ok(true); });",
    );
    const { tap, spec } = await bothReporters("planned.test.js", contents);

    for (const { envelope } of [tap, spec]) {
      expect(clusterOf(envelope, "planned")?.message).toBe("plan expected 2 assertions but received 1");
    }
    expect(clusterIds(tap.envelope)).toEqual(clusterIds(spec.envelope));
  });

  it("A test name with a backslash is the same under both reporters", async () => {
    const contents = source(
      "import test from 'node:test';",
      "import assert from 'node:assert';",
      'test("back\\\\slash", () => assert.equal(1, 2));',
    );
    const { tap, spec } = await bothReporters("names.test.js", contents);

    for (const { envelope } of [tap, spec]) {
      expect(clustersOf(envelope)).toHaveLength(1);
      expect(clustersOf(envelope)[0]?.sample_tests).toEqual(["back\\slash"]);
    }
    expect(clusterIds(tap.envelope)).toEqual(clusterIds(spec.envelope));
  });

  it("A backtick string diff equals the TAP diff", async () => {
    const contents = source(
      "import test from 'node:test';",
      "import assert from 'node:assert';",
      'test("bt", () => assert.equal(`a\'b"c`, `a\'b"d`));',
    );
    const { tap, spec } = await bothReporters("names.test.js", contents);

    for (const { envelope } of [tap, spec]) {
      expect(clustersOf(envelope)).toHaveLength(1);
      expect(clustersOf(envelope)[0]?.diff).toEqual({ expected: `a'b"d`, received: `a'b"c` });
    }
    expect(clusterIds(tap.envelope)).toEqual(clusterIds(spec.envelope));
  });
});

const DIRECTIVE_TESTS = source(
  "import test, { describe, it } from 'node:test';",
  "test('not yet', { todo: true }, () => { throw new Error('x'); });",
  "test('later', { todo: 'next sprint' }, () => { throw new Error('l'); });",
  "test('skipped one', { skip: true }, () => { throw new Error('y'); });",
  "describe('group', () => {",
  "  it('nested todo', { todo: true }, () => { throw new Error('n'); });",
  "  it('nested skip', { skip: 'why' }, () => { throw new Error('s'); });",
  "});",
  "describe('todo suite', { todo: true }, () => {",
  "  it('inside', () => { throw new Error('i'); });",
  "});",
  "test('fine', () => {});",
);

describe("node --test, TODO and SKIP directives", () => {
  it("The spec reporter yields the same clusters as the TAP reporter (todo and skip tests are not failures)", async () => {
    const { tap, spec } = await bothReporters("directives.test.js", DIRECTIVE_TESTS);

    for (const { run, envelope } of [tap, spec]) {
      expect(run.code).toBe(0);
      expect(envelope.status).toBe("PASS");
      expect(clustersOf(envelope)).toEqual([]);
      expect(envelope.summary.failed).toBe(0);
    }
    expect(spec.envelope.summary).toEqual(tap.envelope.summary);
  });

  it("The spec reporter yields the same clusters as the TAP reporter (a real failure beside directive tests)", async () => {
    const { tap, spec } = await bothReporters(
      "directives.test.js",
      source(
        DIRECTIVE_TESTS,
        "import assert from 'node:assert/strict';",
        "test('really fails', () => { assert.equal(1, 2); });",
      ),
    );

    for (const { run, envelope } of [tap, spec]) {
      expect(run.code).toBe(1);
      expect(clustersOf(envelope).map((c) => c.sample_tests)).toEqual([["really fails"]]);
      expect(envelope.summary.failed).toBe(1);
    }
    expect(spec.envelope.summary).toEqual(tap.envelope.summary);
    expect(clustersOf(spec.envelope).map((c) => c.cluster_id)).toEqual(
      clustersOf(tap.envelope).map((c) => c.cluster_id),
    );
  });
});

/** node exits 0 when only an `after` hook throws. */
const SUITE_FAULTS: Readonly<Record<string, { contents: string; nodeExitCode: number }>> = {
  "before hook that throws": {
    nodeExitCode: 1,
    contents: source(
      "import { describe, before, it } from 'node:test';",
      "describe('suite with failing before', () => {",
      "  before(() => { throw new Error('before boom'); });",
      "  it('a', () => {});",
      "  it('b', () => {});",
      "});",
    ),
  },
  "after hook that throws": {
    nodeExitCode: 0,
    contents: source(
      "import { describe, after, it } from 'node:test';",
      "describe('suite with failing after', () => {",
      "  after(() => { throw new Error('after boom'); });",
      "  it('a', () => {});",
      "});",
    ),
  },
  "describe body that throws": {
    nodeExitCode: 1,
    contents: source(
      "import { describe, it } from 'node:test';",
      "describe('suite whose body throws', () => {",
      "  it('a', () => {});",
      "  throw new Error('body boom');",
      "});",
    ),
  },
};

describe("node --test, summary.failed is never below the failures reported", () => {
  for (const [fault, { contents, nodeExitCode }] of Object.entries(SUITE_FAULTS)) {
    for (const reporter of REPORTERS) {
      it(`Nested suite with a deep-equal failure and a timeout (${fault}, ${reporter})`, async () => {
        const { run, envelope } = await digestOf(reporter, "suite-fault.test.js", contents);

        const reported = totalAffected(envelope);
        expect(run.code).toBe(nodeExitCode);
        expect(reported).toBeGreaterThan(0);
        expect(envelope.summary.failed).toBeGreaterThanOrEqual(reported);
      });
    }
  }

  it("Nested suite and timeout under the spec reporter (two node runs in one stream sum their counts)", async () => {
    const { run, envelope } = await nodeRunsWrapper("spec", {
      "two-fail.test.js": source(
        "import test from 'node:test';",
        "test('good one', () => {});",
        "test('bad one', () => { throw new Error('one'); });",
        "test('bad two', () => { throw new RangeError('two'); });",
      ),
      "two-pass.test.js": source(
        "import test from 'node:test';",
        "test('fine a', () => {});",
        "test('fine b', () => {});",
      ),
    });

    expect(run.code).toBe(1);
    expect(envelope.summary).toMatchObject({ passed: 3, failed: 2, total_clusters: 2 });
  });

  it("Nested suite with a deep-equal failure and a timeout (two node runs in one stream sum their counts, TAP equals spec)", async () => {
    const tests = {
      "many-fail.test.js": source(
        "import test, { describe, it } from 'node:test';",
        "test('good one', () => {});",
        "test('bad one', () => { throw new Error('one'); });",
        "test('skipped a', { skip: true }, () => {});",
        "test('skipped b', { skip: true }, () => {});",
        "describe('group', () => {",
        "  it('nested good', () => {});",
        "  it('nested bad', () => { throw new RangeError('two'); });",
        "});",
      ),
      "many-pass.test.js": source(
        "import test from 'node:test';",
        "test('fine a', () => {});",
        "test('fine b', () => {});",
        "test('skipped c', { skip: true }, () => {});",
      ),
    };
    const tap = await nodeRunsWrapper("tap", tests);
    const spec = await nodeRunsWrapper("spec", tests);

    expect(tap.run.code).toBe(1);
    expect(tap.envelope.summary).toMatchObject({ passed: 4, failed: 2, skipped: 3 });
    expect(spec.envelope.summary).toEqual(tap.envelope.summary);
  });

  it("Nested suite and timeout under the spec reporter (after hook that throws, same counts as TAP)", async () => {
    const contents = SUITE_FAULTS["after hook that throws"]?.contents ?? "";
    const { tap, spec } = await bothReporters("suite-fault.test.js", contents);

    expect(tap.envelope.summary).toEqual({ passed: 1, failed: 1, skipped: 0, total_clusters: 1 });
    expect(spec.envelope.summary).toEqual(tap.envelope.summary);
  });
});

describe("node --test, a SyntaxError raised inside a test that ran", () => {
  const BROKEN_ESM = "export function total(items) { return items.reduce((a, b) => a + b, 0 }\n";
  const BROKEN_CJS = "function total(items) { return items.reduce((a, b) => a + b, 0 }\nmodule.exports = { total };\n";
  const importing = (specifier: string): string =>
    source("import test from 'node:test';", `test('loads late', async () => { await import('${specifier}'); });`);

  const RUNTIME_FAULTS: Readonly<Record<string, string>> = {
    "JSON.parse(undefined) inside a test": "JSON.parse(undefined);",
    "JSON.parse('abc') inside a test": "JSON.parse('abc');",
  };
  const SYNTAX_FAULTS: Readonly<Record<string, { entry: string; files: Readonly<Record<string, string>> }>> = {
    "dynamic import of a missing module inside a test": {
      entry: "late.test.js",
      files: { "late.test.js": importing("./no-such-module.js") },
    },
    "dynamic import of a file with a syntax error": {
      entry: "lazy.test.js",
      files: { "broken.js": BROKEN_ESM, "lazy.test.js": importing("./broken.js") },
    },
    "import of a file with a syntax error in a before hook": {
      entry: "hook.test.js",
      files: {
        "broken.js": BROKEN_ESM,
        "hook.test.js": source(
          "import test, { before } from 'node:test';",
          "before(async () => { await import('./broken.js'); });",
          "test('total sums', () => {});",
        ),
      },
    },
    "require of a file with a syntax error": {
      entry: "required.test.cjs",
      files: {
        "broken.cjs": BROKEN_CJS,
        "required.test.cjs": source(
          "const test = require('node:test');",
          "test('total', () => { require('./broken.cjs'); });",
        ),
      },
    },
    "dynamic import of a file with an unterminated string": {
      entry: "unterminated.test.js",
      files: { "broken2.js": "export const name = 'abc;\n", "unterminated.test.js": importing("./broken2.js") },
    },
  };

  for (const reporter of REPORTERS) {
    for (const [fault, statement] of Object.entries(RUNTIME_FAULTS)) {
      it(`A missing export is VALID_RED with exit 0 (${fault}, ${reporter})`, async () => {
        const { run, envelope } = await digestOf(
          reporter,
          "parses.test.js",
          source("import test from 'node:test';", `test('parses', () => { ${statement} });`),
          ["--tdd-phase=red"],
        );

        expect(run.code).toBe(0);
        expect(envelope.status).toBe("VALID_RED");
        expect(clustersOf(envelope).map((c) => c.error_kind)).toEqual(["RUNTIME_EXCEPTION"]);
        expect(clustersOf(envelope)[0]?.message).toContain("SyntaxError");
      });
    }

    for (const [fault, { entry, files }] of Object.entries(SYNTAX_FAULTS)) {
      it(`A missing module is INVALID_RED with exit 64 (${fault}, ${reporter})`, async () => {
        const result = await runJson([`--test-reporter=${reporter}`, entry], { files, flags: ["--tdd-phase=red"] });

        expectSyntaxFault(result);
        expect(clustersOf(result.envelope)).toHaveLength(1);
      });
    }
  }
});
