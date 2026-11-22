import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import type { MainDeps } from "../src/index.js";
import type { RunRecord } from "../src/runner/run-record.js";
import type { DigestEnvelope } from "../src/types/schema.js";
import { hermeticEnv, markRepositoryRoot } from "./helpers/hermetic-env.js";
import { runMain, tempDir } from "./helpers/node-cart.js";

const ROOT = process.cwd();
const TSC_LOG = "tests/fixtures/tsc-small/tsc.log";
const TAP_LOG = "tests/fixtures/logs/node-tap-cart.log";
/** The failing tests of the TAP log; cluster ids hash the log's `__ROOT__` paths, so the names identify them. */
const TAP_FAILURES = [
  "discount 10% leaves 90%",
  "total with 10% off",
  "total with 100% off is free",
  "first of an empty cart is undefined",
];

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
    for (const test of TAP_FAILURES) expect(run.stdout).toContain(test);
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
    expect(run.code, run.stderr).toBe(1);
    const envelope = JSON.parse(run.stdout) as DigestEnvelope;
    expect(envelope.status).toBe("FAIL");
    expect(envelope.exit_code).toBe(1);
    expect(envelope.duration_ms).toBe(0);
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

/** A pytest failure whose only frame is `frame`, so the window is read from the file the frame names. */
function pytestFailure(test: string, frame: string): string {
  return [
    `___________________________________ ${test} ___________________________________`,
    "",
    `    def ${test}():`,
    `>       assert ${test}() == 100`,
    `E       AssertionError: assert 99 == 100 in ${test}`,
    "",
    `${frame}: in ${test}`,
    `    assert ${test}() == 100`,
  ].join("\n");
}

function pytestLog(failures: readonly [string, string][]): string {
  return `${[
    "============================= test session starts ==============================",
    `collected ${failures.length} items`,
    "",
    "=================================== FAILURES ===================================",
    ...failures.map(([test, frame]) => pytestFailure(test, frame)),
    "=========================== short test summary info ============================",
    ...failures.map(([test]) => `FAILED tests/test_x.py::${test} - AssertionError: assert 99 == 100 in ${test}`),
    `========================= ${failures.length} failed in 0.12s =========================`,
  ].join("\n")}\n`;
}

describe("digest reads source windows only inside the working directory", () => {
  it("frames outside the directory, by absolute path, ../ or a symlink, get no window; their clusters stay", async () => {
    const top = tempDir("dtd-digest-confine-");
    const secret = Array.from({ length: 6 }, (_, index) => `SECRET_LINE_${index + 1}`).join("\n");
    fs.mkdirSync(path.join(top, "outside"));
    fs.writeFileSync(path.join(top, "outside", "secret.py"), `${secret}\n`);
    const cwd = path.join(top, "work");
    fs.mkdirSync(cwd);
    markRepositoryRoot(cwd);
    fs.writeFileSync(path.join(cwd, "inside.py"), "inside_1\ninside_2\ninside_3\n");
    fs.symlinkSync(path.join(top, "outside", "secret.py"), path.join(cwd, "link.py"));
    fs.writeFileSync(
      path.join(top, "evil.log"),
      pytestLog([
        ["test_absolute", `${path.join(top, "outside", "secret.py")}:2`],
        ["test_parent", "../outside/secret.py:3"],
        ["test_symlink", "link.py:4"],
        ["test_inside", "inside.py:2"],
      ]),
    );
    const where = { cwd, home: tempDir("dtd-digest-home-") };

    const run = await digest(["../evil.log", "--format=json", "--max-clusters=15"], where);
    expect(run.code, run.stderr).toBe(1);
    expect(run.stdout).not.toContain("SECRET_LINE");
    const clusters = (JSON.parse(run.stdout) as DigestEnvelope).clusters ?? [];
    expect(clusters.map((cluster) => cluster.sample_tests[0]).sort()).toEqual(
      ["test_absolute", "test_inside", "test_parent", "test_symlink"],
    );
    const inside = clusters.find((cluster) => cluster.sample_tests[0] === "test_inside");
    expect(inside?.signal_window).toBe("1 | inside_1\n2 > inside_2\n3 | inside_3");

    const replayed = await runMain(["replay", "last", "--format=json", "--max-clusters=15"], { ...where, deps: offline });
    expect(replayed.code, replayed.stderr).toBe(1);
    expect(replayed.stdout).not.toContain("SECRET_LINE");
  });
});

describe("digest review fixes", () => {
  it("replay of a digest record prints the digest again, without in <t>ms", async () => {
    const where = workspace();
    const first = await digest([TAP_LOG], where);
    const again = await runMain(["replay", "last"], { ...where, deps: offline });
    expect(again.code).toBe(first.code);
    expect(again.stdout).toBe(first.stdout);
  });

  it("a record that cannot be written or a prune that fails keeps the exit code (INV-3)", async () => {
    const where = workspace();
    const noRecord = await digest([TSC_LOG, "--exit-code", "2"], where, {
      writeRecord: () => {
        throw new Error("disk full");
      },
    });
    expect(noRecord.code).toBe(2);
    expect(noRecord.stderr).toBe("dot-test-digest: could not write the run record: disk full\n");
    const noPrune = await digest([TSC_LOG], where, {
      prune: () => {
        throw new Error("locked");
      },
    });
    expect(noPrune.code).toBe(1);
    expect(noPrune.stderr).toBe("dot-test-digest: could not prune the cache: locked\n");
  });

  it("--no-jev takes true or false like a run's boolean flags, and overrides the configuration", async () => {
    const noise = Array.from({ length: 200 }, (_, index) => `step ${index}: something happened`).join("\n");
    const where = workspace({ "noise.log": `${noise}\n` });
    const asked: string[] = [];
    const counting: MainDeps = {
      env: { ...hermeticEnv(), DOT_TEST_DIGEST_NO_JEV: "1" },
      client: {
        isConfigured: () => {
          asked.push("isConfigured");
          return false;
        },
        ask: () => {
          throw new Error("not configured");
        },
      },
    };
    const off = await runMain(["digest", "noise.log", "--exit-code", "1", "--no-jev=true"], { ...where, deps: counting });
    expect(off.code, off.stderr).toBe(1);
    expect(asked).toEqual([]);
    const on = await runMain(["digest", "noise.log", "--exit-code", "1", "--no-jev=false"], { ...where, deps: counting });
    expect(on.code, on.stderr).toBe(1);
    expect(asked).toEqual(["isConfigured"]);
    const bad = await digest(["noise.log", "--no-jev=maybe"], where);
    expect(bad.code).toBe(64);
    expect(bad.stderr).toBe("--no-jev accepts only true or false, got maybe\n");
  });

  it("-- ends the flags, so a file whose name starts with - can be digested", async () => {
    const where = workspace({ "-dash.log": "all good\n" });
    const run = await digest(["--", "-dash.log"], where);
    expect(run.code, run.stderr).toBe(0);
    expect(run.stdout).toMatch(/^\[PASS\] exit 0 \| log: \S+\.log\n$/);
    expect(onlyRecord(where.home).input).toBe("-dash.log");
  });
});
