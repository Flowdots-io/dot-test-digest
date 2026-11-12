import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MainDeps } from "../src/index.js";
import type { RunRecord } from "../src/runner/run-record.js";
import type { DigestEnvelope } from "../src/types/schema.js";
import { markRepositoryRoot } from "./helpers/hermetic-env.js";
import { runMain, tempDir } from "./helpers/node-cart.js";

const ROOT = process.cwd();
const TSC_LOG = "tests/fixtures/tsc-small/tsc.log";
const TAP_LOG = "tests/fixtures/logs/node-tap-cart.log";
const CART_IDS = ["c_9721831d", "c_6edce10a", "c_fdff652c", "c_53a8182a"];

const offline: MainDeps = {
  client: {
    isConfigured: () => {
      throw new Error("digest called the Jev client");
    },
    ask: () => {
      throw new Error("digest called the Jev client");
    },
  },
};

/** A fresh home and a working directory holding copies of the fixture logs at their repository paths. */
function workspace(files: Readonly<Record<string, string>> = {}): { cwd: string; home: string } {
  const cwd = tempDir("dtd-digest-");
  markRepositoryRoot(cwd);
  for (const relative of [TSC_LOG, TAP_LOG]) {
    fs.mkdirSync(path.dirname(path.join(cwd, relative)), { recursive: true });
    fs.copyFileSync(path.join(ROOT, relative), path.join(cwd, relative));
  }
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(cwd, name), contents);
  return { cwd, home: tempDir("dtd-digest-home-") };
}

function digest(args: readonly string[], where: { cwd: string; home: string }, deps: MainDeps = {}) {
  return runMain(["digest", ...args], { ...where, deps: { ...offline, ...deps } });
}

function fixtureLines(relative: string): string[] {
  return fs.readFileSync(path.join(ROOT, relative), "utf8").split("\n").slice(0, -1);
}

function onlyRecord(home: string): RunRecord {
  const logs = path.join(home, "logs");
  const records = fs.readdirSync(logs).filter((name) => name.endsWith(".json"));
  expect(records).toHaveLength(1);
  return JSON.parse(fs.readFileSync(path.join(logs, records[0] ?? ""), "utf8")) as RunRecord;
}

describe("digest (digest-input)", () => {
  it("A compiler log with an explicit exit code", async () => {
    const where = workspace();
    const run = await digest([TSC_LOG, "--exit-code", "2"], where);
    expect(run.code, run.stderr).toBe(2);
    const [header, ...rest] = run.stdout.split("\n");
    expect(header).toMatch(/^\[FAIL\] 5 failed, 0 passed \| 5 clusters \| log: \S+\.log$/);
    expect(rest.join("\n")).toBe(fs.readFileSync(path.join(ROOT, TSC_LOG), "utf8"));
  });

  it("The exit code is inferred when absent", async () => {
    const where = workspace({ "ok.log": "all good\n" });
    const failing = await digest([TSC_LOG], where);
    expect(failing.code, failing.stderr).toBe(1);
    const passing = await digest(["ok.log"], where);
    expect(passing.code, passing.stderr).toBe(0);
    expect(passing.stdout).toMatch(/^\[PASS\] exit 0 \| log: \S+\.log\n$/);
  });

  it("A TAP log from another machine", async () => {
    const where = workspace();
    const run = await digest([TAP_LOG], where);
    expect(run.code, run.stderr).toBe(1);
    expect(run.stdout.split("\n")[0]).toMatch(/^\[FAIL\] 4 failed, 2 passed \| \d clusters \| log: \S+\.log$/);
    for (const id of CART_IDS) expect(run.stdout).toContain(id);
    const blocks = run.stdout.split("\n").filter((line) => line.startsWith("c_")).length;
    const listed = run.stdout.split("\n").filter((line) => line.startsWith("  c_")).length;
    expect(blocks + listed).toBe(4);
    // A source window line is `  <n> | ...` or `  <n> > ...`; none can be read here.
    expect(run.stdout).not.toMatch(/^ {2,}\d+ [|>] /m);
  });

  it("The log keeps the input's line numbers and can be read back", async () => {
    const where = workspace();
    await digest([TAP_LOG], where);
    const shown = await runMain(["show", "last", "L15-L17"], where);
    expect(shown.code, shown.stderr).toBe(0);
    expect(shown.stdout).toBe(`${fixtureLines(TAP_LOG).slice(14, 17).join("\n")}\n`);
    const record = onlyRecord(where.home);
    expect(record.source).toBe("digest");
    expect(record.command).toEqual([]);
    expect(record.input).toBe(TAP_LOG);
  });

  it("digest as JSON", async () => {
    const where = workspace();
    const run = await digest([TAP_LOG, "--format=json"], where);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;
    expect(envelope.status).toBe("FAIL");
    expect(envelope.exit_code).toBe(1);
    expect(envelope.duration_ms).toBe(0);
    expect(run.code).toBe(1);
  });

  it("Bad input is rejected", async () => {
    const where = workspace({ "empty.log": "", "ok.log": "all good\n" });
    const cases: [readonly string[], number, string][] = [
      [["empty.log"], 64, "input is empty"],
      [["missing.log"], 66, "cannot read missing.log: ENOENT"],
      [["ok.log", "--exit-code", "300"], 64, "--exit-code must be an integer between 0 and 255, got 300"],
      [["ok.log", "--tdd-phase=red"], 64, "--tdd-phase is not supported by digest"],
    ];
    for (const [args, code, message] of cases) {
      const run = await digest(args, where);
      expect({ args, code: run.code, stderr: run.stderr, stdout: run.stdout }).toEqual({
        args,
        code,
        stderr: `${message}\n`,
        stdout: "",
      });
    }
  });

  it("A terminal on stdin is rejected", async () => {
    const where = workspace();
    const run = await digest(["-"], where, { stdinIsTTY: true });
    expect(run.code).toBe(64);
    expect(run.stderr).toBe('no input: pipe a log into "digest -"\n');
  });
});
