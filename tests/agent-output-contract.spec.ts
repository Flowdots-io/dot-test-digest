import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { Ajv2020 } from "ajv/dist/2020.js";
import { describe, expect, it } from "vitest";
import { runJson, runMain, runNodeCart, tempDir, type CartRun } from "./helpers/node-cart.js";

const NO_JEV = ["--no-jev"];
const SCHEMA_FILE = path.join(process.cwd(), "schema", "digest-envelope.schema.json");

type Line = Record<string, unknown> & { type: string };

function ndjsonLines(stdout: string): Line[] {
  expect(stdout.endsWith("\n")).toBe(true);
  return stdout
    .slice(0, -1)
    .split("\n")
    .map((line) => JSON.parse(line) as Line);
}

function runIdOf(logPath: string): string {
  return path.basename(logPath, ".log");
}

describe("the JSON envelope (agent-output-contract)", () => {
  it("JSON of a failing run", async () => {
    const { run, envelope } = await runJson(["cart.test.js"], { flags: ["--max-clusters=2"] });
    expect(run.code).toBe(1);
    const logs = fs.readdirSync(path.join(run.home, "logs")).filter((file) => file.endsWith(".log"));
    expect(logs).toHaveLength(1);
    expect(envelope).toMatchObject({ schema_version: 1, run_id: path.basename(logs[0] ?? "", ".log") });
    expect(envelope.summary).toEqual({ passed: 2, failed: 4, skipped: 0, total_clusters: 2, omitted_clusters: 2 });
  });

  it("JSON of a passing run has no omitted count", async () => {
    const { run, envelope } = await runJson(["passing.test.js"]);
    expect(run.code).toBe(0);
    expect(Object.keys(envelope)).toEqual([
      "status",
      "tdd_phase",
      "exit_code",
      "signal",
      "execution_gear",
      "duration_ms",
      "summary",
      "raw_log_path",
      "schema_version",
      "run_id",
    ]);
    expect(envelope.summary).not.toHaveProperty("omitted_clusters");
    expect(envelope.run_id).toBe(runIdOf(envelope.raw_log_path));
  });
});

describe("the JSON Schema (agent-output-contract)", () => {
  it("The committed file matches the generator", () => {
    const out = path.join(tempDir("dtd-schema-"), "digest-envelope.schema.json");
    const generated = spawnSync("pnpm", ["run", "schema", out], { encoding: "utf8" });
    expect(generated.status, generated.stderr).toBe(0);
    expect(fs.readFileSync(out, "utf8")).toBe(fs.readFileSync(SCHEMA_FILE, "utf8"));
  });

  it("Real envelopes validate", async () => {
    const schema = JSON.parse(fs.readFileSync(SCHEMA_FILE, "utf8")) as Record<string, unknown>;
    expect(schema["$schema"]).toBe("https://json-schema.org/draft/2020-12/schema");
    const validate = new Ajv2020({ strict: true }).compile(schema);
    const runs = [
      await runNodeCart([...NO_JEV, "--format=json"], ["passing.test.js"]),
      await runNodeCart([...NO_JEV, "--format=json"], ["cart.test.js"]),
      await runNodeCart([...NO_JEV, "--format=json", "--tdd-phase=red", "--scope-id=s1"], ["cart.test.js"]),
    ];
    expect(runs.map((run) => (JSON.parse(run.stdout) as { status: string }).status)).toEqual([
      "PASS",
      "FAIL",
      "VALID_RED",
    ]);
    for (const run of runs) {
      expect(validate(JSON.parse(run.stdout)), JSON.stringify(validate.errors)).toBe(true);
    }
  });

  it("The schema subcommand prints the file", async () => {
    const home = tempDir("dtd-schema-home-");
    const run = await runMain(["schema"], { cwd: home, home });
    expect(run.stdout).toBe(fs.readFileSync(SCHEMA_FILE, "utf8"));
    expect(run.code).toBe(0);
  });
});

describe("ndjson (agent-output-contract)", () => {
  it("The cart as ndjson", async () => {
    const run = await runNodeCart([...NO_JEV, "--format=ndjson", "--max-clusters=2"], ["cart.test.js"]);
    expect(run.code).toBe(1);
    const lines = ndjsonLines(run.stdout);
    expect(lines.map((line) => line.type)).toEqual(["summary", "cluster", "cluster", "omitted", "omitted"]);
    const [summary] = lines;
    expect(summary).toMatchObject({ status: "FAIL", exit_code: 1, schema_version: 1, summary: { total_clusters: 2 } });
    expect(summary).not.toHaveProperty("clusters");
    expect(summary?.["run_id"]).toBe(runIdOf(String(summary?.["raw_log_path"])));
    expect(lines.slice(3).map((line) => line["cluster_id"])).toEqual(["c_fdff652c", "c_53a8182a"]);
    expect(Object.keys(lines[3] ?? {})).toEqual(
      expect.arrayContaining(["type", "cluster_id", "error_kind", "affected_count", "top_frame", "label", "raw_log_lines"]),
    );
  });

  it("A pass is one line", async () => {
    const run = await runNodeCart([...NO_JEV, "--format=ndjson"], ["passing.test.js"]);
    expect(run.code).toBe(0);
    const lines = ndjsonLines(run.stdout);
    expect(lines).toHaveLength(1);
    expect(lines[0]).toMatchObject({ type: "summary", status: "PASS" });
  });

  it("The format is accepted wherever json is", async () => {
    const live: CartRun = await runNodeCart([...NO_JEV, "--format=ndjson", "--max-clusters=2"], ["cart.test.js"]);
    const replayed = await runMain(["replay", "last", "--format=ndjson"], { cwd: live.dir, home: live.home });
    expect(replayed.code).toBe(1);
    expect(ndjsonLines(replayed.stdout).map((line) => line.type)).toEqual(
      ndjsonLines(live.stdout).map((line) => line.type),
    );
  });
});
