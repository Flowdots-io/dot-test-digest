import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { DigestEnvelope, FailureCluster } from "../src/types/schema.js";
import { clustersOf } from "./helpers/digest.js";
import { runInCart, runNodeCart } from "./helpers/node-cart.js";

const SYNTAX_MESSAGE =
  "Test failed due to syntax or unresolved module import rather than a behavioral assertion.";

function baselineOf(home: string, scope: string): string[] {
  const raw = fs.readFileSync(path.join(home, `state-${scope}.json`), "utf8");
  return (JSON.parse(raw) as { baseline: string[] }).baseline;
}

describe("node --test, TAP diagnostic blocks", () => {
  it("The cart run with the default (TAP) reporter yields four distinct clusters", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], ["cart.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

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
    const run = await runNodeCart(["--no-jev", "--format=json"], ["cart.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;
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

describe("node --test, TAP counts, suites and timeouts", () => {
  it("Nested suite with a deep-equal failure and a timeout", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], ["suite.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(1);
    expect(envelope.summary.passed).toBe(1);
    expect(envelope.summary.failed).toBe(3);
    expect(envelope.summary.skipped).toBe(0);
    expect(clustersOf(envelope).flatMap((c) => c.sample_tests).sort()).toEqual([
      "discount 10% leaves 90%",
      "names match",
      "slow",
    ]);
    expect(clustersOf(envelope).reduce((sum, c) => sum + c.affected_count, 0)).toBe(3);

    const names = clustersOf(envelope).find((c) => c.sample_tests.includes("names match"));
    expect(names?.error_kind).toBe("ASSERTION_FAILURE");
    expect(names?.top_frame).toBe("suite.test.js:7:34");
    expect(names?.message).toBe(
      "AssertionError: Expected values to be strictly deep-equal: + actual - expected { + a: 1 - a: 2 }",
    );
    expect(names?.diff).toEqual({ expected: "a: 2", received: "a: 1" });

    const slow = clustersOf(envelope).find((c) => c.sample_tests.includes("slow"));
    expect(slow?.error_kind).toBe("TIMEOUT_OR_CONN_REFUSED");
    expect(slow?.message).toBe("test timed out after 20ms");
    expect(slow?.top_frame).toBe("unknown:0:0");
    expect(slow?.signal_window).toBe("");
  });
});

describe("node --test, same-named failures under TAP", () => {
  it("Two same-named failing tests in one file stay two failures under TAP", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], ["same-name.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(1);
    expect(envelope.summary).toEqual({ passed: 0, failed: 2, skipped: 0, total_clusters: 2 });
    expect(clustersOf(envelope).reduce((sum, c) => sum + c.affected_count, 0)).toBe(2);
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
      ["--no-jev", "--tdd-phase=red", "--scope-id=same-tap"],
      ["same-name.test.js"],
    );
    expect(red.code).toBe(0);
    expect(baselineOf(red.home, "same-tap").sort()).toEqual([
      "same-name.test.js::handles empty @4",
      "same-name.test.js::handles empty @7",
    ]);
  });
});

describe("node --test, file-level TAP failures", () => {
  it("A missing module is one SYNTAX_IMPORT_ERROR failure", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], ["missing-module.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(1);
    expect(envelope.summary.failed).toBe(1);
    expect(envelope.summary.total_clusters).toBe(1);
    const cluster = clustersOf(envelope)[0];
    expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(cluster?.affected_count).toBe(1);
    expect(cluster?.sample_tests).toEqual(["missing-module.test.js"]);
    expect(cluster?.message.startsWith("Error: Cannot find module '")).toBe(true);
    expect(cluster?.message).toContain("missing.js' imported from ");
  });
});

describe("node --test, file-level TAP failures (missing export)", () => {
  it("A missing export is a RUNTIME_EXCEPTION failure, not a syntax error", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], ["missing-export.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(1);
    expect(envelope.summary.total_clusters).toBe(1);
    expect(clustersOf(envelope)[0]?.error_kind).toBe("RUNTIME_EXCEPTION");
    expect(clustersOf(envelope)[0]?.message).toBe(
      "SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'",
    );
  });
});

describe("node --test, two crashing files under TAP", () => {
  it("Two crashing files under TAP each carry their own subprocess error", async () => {
    const files = ["missing-module.test.js", "missing-export.test.js"];
    const run = await runNodeCart(["--no-jev", "--format=json"], files);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(1);
    expect(envelope.summary).toEqual({ passed: 0, failed: 2, skipped: 0, total_clusters: 2 });
    expect(clustersOf(envelope).reduce((sum, c) => sum + c.affected_count, 0)).toBe(2);
    const moduleCluster = clustersOf(envelope).find((c) => c.sample_tests[0] === "missing-module.test.js");
    const exportCluster = clustersOf(envelope).find((c) => c.sample_tests[0] === "missing-export.test.js");
    expect(moduleCluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(moduleCluster?.message.startsWith("Error: Cannot find module '")).toBe(true);
    expect(moduleCluster?.message).toContain("missing.js' imported from ");
    expect(moduleCluster?.message.endsWith("/missing-module.test.js")).toBe(true);
    expect(exportCluster?.error_kind).toBe("RUNTIME_EXCEPTION");
    expect(exportCluster?.message).toBe(
      "SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'",
    );

    const red = await runNodeCart(["--no-jev", "--tdd-phase=red"], files);
    expect(red.code).toBe(64);
    expect(red.stdout).toContain("INVALID_RED");
    expect(red.stdout).toContain("SYNTAX_IMPORT_ERROR");
  });
});

describe("node --test, TAP red-phase guards (assertion failures)", () => {
  it("Assertion failures are VALID_RED with exit 0 and the baseline holds canonical ids", async () => {
    const run = await runNodeCart(["--no-jev", "--tdd-phase=red", "--scope-id=tap-red"], ["cart.test.js"]);

    expect(run.code).toBe(0);
    expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(run.stdout.trimEnd())).toBeLessThanOrEqual(160);
    expect(run.stdout.startsWith("[VALID_RED | RED] 2 passed, 4 failed in ")).toBe(true);
    expect(baselineOf(run.home, "tap-red").sort()).toEqual([
      "cart.test.js::discount 10% leaves 90%",
      "cart.test.js::first of an empty cart is undefined",
      "cart.test.js::total with 10% off",
      "cart.test.js::total with 100% off is free",
    ]);
  });
});

describe("node --test, TAP red-phase guards (missing module)", () => {
  it("A missing module is INVALID_RED with exit 64", async () => {
    const run = await runNodeCart(["--no-jev", "--tdd-phase=red"], ["missing-module.test.js"]);

    expect(run.code).toBe(64);
    expect(run.stdout).toContain("INVALID_RED");
    expect(run.stdout).toContain("SYNTAX_IMPORT_ERROR");
    expect(run.stderr).toContain(SYNTAX_MESSAGE);
  });
});

describe("node --test, TAP red-phase guards (missing export)", () => {
  it("A missing export is VALID_RED with exit 0", async () => {
    const run = await runNodeCart(["--no-jev", "--tdd-phase=red"], ["missing-export.test.js"]);

    expect(run.code).toBe(0);
    expect(run.stdout.startsWith("[VALID_RED | RED]")).toBe(true);
  });
});

describe("node --test, TAP red-phase guards (already passing)", () => {
  it("A test that already passes is INVALID_RED with exit 64", async () => {
    const run = await runNodeCart(["--no-jev", "--tdd-phase=red"], ["passing.test.js"]);

    expect(run.code).toBe(64);
    expect(run.stdout).toContain("INVALID_RED");
    expect(run.stdout).toContain("0 failed, 1 passed");
    expect(run.stderr).toContain(
      "New test passed before implementation; expected a failing behavioral assertion.",
    );
  });
});

describe("node --test, TAP exit-code transparency", () => {
  it("Without a TDD phase the child's exit code passes through", async () => {
    const failing = await runNodeCart(["--no-jev"], ["cart.test.js"]);
    const passing = await runNodeCart(["--no-jev"], ["passing.test.js"]);

    expect(failing.code).toBe(1);
    expect(passing.code).toBe(0);
    expect(passing.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(passing.stdout.trimEnd())).toBeLessThanOrEqual(160);
    expect(passing.stdout.startsWith("[PASS] 1 passed, 0 failed in ")).toBe(true);
  });
});

const SPEC = "--test-reporter=spec";

describe("node --test, spec reporter recognition", () => {
  it("The cart run with the spec reporter is parsed, not reported as BUILD_ERROR", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], [SPEC, "cart.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(1);
    expect(envelope.status).toBe("FAIL");
    expect(envelope.execution_gear).toBe("GEAR_0_GRAMMAR");
    expect(envelope.summary).toEqual({ passed: 2, failed: 4, skipped: 0, total_clusters: 4 });
    expect(clustersOf(envelope).map((c) => c.error_kind)).not.toContain("UNSTRUCTURED_BUILD_ERROR");
  });
});

describe("node --test, spec reporter parity with TAP", () => {
  it("The spec reporter yields the same clusters as the TAP reporter", async () => {
    const spec = JSON.parse(
      (await runNodeCart(["--no-jev", "--format=json"], [SPEC, "cart.test.js"])).stdout,
    ) as DigestEnvelope;
    const tap = JSON.parse(
      (await runNodeCart(["--no-jev", "--format=json"], ["--test-reporter=tap", "cart.test.js"])).stdout,
    ) as DigestEnvelope;

    const ids = ["c_9721831d", "c_6edce10a", "c_fdff652c", "c_53a8182a"];
    expect(clustersOf(spec).map((c) => c.cluster_id)).toEqual(ids);
    expect(clustersOf(tap).map((c) => c.cluster_id)).toEqual(ids);
    const view = (e: DigestEnvelope) =>
      clustersOf(e).map((c) => [c.error_kind, c.top_frame, c.message, c.sample_tests]);
    expect(view(spec)).toEqual(view(tap));
    expect(clustersOf(spec).map((c) => c.diff)).toEqual([
      { expected: "900", received: "0" },
      { expected: "1634", received: "0" },
      { expected: "0", received: "-16335" },
      undefined,
    ]);
  });
});

describe("node --test, a message node prints in backticks", () => {
  it("The spec reporter yields the same clusters as the TAP reporter (a message node prints in backticks)", async () => {
    const files = {
      "html.test.js": "import test from 'node:test';\ntest('html', () => { JSON.parse('<html>'); });\n",
    };
    const view = async (reporter: string): Promise<DigestEnvelope> =>
      JSON.parse(
        (
          await runNodeCart(
            ["--no-jev", "--format=json"],
            [`--test-reporter=${reporter}`, "html.test.js"],
            { files },
          )
        ).stdout,
      ) as DigestEnvelope;
    const spec = await view("spec");
    const tap = await view("tap");

    expect(clustersOf(tap).map((c) => c.message)).toEqual(clustersOf(spec).map((c) => c.message));
    expect(clustersOf(tap).map((c) => c.message)).toEqual([
      `SyntaxError: Unexpected token '<', "<html>" is not valid JSON`,
    ]);
    expect(clustersOf(tap).map((c) => c.cluster_id)).toEqual(clustersOf(spec).map((c) => c.cluster_id));
  });
});

describe("node --test, test names containing a hash", () => {
  it("The spec reporter yields the same clusters as the TAP reporter (names containing #)", async () => {
    const view = async (reporter: string): Promise<DigestEnvelope> =>
      JSON.parse(
        (
          await runNodeCart(
            ["--no-jev", "--format=json"],
            [`--test-reporter=${reporter}`, "hash-name.test.js"],
          )
        ).stdout,
      ) as DigestEnvelope;
    const spec = await view("spec");
    const tap = await view("tap");

    expect(clustersOf(spec).map((c) => c.sample_tests)).toEqual([["issue #12 works"]]);
    expect(clustersOf(tap).map((c) => c.sample_tests)).toEqual([["issue #12 works"]]);
    expect(clustersOf(tap).map((c) => c.cluster_id)).toEqual(clustersOf(spec).map((c) => c.cluster_id));
  });
});

describe("node --test, string values in diffs", () => {
  it("String values in diffs are unquoted under both reporters", async () => {
    for (const reporter of ["tap", "spec"]) {
      const run = await runNodeCart(
        ["--no-jev", "--format=json"],
        [`--test-reporter=${reporter}`, "string-diff.test.js"],
      );
      const envelope = JSON.parse(run.stdout) as DigestEnvelope;

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

describe("node --test, spec reporter nested suite and timeout", () => {
  it("Nested suite and timeout under the spec reporter", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], [SPEC, "suite.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(envelope.summary).toMatchObject({ passed: 1, failed: 3, skipped: 0 });
    expect(clustersOf(envelope).flatMap((c) => c.sample_tests).sort()).toEqual([
      "discount 10% leaves 90%",
      "names match",
      "slow",
    ]);
    const slow = clustersOf(envelope).find((c) => c.sample_tests.includes("slow"));
    expect(slow?.error_kind).toBe("TIMEOUT_OR_CONN_REFUSED");
    expect(slow?.message).toBe("test timed out after 20ms");
    const names = clustersOf(envelope).find((c) => c.sample_tests.includes("names match"));
    expect(names?.message).toBe(
      "AssertionError: Expected values to be strictly deep-equal: + actual - expected { + a: 1 - a: 2 }",
    );
  });
});

describe("node --test, spec reporter compact-md digest", () => {
  it("The compact-md digest of the spec run names the failures", async () => {
    const run = await runNodeCart(["--no-jev"], [SPEC, "cart.test.js"]);

    expect(run.stdout.split("\n")[0]?.startsWith("[FAIL] 4 failed, 2 passed in ")).toBe(true);
    expect(run.stdout).toContain("ASSERTION_FAILURE x1 cart.test.js:7:46");
    expect(Buffer.byteLength(run.stdout)).toBeLessThanOrEqual(2400);
    expect(run.stdout).not.toContain("UNSTRUCTURED_BUILD_ERROR");
    expect(run.stdout).not.toContain("BUILD_ERROR");
    expect(run.stdout).not.toContain("file://");
  });
});

describe("node --test, same-named failures under the spec reporter", () => {
  it("Two same-named failing tests in one file stay two failures under the spec reporter", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], [SPEC, "same-name.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(1);
    expect(envelope.summary).toEqual({ passed: 0, failed: 2, skipped: 0, total_clusters: 2 });
    expect(clustersOf(envelope).reduce((sum, c) => sum + c.affected_count, 0)).toBe(2);
    expect(
      clustersOf(envelope).map((c) => ({
        cluster_id: c.cluster_id,
        error_kind: c.error_kind,
        message: c.message,
        top_frame: c.top_frame,
        sample_tests: c.sample_tests,
      })),
    ).toEqual([
      {
        cluster_id: "c_20e326b9",
        error_kind: "ASSERTION_FAILURE",
        message: "AssertionError: Expected values to be strictly equal: 0 !== 1",
        top_frame: "same-name.test.js:4:36",
        sample_tests: ["handles empty @4"],
      },
      {
        cluster_id: "c_0044f190",
        error_kind: "ASSERTION_FAILURE",
        message: "AssertionError: Expected values to be strictly equal: 0 !== 1",
        top_frame: "same-name.test.js:7:36",
        sample_tests: ["handles empty @7"],
      },
    ]);

    const red = await runNodeCart(
      ["--no-jev", "--tdd-phase=red", "--scope-id=same-spec"],
      [SPEC, "same-name.test.js"],
    );
    expect(red.code).toBe(0);
    expect(baselineOf(red.home, "same-spec").sort()).toEqual([
      "same-name.test.js::handles empty @4",
      "same-name.test.js::handles empty @7",
    ]);
  });
});

describe("node --test, spec run cut before the failing-tests section", () => {
  it("A spec run cut before the failing-tests section still yields its failures", async () => {
    const log = path.join(process.cwd(), "tests", "fixtures", "logs", "node-spec-truncated.log");
    expect(fs.readFileSync(log, "utf8").trimEnd().split("\n")).toHaveLength(14);
    const script = `process.stdout.write(require('node:fs').readFileSync(${JSON.stringify(log)},'utf8')); process.exit(1)`;
    const run = await runInCart(["--no-jev", "--format=json"], [process.execPath, "-e", script]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

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

describe("node --test, file-level spec failures", () => {
  it("A missing module under the spec reporter is one SYNTAX_IMPORT_ERROR failure", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], [SPEC, "missing-module.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(envelope.status).toBe("FAIL");
    expect(envelope.summary.failed).toBe(1);
    expect(envelope.summary.total_clusters).toBe(1);
    const cluster = clustersOf(envelope)[0];
    expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(cluster?.sample_tests).toEqual(["missing-module.test.js"]);
    expect(cluster?.message.startsWith("Error: Cannot find module '")).toBe(true);
  });
});

describe("node --test, file-level spec failures (missing export)", () => {
  it("A missing export under the spec reporter is a RUNTIME_EXCEPTION failure", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], [SPEC, "missing-export.test.js"]);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(envelope.summary.total_clusters).toBe(1);
    expect(clustersOf(envelope)[0]?.error_kind).toBe("RUNTIME_EXCEPTION");
    expect(clustersOf(envelope)[0]?.message).toBe(
      "SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'",
    );
  });
});

describe("node --test, two crashing files under the spec reporter", () => {
  it("Two crashing files under the spec reporter each carry their own subprocess error", async () => {
    const files = [SPEC, "missing-module.test.js", "missing-export.test.js"];
    const run = await runNodeCart(["--no-jev", "--format=json"], files);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(1);
    expect(envelope.status).toBe("FAIL");
    expect(envelope.summary).toEqual({ passed: 0, failed: 2, skipped: 0, total_clusters: 2 });
    expect(clustersOf(envelope).reduce((sum, c) => sum + c.affected_count, 0)).toBe(2);
    const moduleCluster = clustersOf(envelope).find((c) => c.sample_tests[0] === "missing-module.test.js");
    const exportCluster = clustersOf(envelope).find((c) => c.sample_tests[0] === "missing-export.test.js");
    expect(moduleCluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(moduleCluster?.message.startsWith("Error: Cannot find module '")).toBe(true);
    expect(moduleCluster?.message).toContain("missing.js' imported from ");
    expect(moduleCluster?.message.endsWith("/missing-module.test.js")).toBe(true);
    expect(exportCluster?.error_kind).toBe("RUNTIME_EXCEPTION");
    expect(exportCluster?.message).toBe(
      "SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'",
    );

    const red = await runNodeCart(["--no-jev", "--tdd-phase=red"], files);
    expect(red.code).toBe(64);
    expect(red.stdout).toContain("INVALID_RED");
    expect(red.stdout).toContain("SYNTAX_IMPORT_ERROR");
  });
});

describe("node --test, spec red-phase guards (missing module)", () => {
  it("A missing module is INVALID_RED with exit 64 and the syntax message", async () => {
    const run = await runNodeCart(["--no-jev", "--tdd-phase=red"], [SPEC, "missing-module.test.js"]);

    expect(run.code).toBe(64);
    expect(run.stdout).toContain("INVALID_RED");
    expect(run.stdout).toContain("SYNTAX_IMPORT_ERROR");
    expect(run.stderr).toContain(SYNTAX_MESSAGE);
  });
});

describe("node --test, spec red-phase guards (missing module, path forms)", () => {
  it("A missing module is INVALID_RED with exit 64 and the syntax message (absolute path)", async () => {
    const run = await runNodeCart(
      ["--no-jev", "--format=json", "--tdd-phase=red"],
      (dir) => [SPEC, path.join(dir, "missing-module.test.js")],
    );
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(64);
    expect(envelope.status).toBe("INVALID_RED");
    expect(clustersOf(envelope)[0]?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(clustersOf(envelope)[0]?.message).toContain("Cannot find module");
    expect(run.stderr).toContain(SYNTAX_MESSAGE);
  });

  it("A missing module is INVALID_RED with exit 64 and the syntax message (parent-relative path)", async () => {
    const run = await runNodeCart(
      ["--no-jev", "--format=json", "--tdd-phase=red"],
      [SPEC, "../missing-module.test.js"],
      { subdir: "sub" },
    );
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(64);
    expect(envelope.status).toBe("INVALID_RED");
    expect(clustersOf(envelope)[0]?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(clustersOf(envelope)[0]?.message).toContain("Cannot find module");
    expect(run.stderr).toContain(SYNTAX_MESSAGE);
  });

  it("A missing module is INVALID_RED with exit 64 and the syntax message (absolute path to a file with a syntax error)", async () => {
    const run = await runNodeCart(
      ["--no-jev", "--format=json", "--tdd-phase=red"],
      (dir) => [SPEC, path.join(dir, "syntax-error.test.js")],
    );
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(64);
    expect(envelope.status).toBe("INVALID_RED");
    expect(clustersOf(envelope)[0]?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(run.stderr).toContain(SYNTAX_MESSAGE);
  });
});

describe("node --test, spec red-phase guards (crashes with no attributable error)", () => {
  const PASSING_TEST = "import './lib.js'; import test from 'node:test'; test('x',()=>{});\n";

  it("A missing module is INVALID_RED with exit 64 and the syntax message (two files crash through a shared import)", async () => {
    const run = await runNodeCart(
      ["--no-jev", "--format=json", "--tdd-phase=red"],
      [SPEC, "a.test.js", "b.test.js"],
      {
        files: {
          "lib.js": "import './missing-helper.js';\n",
          "a.test.js": PASSING_TEST,
          "b.test.js": PASSING_TEST,
        },
      },
    );
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(64);
    expect(envelope.status).toBe("INVALID_RED");
    expect(clustersOf(envelope).every((c) => c.error_kind === "SYNTAX_IMPORT_ERROR")).toBe(true);
    expect(run.stderr).toContain(SYNTAX_MESSAGE);
  });

  it("A missing module is INVALID_RED with exit 64 and the syntax message (a test file that exits at load time)", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json", "--tdd-phase=red"], [SPEC, "exit.test.js"], {
      files: { "exit.test.js": "process.exit(1);\n" },
    });
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(64);
    expect(envelope.status).toBe("INVALID_RED");
    expect(clustersOf(envelope)[0]?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(run.stderr).toContain(SYNTAX_MESSAGE);
  });
});

describe("node --test, TAP red-phase guards (crashes with no attributable error)", () => {
  it("A missing module is INVALID_RED with exit 64 (a test file that exits at load time)", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json", "--tdd-phase=red"], ["exit.test.js"], {
      files: { "exit.test.js": "process.exit(1);\n" },
    });
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(64);
    expect(envelope.status).toBe("INVALID_RED");
    expect(clustersOf(envelope)[0]?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(run.stderr).toContain(SYNTAX_MESSAGE);
  });
});

describe("node --test, spec red-phase guards (wrapper output after the failing-tests section)", () => {
  const WRAPPER = [
    "import { spawnSync } from 'node:child_process';",
    "const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', 'mm.test.js'], { stdio: 'inherit' });",
    "console.log(' ELIFECYCLE  Test failed. See above for more details.');",
    "process.exit(run.status ?? 1);",
    "",
  ].join("\n");

  it("A missing module is INVALID_RED with exit 64 and the syntax message (unindented wrapper line after the section)", async () => {
    const run = await runInCart(
      ["--no-jev", "--format=json", "--tdd-phase=red"],
      [process.execPath, "wrapper.js"],
      {
        files: {
          "wrapper.js": WRAPPER,
          "mm.test.js": "import './missing.js'; import test from 'node:test'; test('x',()=>{});\n",
        },
      },
    );
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(64);
    expect(envelope.status).toBe("INVALID_RED");
    expect(clustersOf(envelope)[0]?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(clustersOf(envelope)[0]?.message.startsWith("Error: Cannot find module '")).toBe(true);
    expect(clustersOf(envelope)[0]?.message).not.toContain("ELIFECYCLE");
  });
});

describe("node --test, spec red-phase guards (missing export)", () => {
  it("A missing export is VALID_RED with exit 0 under the spec reporter", async () => {
    const run = await runNodeCart(["--no-jev", "--tdd-phase=red"], [SPEC, "missing-export.test.js"]);

    expect(run.code).toBe(0);
    expect(run.stdout.startsWith("[VALID_RED | RED]")).toBe(true);
  });
});

describe("node --test, spec red-phase guards (already passing)", () => {
  it("A test that already passes is INVALID_RED with exit 64 under the spec reporter", async () => {
    const run = await runNodeCart(["--no-jev", "--tdd-phase=red"], [SPEC, "passing.test.js"]);

    expect(run.code).toBe(64);
    expect(run.stdout).toContain("INVALID_RED");
    expect(run.stderr).toContain(
      "New test passed before implementation; expected a failing behavioral assertion.",
    );
  });
});

describe("node --test, spec exit-code transparency", () => {
  it("Without a TDD phase the child's exit code passes through under the spec reporter", async () => {
    const run = await runNodeCart(["--no-jev"], [SPEC, "cart.test.js"]);

    expect(run.code).toBe(1);
  });
});

describe("node --test, spec reporter passing run", () => {
  it("A passing spec run is one line with the real count", async () => {
    const run = await runNodeCart(["--no-jev"], [SPEC, "passing.test.js"]);

    expect(run.code).toBe(0);
    expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(run.stdout.trimEnd())).toBeLessThanOrEqual(160);
    expect(run.stdout.startsWith("[PASS] 1 passed, 0 failed in ")).toBe(true);
  });
});

describe("node --test, spec red-phase guards (assertion failures)", () => {
  it("Assertion failures are VALID_RED with the real counts", async () => {
    const run = await runNodeCart(
      ["--no-jev", "--tdd-phase=red", "--scope-id=spec-red"],
      [SPEC, "cart.test.js"],
    );

    expect(run.code).toBe(0);
    expect(run.stdout.trimEnd().split("\n")).toHaveLength(1);
    expect(Buffer.byteLength(run.stdout.trimEnd())).toBeLessThanOrEqual(160);
    expect(run.stdout.startsWith("[VALID_RED | RED] 2 passed, 4 failed in ")).toBe(true);
    expect(baselineOf(run.home, "spec-red").sort()).toEqual([
      "cart.test.js::discount 10% leaves 90%",
      "cart.test.js::first of an empty cart is undefined",
      "cart.test.js::total with 10% off",
      "cart.test.js::total with 100% off is free",
    ]);
  });
});

const DIRECTIVE_TESTS = [
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
  "",
].join("\n");

describe("node --test, TODO and SKIP directives", () => {
  it("The spec reporter yields the same clusters as the TAP reporter (todo and skip tests are not failures)", async () => {
    const tap = await digestOf("tap", "directives.test.js", DIRECTIVE_TESTS);
    const spec = await digestOf("spec", "directives.test.js", DIRECTIVE_TESTS);

    for (const { run, envelope } of [tap, spec]) {
      expect(run.code).toBe(0);
      expect(envelope.status).toBe("PASS");
      expect(clustersOf(envelope)).toEqual([]);
      expect(envelope.summary.failed).toBe(0);
    }
    expect(spec.envelope.summary).toEqual(tap.envelope.summary);
  });

  it("The spec reporter yields the same clusters as the TAP reporter (a real failure beside directive tests)", async () => {
    const source = [
      DIRECTIVE_TESTS,
      "import assert from 'node:assert/strict';",
      "test('really fails', () => { assert.equal(1, 2); });",
      "",
    ].join("\n");
    const tap = await digestOf("tap", "directives.test.js", source);
    const spec = await digestOf("spec", "directives.test.js", source);

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
const SUITE_FAULTS: Readonly<Record<string, { source: string; nodeExitCode: number }>> = {
  "before hook that throws": {
    nodeExitCode: 1,
    source: [
      "import { describe, before, it } from 'node:test';",
      "describe('suite with failing before', () => {",
      "  before(() => { throw new Error('before boom'); });",
      "  it('a', () => {});",
      "  it('b', () => {});",
      "});",
      "",
    ].join("\n"),
  },
  "after hook that throws": {
    nodeExitCode: 0,
    source: [
      "import { describe, after, it } from 'node:test';",
      "describe('suite with failing after', () => {",
      "  after(() => { throw new Error('after boom'); });",
      "  it('a', () => {});",
      "});",
      "",
    ].join("\n"),
  },
  "describe body that throws": {
    nodeExitCode: 1,
    source: [
      "import { describe, it } from 'node:test';",
      "describe('suite whose body throws', () => {",
      "  it('a', () => {});",
      "  throw new Error('body boom');",
      "});",
      "",
    ].join("\n"),
  },
};

async function digestOf(reporter: string, file: string, source: string) {
  const run = await runNodeCart(
    ["--no-jev", "--format=json"],
    [`--test-reporter=${reporter}`, file],
    { files: { [file]: source } },
  );
  return { run, envelope: JSON.parse(run.stdout) as DigestEnvelope };
}

describe("node --test, summary.failed is never below the failures reported", () => {
  for (const [fault, { source, nodeExitCode }] of Object.entries(SUITE_FAULTS)) {
    for (const reporter of ["tap", "spec"]) {
      it(`Nested suite with a deep-equal failure and a timeout (${fault}, ${reporter})`, async () => {
        const { run, envelope } = await digestOf(reporter, "suite-fault.test.js", source);

        const reported = clustersOf(envelope).reduce((sum, c) => sum + c.affected_count, 0);
        expect(run.code).toBe(nodeExitCode);
        expect(reported).toBeGreaterThan(0);
        expect(envelope.summary.failed).toBeGreaterThanOrEqual(reported);
      });
    }
  }

  it("Nested suite and timeout under the spec reporter (two node runs in one stream sum their counts)", async () => {
    const wrapper = [
      "import { spawnSync } from 'node:child_process';",
      "let status = 0;",
      "for (const file of ['two-fail.test.js', 'two-pass.test.js']) {",
      "  const run = spawnSync(process.execPath, ['--test', '--test-reporter=spec', file], { stdio: 'inherit' });",
      "  status = status || (run.status ?? 1);",
      "}",
      "process.exit(status);",
      "",
    ].join("\n");
    const run = await runInCart(
      ["--no-jev", "--format=json"],
      [process.execPath, "wrapper.js"],
      {
        files: {
          "wrapper.js": wrapper,
          "two-fail.test.js": [
            "import test from 'node:test';",
            "test('good one', () => {});",
            "test('bad one', () => { throw new Error('one'); });",
            "test('bad two', () => { throw new RangeError('two'); });",
            "",
          ].join("\n"),
          "two-pass.test.js": [
            "import test from 'node:test';",
            "test('fine a', () => {});",
            "test('fine b', () => {});",
            "",
          ].join("\n"),
        },
      },
    );
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;

    expect(run.code).toBe(1);
    expect(envelope.summary).toMatchObject({ passed: 3, failed: 2, total_clusters: 2 });
  });

  it("Nested suite with a deep-equal failure and a timeout (two node runs in one stream sum their counts, TAP equals spec)", async () => {
    const wrapperFor = (reporter: string): string =>
      [
        "import { spawnSync } from 'node:child_process';",
        "let status = 0;",
        "for (const file of ['many-fail.test.js', 'many-pass.test.js']) {",
        `  const run = spawnSync(process.execPath, ['--test', '--test-reporter=${reporter}', file], { stdio: 'inherit' });`,
        "  status = status || (run.status ?? 1);",
        "}",
        "process.exit(status);",
        "",
      ].join("\n");
    const tests = {
      "many-fail.test.js": [
        "import test, { describe, it } from 'node:test';",
        "test('good one', () => {});",
        "test('bad one', () => { throw new Error('one'); });",
        "test('skipped a', { skip: true }, () => {});",
        "test('skipped b', { skip: true }, () => {});",
        "describe('group', () => {",
        "  it('nested good', () => {});",
        "  it('nested bad', () => { throw new RangeError('two'); });",
        "});",
        "",
      ].join("\n"),
      "many-pass.test.js": [
        "import test from 'node:test';",
        "test('fine a', () => {});",
        "test('fine b', () => {});",
        "test('skipped c', { skip: true }, () => {});",
        "",
      ].join("\n"),
    };
    const summaryOf = async (reporter: string) => {
      const run = await runInCart(["--no-jev", "--format=json"], [process.execPath, "wrapper.js"], {
        files: { "wrapper.js": wrapperFor(reporter), ...tests },
      });
      return { code: run.code, summary: (JSON.parse(run.stdout) as DigestEnvelope).summary };
    };

    const tap = await summaryOf("tap");
    const spec = await summaryOf("spec");

    expect(tap.code).toBe(1);
    expect(tap.summary).toMatchObject({ passed: 4, failed: 2, skipped: 3 });
    expect(spec.summary).toEqual(tap.summary);
  });

  it("Nested suite and timeout under the spec reporter (after hook that throws, same counts as TAP)", async () => {
    const source = SUITE_FAULTS["after hook that throws"]?.source ?? "";
    const tap = await digestOf("tap", "suite-fault.test.js", source);
    const spec = await digestOf("spec", "suite-fault.test.js", source);

    expect(tap.envelope.summary).toEqual({ passed: 1, failed: 1, skipped: 0, total_clusters: 1 });
    expect(spec.envelope.summary).toEqual(tap.envelope.summary);
  });
});

describe("node --test, a JSON parse failure raised inside a test that ran", () => {
  const RUNTIME_SYNTAX_ERROR = [
    "import test from 'node:test';",
    "test('parses', () => { JSON.parse(undefined); });",
    "",
  ].join("\n");
  const DYNAMIC_IMPORT = [
    "import test from 'node:test';",
    "test('loads late', async () => { await import('./no-such-module.js'); });",
    "",
  ].join("\n");

  for (const reporter of ["tap", "spec"]) {
    it(`A missing export is VALID_RED with exit 0 (JSON.parse(undefined) inside a test, ${reporter})`, async () => {
      const run = await runNodeCart(
        ["--no-jev", "--format=json", "--tdd-phase=red"],
        [`--test-reporter=${reporter}`, "parses.test.js"],
        { files: { "parses.test.js": RUNTIME_SYNTAX_ERROR } },
      );
      const envelope = JSON.parse(run.stdout) as DigestEnvelope;

      expect(run.code).toBe(0);
      expect(envelope.status).toBe("VALID_RED");
      expect(clustersOf(envelope).map((c) => c.error_kind)).toEqual(["RUNTIME_EXCEPTION"]);
      expect(clustersOf(envelope)[0]?.message).toContain("SyntaxError");
    });

    it(`A missing module is INVALID_RED with exit 64 (dynamic import of a missing module inside a test, ${reporter})`, async () => {
      const run = await runNodeCart(
        ["--no-jev", "--format=json", "--tdd-phase=red"],
        [`--test-reporter=${reporter}`, "late.test.js"],
        { files: { "late.test.js": DYNAMIC_IMPORT } },
      );
      const envelope = JSON.parse(run.stdout) as DigestEnvelope;

      expect(run.code).toBe(64);
      expect(envelope.status).toBe("INVALID_RED");
      expect(clustersOf(envelope).map((c) => c.error_kind)).toEqual(["SYNTAX_IMPORT_ERROR"]);
    });
  }

  const BROKEN_ESM = "export function total(items) { return items.reduce((a, b) => a + b, 0 }\n";
  const BROKEN_CJS = "function total(items) { return items.reduce((a, b) => a + b, 0 }\nmodule.exports = { total };\n";
  const UNTERMINATED = "export const name = 'abc;\n";
  const SYNTAX_FAULTS: Record<string, { entry: string; files: Record<string, string> }> = {
    "dynamic import of a file with a syntax error": {
      entry: "lazy.test.js",
      files: {
        "broken.js": BROKEN_ESM,
        "lazy.test.js": "import test from 'node:test';\ntest('total sums', async () => { await import('./broken.js'); });\n",
      },
    },
    "import of a file with a syntax error in a before hook": {
      entry: "hook.test.js",
      files: {
        "broken.js": BROKEN_ESM,
        "hook.test.js": [
          "import test, { before } from 'node:test';",
          "before(async () => { await import('./broken.js'); });",
          "test('total sums', () => {});",
          "",
        ].join("\n"),
      },
    },
    "require of a file with a syntax error": {
      entry: "required.test.cjs",
      files: {
        "broken.cjs": BROKEN_CJS,
        "required.test.cjs":
          "const test = require('node:test');\ntest('total', () => { require('./broken.cjs'); });\n",
      },
    },
    "dynamic import of a file with an unterminated string": {
      entry: "unterminated.test.js",
      files: {
        "broken2.js": UNTERMINATED,
        "unterminated.test.js": "import test from 'node:test';\ntest('name', async () => { await import('./broken2.js'); });\n",
      },
    },
  };

  for (const reporter of ["tap", "spec"]) {
    for (const [fault, { entry, files }] of Object.entries(SYNTAX_FAULTS)) {
      it(`A missing module is INVALID_RED with exit 64 (${fault}, ${reporter})`, async () => {
        const run = await runNodeCart(
          ["--no-jev", "--format=json", "--tdd-phase=red"],
          [`--test-reporter=${reporter}`, entry],
          { files },
        );
        const envelope = JSON.parse(run.stdout) as DigestEnvelope;

        expect(run.code).toBe(64);
        expect(envelope.status).toBe("INVALID_RED");
        expect(clustersOf(envelope).map((c) => c.error_kind)).toEqual(["SYNTAX_IMPORT_ERROR"]);
      });
    }

    it(`A missing export is VALID_RED with exit 0 (JSON.parse('abc') inside a test, ${reporter})`, async () => {
      const run = await runNodeCart(
        ["--no-jev", "--format=json", "--tdd-phase=red"],
        [`--test-reporter=${reporter}`, "parses-text.test.js"],
        {
          files: {
            "parses-text.test.js":
              "import test from 'node:test';\ntest('parses', () => { JSON.parse('abc'); });\n",
          },
        },
      );
      const envelope = JSON.parse(run.stdout) as DigestEnvelope;

      expect(run.code).toBe(0);
      expect(envelope.status).toBe("VALID_RED");
      expect(clustersOf(envelope).map((c) => c.error_kind)).toEqual(["RUNTIME_EXCEPTION"]);
    });
  }
});
