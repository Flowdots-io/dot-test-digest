import { describe, expect, it } from "vitest";
import { runNodeCart } from "./helpers/node-cart.js";

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
});
