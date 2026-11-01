import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInCart, runNodeCart } from "./helpers/node-cart.js";

interface Cluster {
  cluster_id: string;
  error_kind: string;
  affected_count: number;
  top_frame: string;
  message: string;
  diff?: { expected: string; received: string };
  sample_tests: string[];
  pruned_stack: string[];
  signal_window: string;
}

interface Envelope {
  status: string;
  execution_gear: string;
  summary: { passed: number; failed: number; skipped: number; total_clusters: number };
  clusters: Cluster[];
}

function baselineOf(home: string, scope: string): string[] {
  const raw = fs.readFileSync(path.join(home, `state-${scope}.json`), "utf8");
  return (JSON.parse(raw) as { baseline: string[] }).baseline;
}

describe("node --test, TAP diagnostic blocks", () => {
  it("The cart run with the default (TAP) reporter yields four distinct clusters", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], ["cart.test.js"]);
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(run.code).toBe(1);
    expect(envelope.status).toBe("FAIL");
    expect(envelope.execution_gear).toBe("GEAR_0_GRAMMAR");
    expect(envelope.summary).toEqual({ passed: 2, failed: 4, skipped: 0, total_clusters: 4 });

    const view = envelope.clusters.map((c) => ({
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
    for (const cluster of envelope.clusters) {
      expect(cluster.top_frame).not.toBe("unknown:0:0");
      expect(cluster.message).not.toBe("Unknown test failure");
    }
  });

  it("Each node failure gets a SignalWindow from the right file", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], ["cart.test.js"]);
    const envelope = JSON.parse(run.stdout) as Envelope;
    const byId = (id: string): Cluster => {
      const found = envelope.clusters.find((c) => c.cluster_id === id);
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
    for (const cluster of envelope.clusters) {
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
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(run.code).toBe(1);
    expect(envelope.summary.passed).toBe(1);
    expect(envelope.summary.failed).toBe(3);
    expect(envelope.summary.skipped).toBe(0);
    expect(envelope.clusters.flatMap((c) => c.sample_tests).sort()).toEqual([
      "discount 10% leaves 90%",
      "names match",
      "slow",
    ]);
    expect(envelope.clusters.reduce((sum, c) => sum + c.affected_count, 0)).toBe(3);

    const names = envelope.clusters.find((c) => c.sample_tests.includes("names match"));
    expect(names?.error_kind).toBe("ASSERTION_FAILURE");
    expect(names?.top_frame).toBe("suite.test.js:7:34");
    expect(names?.message).toBe(
      "AssertionError: Expected values to be strictly deep-equal: + actual - expected { + a: 1 - a: 2 }",
    );
    expect(names?.diff).toEqual({ expected: "a: 2", received: "a: 1" });

    const slow = envelope.clusters.find((c) => c.sample_tests.includes("slow"));
    expect(slow?.error_kind).toBe("TIMEOUT_OR_CONN_REFUSED");
    expect(slow?.message).toBe("test timed out after 20ms");
    expect(slow?.top_frame).toBe("unknown:0:0");
    expect(slow?.signal_window).toBe("");
  });
});

describe("node --test, same-named failures under TAP", () => {
  it("Two same-named failing tests in one file stay two failures under TAP", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], ["same-name.test.js"]);
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(run.code).toBe(1);
    expect(envelope.summary).toEqual({ passed: 0, failed: 2, skipped: 0, total_clusters: 2 });
    expect(envelope.clusters.reduce((sum, c) => sum + c.affected_count, 0)).toBe(2);
    expect(
      envelope.clusters.map((c) => ({
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
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(run.code).toBe(1);
    expect(envelope.summary.failed).toBe(1);
    expect(envelope.summary.total_clusters).toBe(1);
    const cluster = envelope.clusters[0];
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
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(run.code).toBe(1);
    expect(envelope.summary.total_clusters).toBe(1);
    expect(envelope.clusters[0]?.error_kind).toBe("RUNTIME_EXCEPTION");
    expect(envelope.clusters[0]?.message).toBe(
      "SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'",
    );
  });
});

describe("node --test, two crashing files under TAP", () => {
  it("Two crashing files under TAP each carry their own subprocess error", async () => {
    const files = ["missing-module.test.js", "missing-export.test.js"];
    const run = await runNodeCart(["--no-jev", "--format=json"], files);
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(run.code).toBe(1);
    expect(envelope.summary).toEqual({ passed: 0, failed: 2, skipped: 0, total_clusters: 2 });
    expect(envelope.clusters.reduce((sum, c) => sum + c.affected_count, 0)).toBe(2);
    const moduleCluster = envelope.clusters.find((c) => c.sample_tests[0] === "missing-module.test.js");
    const exportCluster = envelope.clusters.find((c) => c.sample_tests[0] === "missing-export.test.js");
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
    expect(run.stderr).toContain(
      "Test failed due to syntax or unresolved module import rather than a behavioral assertion.",
    );
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
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(run.code).toBe(1);
    expect(envelope.status).toBe("FAIL");
    expect(envelope.execution_gear).toBe("GEAR_0_GRAMMAR");
    expect(envelope.summary).toEqual({ passed: 2, failed: 4, skipped: 0, total_clusters: 4 });
    expect(envelope.clusters.map((c) => c.error_kind)).not.toContain("UNSTRUCTURED_BUILD_ERROR");
  });
});

describe("node --test, spec reporter parity with TAP", () => {
  it("The spec reporter yields the same clusters as the TAP reporter", async () => {
    const spec = JSON.parse(
      (await runNodeCart(["--no-jev", "--format=json"], [SPEC, "cart.test.js"])).stdout,
    ) as Envelope;
    const tap = JSON.parse(
      (await runNodeCart(["--no-jev", "--format=json"], ["--test-reporter=tap", "cart.test.js"])).stdout,
    ) as Envelope;

    const ids = ["c_9721831d", "c_6edce10a", "c_fdff652c", "c_53a8182a"];
    expect(spec.clusters.map((c) => c.cluster_id)).toEqual(ids);
    expect(tap.clusters.map((c) => c.cluster_id)).toEqual(ids);
    const view = (e: Envelope) =>
      e.clusters.map((c) => [c.error_kind, c.top_frame, c.message, c.sample_tests]);
    expect(view(spec)).toEqual(view(tap));
    expect(spec.clusters.map((c) => c.diff)).toEqual([
      { expected: "900", received: "0" },
      { expected: "1634", received: "0" },
      { expected: "0", received: "-16335" },
      undefined,
    ]);
  });
});

describe("node --test, string values in diffs", () => {
  it("String values in diffs are unquoted under both reporters", async () => {
    for (const reporter of ["tap", "spec"]) {
      const run = await runNodeCart(
        ["--no-jev", "--format=json"],
        [`--test-reporter=${reporter}`, "string-diff.test.js"],
      );
      const envelope = JSON.parse(run.stdout) as Envelope;

      expect(run.code).toBe(1);
      expect(envelope.clusters).toHaveLength(1);
      const cluster = envelope.clusters[0];
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
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(envelope.summary).toMatchObject({ passed: 1, failed: 3, skipped: 0 });
    expect(envelope.clusters.flatMap((c) => c.sample_tests).sort()).toEqual([
      "discount 10% leaves 90%",
      "names match",
      "slow",
    ]);
    const slow = envelope.clusters.find((c) => c.sample_tests.includes("slow"));
    expect(slow?.error_kind).toBe("TIMEOUT_OR_CONN_REFUSED");
    expect(slow?.message).toBe("test timed out after 20ms");
    const names = envelope.clusters.find((c) => c.sample_tests.includes("names match"));
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
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(run.code).toBe(1);
    expect(envelope.summary).toEqual({ passed: 0, failed: 2, skipped: 0, total_clusters: 2 });
    expect(envelope.clusters.reduce((sum, c) => sum + c.affected_count, 0)).toBe(2);
    expect(
      envelope.clusters.map((c) => ({
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
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(run.code).toBe(1);
    expect(envelope.status).toBe("FAIL");
    expect(envelope.execution_gear).toBe("GEAR_0_GRAMMAR");
    expect(envelope.summary).toEqual({ passed: 2, failed: 4, skipped: 0, total_clusters: 1 });
    expect(envelope.clusters).toHaveLength(1);
    const cluster = envelope.clusters[0] as Cluster & { raw_log_lines: string };
    expect(cluster.cluster_id).toBe("c_11eac407");
    expect(cluster.error_kind).toBe("RUNTIME_EXCEPTION");
    expect(cluster.affected_count).toBe(4);
    expect(cluster.top_frame).toBe("unknown:0:0");
    expect(cluster.message).toBe("Unknown test failure");
    expect(cluster.sample_tests).toEqual([
      "discount 10% leaves 90%",
      "total with 10% off",
      "total with 100% off is free",
    ]);
    expect(cluster.raw_log_lines).toBe("L3-L6");
  });
});

describe("node --test, file-level spec failures", () => {
  it("A missing module under the spec reporter is one SYNTAX_IMPORT_ERROR failure", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], [SPEC, "missing-module.test.js"]);
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(envelope.status).toBe("FAIL");
    expect(envelope.summary.failed).toBe(1);
    expect(envelope.summary.total_clusters).toBe(1);
    const cluster = envelope.clusters[0];
    expect(cluster?.error_kind).toBe("SYNTAX_IMPORT_ERROR");
    expect(cluster?.sample_tests).toEqual(["missing-module.test.js"]);
    expect(cluster?.message.startsWith("Error: Cannot find module '")).toBe(true);
  });
});

describe("node --test, file-level spec failures (missing export)", () => {
  it("A missing export under the spec reporter is a RUNTIME_EXCEPTION failure", async () => {
    const run = await runNodeCart(["--no-jev", "--format=json"], [SPEC, "missing-export.test.js"]);
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(envelope.summary.total_clusters).toBe(1);
    expect(envelope.clusters[0]?.error_kind).toBe("RUNTIME_EXCEPTION");
    expect(envelope.clusters[0]?.message).toBe(
      "SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'",
    );
  });
});

describe("node --test, two crashing files under the spec reporter", () => {
  it("Two crashing files under the spec reporter each carry their own subprocess error", async () => {
    const files = [SPEC, "missing-module.test.js", "missing-export.test.js"];
    const run = await runNodeCart(["--no-jev", "--format=json"], files);
    const envelope = JSON.parse(run.stdout) as Envelope;

    expect(run.code).toBe(1);
    expect(envelope.status).toBe("FAIL");
    expect(envelope.summary).toEqual({ passed: 0, failed: 2, skipped: 0, total_clusters: 2 });
    expect(envelope.clusters.reduce((sum, c) => sum + c.affected_count, 0)).toBe(2);
    const moduleCluster = envelope.clusters.find((c) => c.sample_tests[0] === "missing-module.test.js");
    const exportCluster = envelope.clusters.find((c) => c.sample_tests[0] === "missing-export.test.js");
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
    expect(run.stderr).toContain(
      "Test failed due to syntax or unresolved module import rather than a behavioral assertion.",
    );
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
