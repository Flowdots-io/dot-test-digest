import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { formatEnvelope } from "../src/formatters/envelope.js";
import type { DigestEnvelope } from "../src/types/schema.js";
import { markRepositoryRoot } from "./helpers/hermetic-env.js";
import { runMain, runNodeCart, source, tempDir } from "./helpers/node-cart.js";

const NO_JEV = ["--no-jev"];
const NEXT = /^next: dot-test-digest show (run_[0-9a-z]+) (c_[0-9a-f]{8})$/;
const TSC = path.join(process.cwd(), "node_modules", "typescript", "bin", "tsc");
const TSC_SMALL = path.join(process.cwd(), "tests", "fixtures", "tsc-small");

function lineTwo(stdout: string): string {
  return stdout.split("\n")[1] ?? "";
}

function nextTarget(stdout: string): { runId: string; clusterId: string } {
  const match = NEXT.exec(lineTwo(stdout));
  expect(match, lineTwo(stdout)).not.toBeNull();
  return { runId: match?.[1] ?? "", clusterId: match?.[2] ?? "" };
}

/** A failing envelope as a caller builds it by hand, without a run id. */
const HAND_BUILT: DigestEnvelope = {
  status: "FAIL",
  tdd_phase: "none",
  exit_code: 1,
  signal: null,
  execution_gear: "GEAR_0_GRAMMAR",
  duration_ms: 5,
  summary: { passed: 1, failed: 1, skipped: 0, total_clusters: 1 },
  clusters: [
    {
      cluster_id: "c_0000000a",
      fingerprint: "a".repeat(64),
      error_kind: "ASSERTION_FAILURE",
      affected_count: 1,
      sample_tests: ["adds"],
      message: "boom",
      top_frame: "a.test.js:1:1",
      pruned_stack: ["a.test.js:1:1"],
      signal_window: "",
      raw_log_lines: "L1-L2",
    },
  ],
  raw_log_path: "/tmp/x.log",
};

const HAND_BUILT_0_1 = [
  "[FAIL] 1 failed, 1 passed in 5ms | 1 cluster | log: /tmp/x.log",
  "c_0000000a ASSERTION_FAILURE x1 a.test.js:1:1",
  "  boom",
  "  tests: adds",
  "  raw: L1-L2",
  "",
].join("\n");

describe("the next line (agent-output-contract)", () => {
  it("Omitted clusters are the target", async () => {
    const run = await runNodeCart(NO_JEV, ["cart.test.js"]);
    expect(run.code).toBe(1);
    const { runId, clusterId } = nextTarget(run.stdout);
    const lines = run.stdout.split("\n");
    const footer = lines.findIndex((line) => /^\+\d+ more clusters \(see log\)$/.test(line));
    expect(footer).toBeGreaterThan(1);
    // The record lists every cluster in rank order; the first one without a full block is the target. Whether its
    // line fits after the footer depends on the length of the paths in the digest, so it is checked when it does.
    const record = JSON.parse(fs.readFileSync(path.join(run.home, "logs", `${runId}.json`), "utf8")) as {
      clusters: { cluster_id: string }[];
    };
    const fullBlocks = lines.filter((line) => line.startsWith("c_")).length;
    expect(clusterId).toBe(record.clusters[fullBlocks]?.cluster_id);
    const listed = lines[footer + 1];
    if (listed?.startsWith("  c_") === true) expect(listed.trim().split(" ")[0]).toBe(clusterId);
    expect(Buffer.byteLength(run.stdout, "utf8")).toBeLessThanOrEqual(2400);
  });

  it("With nothing omitted the target is the first cluster", async () => {
    const run = await runNodeCart(NO_JEV, ["one.test.js"], {
      files: {
        "one.test.js": source(
          'import { test } from "node:test";',
          'import assert from "node:assert/strict";',
          'test("one fails", () => assert.equal(1, 2));',
        ),
      },
    });
    expect(run.code).toBe(1);
    const blocks = run.stdout.split("\n").filter((line) => line.startsWith("c_"));
    expect(blocks).toHaveLength(1);
    expect(run.stdout).not.toMatch(/^\+\d+ more clusters/m);
    expect(nextTarget(run.stdout).clusterId).toBe(blocks[0]?.split(" ")[0]);
  });

  it("a digest that shows every cluster names its first one", () => {
    const digest = formatEnvelope({ ...HAND_BUILT, run_id: "run_abc123" }, "compact-md");
    expect(lineTwo(digest)).toBe("next: dot-test-digest show run_abc123 c_0000000a");
  });

  it("The printed command works", async () => {
    const run = await runNodeCart(NO_JEV, ["cart.test.js"]);
    const { runId, clusterId } = nextTarget(run.stdout);
    const record = JSON.parse(fs.readFileSync(path.join(run.home, "logs", `${runId}.json`), "utf8")) as {
      clusters: { cluster_id: string; raw_log_lines: string }[];
    };
    const range = record.clusters.find((cluster) => cluster.cluster_id === clusterId)?.raw_log_lines ?? "";
    const [, from, to] = /^L(\d+)-L(\d+)$/.exec(range) ?? [];
    const log = fs.readFileSync(path.join(run.home, "logs", `${runId}.log`), "utf8").split("\n");
    const expected = log.slice(Number(from) - 1, Number(to)).map((line) => `${line}\n`).join("");
    expect(expected).not.toBe("");

    const shown = await runMain(["show", runId, clusterId], { cwd: run.dir, home: run.home });
    expect(shown.stdout).toBe(expected);
    expect(shown.code).toBe(0);
  });

  it("No next line where the ladder shows raw text", async () => {
    const project = tempDir("dtd-tsc-small-");
    fs.cpSync(TSC_SMALL, project, { recursive: true });
    markRepositoryRoot(project);
    const tscLog = fs.readFileSync(path.join(project, "tsc.log"), "utf8");
    const run = await runMain(
      [
        ...NO_JEV,
        "--",
        process.execPath,
        "-e",
        "process.stdout.write(require('node:fs').readFileSync('tsc.log','utf8')); process.exit(2)",
      ],
      { cwd: project, home: tempDir("dtd-home-") },
    );
    const [header, ...rest] = run.stdout.split("\n");
    expect(header).toMatch(/^\[FAIL\] /);
    expect(rest.join("\n")).toBe(tscLog);
    expect(tscLog.split("\n").filter((line) => line !== "")).toHaveLength(5);
    expect(run.stdout).not.toMatch(/^next:/m);
  });

  it("No next line on a pass or a hand-built envelope", async () => {
    const pass = await runNodeCart(NO_JEV, ["passing.test.js"]);
    expect(pass.stdout).toMatch(/^\[PASS\] /);
    expect(pass.stdout).not.toMatch(/^next:/m);

    const digest = formatEnvelope(HAND_BUILT, "compact-md");
    expect(digest).not.toMatch(/^next:/m);
    expect(digest).toBe(HAND_BUILT_0_1);
  });

  it("The ceiling holds with the line", async () => {
    const project = tempDir("dtd-tsc-30-");
    fs.copyFileSync(path.join(TSC_SMALL, "tsconfig.json"), path.join(project, "tsconfig.json"));
    fs.mkdirSync(path.join(project, "src"));
    for (let n = 1; n <= 30; n += 1) {
      fs.writeFileSync(path.join(project, "src", `m${n}.ts`), `export const v${n}: number = "text ${n}";\n`);
    }
    markRepositoryRoot(project);
    const run = await runMain([...NO_JEV, "--max-clusters=5", "--", process.execPath, TSC, "--noEmit"], {
      cwd: project,
      home: tempDir("dtd-home-"),
    });
    expect(run.code).toBe(2);
    expect(Buffer.byteLength(run.stdout, "utf8")).toBeLessThanOrEqual(2400);
    expect(lineTwo(run.stdout)).toMatch(NEXT);
  });
});
