import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInCart, runNodeCart } from "./helpers/node-cart.js";

const NO_JEV = ["--no-jev"];
const CART_IDS = ["c_53a8182a", "c_6edce10a", "c_9721831d", "c_fdff652c"];

interface RecordFile {
  [key: string]: unknown;
  clusters: { cluster_id: string; raw_log_lines: string }[];
  summary: { passed: number; failed: number };
}

function logsOf(home: string): string[] {
  return fs.readdirSync(path.join(home, "logs")).sort();
}

function onlyRecord(home: string): { record: RecordFile; log: string } {
  const json = logsOf(home).filter((name) => name.endsWith(".json"));
  expect(json).toHaveLength(1);
  const file = path.join(home, "logs", json[0] ?? "");
  const record = JSON.parse(fs.readFileSync(file, "utf8")) as RecordFile;
  return { record, log: file.replace(/\.json$/, ".log") };
}

describe("the run record (run-record)", () => {
  it("A failing node run leaves a complete record", async () => {
    const run = await runNodeCart(NO_JEV, ["cart.test.js"]);
    expect(run.code).toBe(1);

    const names = logsOf(run.home);
    expect(names).toHaveLength(2);
    expect(names.some((name) => name.endsWith(".tmp"))).toBe(false);
    const [json, log] = names;
    expect(json).toMatch(/^run_[0-9a-z]{9,}\.json$/);
    expect(log).toBe(json?.replace(/\.json$/, ".log"));

    const { record, log: logPath } = onlyRecord(run.home);
    expect(record).toMatchObject({
      schema: 1,
      run_id: json?.replace(/\.json$/, ""),
      source: "run",
      command: [process.execPath, "--test", "cart.test.js"],
      cwd: run.dir,
      exit_code: 1,
      child_exit_code: 1,
      signal: null,
      phase: "none",
      status: "FAIL",
    });
    expect(record.summary.passed).toBe(2);
    expect(record.summary.failed).toBe(4);

    const logText = fs.readFileSync(logPath, "utf8");
    expect(record["raw_lines"]).toBe(logText.split("\n").length - 1);
    expect(record["raw_bytes"]).toBe(fs.statSync(logPath).size);
    expect(record["digest_bytes"]).toBe(Buffer.byteLength(run.stdout, "utf8"));

    expect(record.clusters.map((cluster) => cluster.cluster_id).sort()).toEqual(CART_IDS);
    for (const cluster of record.clusters) expect(cluster.raw_log_lines).toMatch(/^L\d+-L\d+$/);
  });

  it("The record keeps the phase, scope and options", async () => {
    const flags = [...NO_JEV, "--tdd-phase=red", "--scope-id=r1", "--max-clusters=2", "--context-lines=0"];
    const run = await runNodeCart(flags, ["cart.test.js"]);
    const { record } = onlyRecord(run.home);
    expect(record).toMatchObject({
      phase: "red",
      scope_id: "r1",
      status: "VALID_RED",
      exit_code: 0,
      child_exit_code: 1,
    });
    expect(record["options"]).toEqual({ max_clusters: 2, context_lines: 0, no_jev: true, retry_flakes: false });
    // Two clusters were shown, two omitted: the record keeps all four.
    expect(record.clusters.map((cluster) => cluster.cluster_id).sort()).toEqual(CART_IDS);
  });

  it("A killed child is recorded with its signal", async () => {
    const run = await runInCart(NO_JEV, ["sh", "-c", "kill -TERM $$"]);
    const { record } = onlyRecord(run.home);
    expect(record).toMatchObject({ signal: "SIGTERM", exit_code: 143, child_exit_code: 143 });
  });

  it("A failure to write the record never changes the exit code", async () => {
    const writeRecord = (): never => {
      throw new Error("disk full");
    };
    const failing = await runNodeCart(NO_JEV, ["cart.test.js"], { deps: { writeRecord } });
    const normal = await runNodeCart(NO_JEV, ["cart.test.js"]);
    expect(failing.code).toBe(1);
    expect(failing.stderr).toBe("dot-test-digest: could not write the run record: disk full\n");
    const strip = (run: { stdout: string; dir: string }): string =>
      run.stdout.replaceAll(run.dir, "<cart>").replace(/\d+ms/g, "<t>ms").replace(/log: \S+/g, "log: <log>");
    expect(strip(failing)).toBe(strip(normal));
    expect(failing.stdout).toMatch(/^\[FAIL\] 4 failed/);
  });
});
