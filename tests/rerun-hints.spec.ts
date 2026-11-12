import { spawnSync } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { pythonAdapter } from "../src/adapters/python.js";
import { rustGoAdapter } from "../src/adapters/rust-go.js";
import { tscEslintAdapter } from "../src/adapters/tsc-eslint.js";
import { dedupeFailures } from "../src/pruner/cluster-dedup.js";
import type { CapturedLine } from "../src/runner/capture.js";
import type { DigestEnvelope, FailureCluster } from "../src/types/schema.js";
import { clustersOf } from "./helpers/digest.js";
import { markRepositoryRoot } from "./helpers/hermetic-env.js";
import { runInCart, runMain, source, tempDir } from "./helpers/node-cart.js";

const NO_JEV = ["--no-jev"];
const REPO = process.cwd();
const CART_RERUN = "node --test --test-name-pattern '^discount 10% leaves 90%$' cart.test.js";
const VITEST_RERUN = "npx vitest run tests/cart.test.ts -t 'discount 10% leaves 90%'";

function envelopeOf(stdout: string): DigestEnvelope {
  return JSON.parse(stdout) as DigestEnvelope;
}

function clusterById(envelope: DigestEnvelope, id: string): FailureCluster | undefined {
  return clustersOf(envelope).find((cluster) => cluster.cluster_id === id);
}

function shell(command: string, cwd: string): string {
  const run = spawnSync("sh", ["-c", command], { cwd, encoding: "utf8" });
  // eslint-disable-next-line no-control-regex
  return `${run.stdout}${run.stderr}`.replace(/\u001b\[[0-9;]*m/g, "");
}

/** A fresh copy of the vitest cart that resolves vitest from this repository's `node_modules`. */
function vitestCart(): string {
  const dir = fs.realpathSync(tempDir("dtd-vitest-cart-"));
  fs.cpSync(path.join(REPO, "tests", "fixtures", "vitest-cart"), dir, { recursive: true });
  fs.symlinkSync(path.join(REPO, "node_modules"), path.join(dir, "node_modules"), "dir");
  markRepositoryRoot(dir);
  return dir;
}

function nodeCartFailure(name: string): Record<string, string> {
  return {
    "cart.test.js": source('import { test } from "node:test";', `test(${JSON.stringify(name)}, () => { throw new Error("no"); });`),
  };
}

function captured(text: string): CapturedLine[] {
  return text.split("\n").map((line, index) => ({ stream: "stdout" as const, text: line, line: index + 1 }));
}

function rerunsOf(failures: Parameters<typeof dedupeFailures>[0]): (string | undefined)[] {
  const { kept } = dedupeFailures(failures, { repoRoot: "/nonexistent", contextLines: 0, keep: 15, logPath: "x.log" });
  return kept.map((cluster) => cluster.rerun);
}

const PYTEST = `============================= test session starts ==============================
collected 3 items

=================================== FAILURES ===================================
___________________________________ test_total ___________________________________

    def test_total():
>       assert cart.total() == 100
E       AssertionError: assert 99 == 100

tests/test_cart.py:12: in test_total
    assert cart.total() == 100
=========================== short test summary info ============================
FAILED tests/test_cart.py::test_total - AssertionError: assert 99 == 100
========================= 1 failed, 2 passed in 0.12s =========================`;

const CARGO = `running 3 tests
thread 'cart::tests::total' panicked at src/cart.rs:10:5:
assertion \`left == right\` failed

test result: FAILED. 2 passed; 1 failed; 0 ignored; 0 measured; 0 filtered out`;

const GO = `--- FAIL: TestTotal (0.00s)
    cart_test.go:12: got 99, want 100
FAIL
exit status 1
FAIL	example.com/cart	0.002s`;

const ESLINT = source("/abs/src/a.ts", "  4:1  error  'y' is not defined  no-undef");

describe("rerun hints (rerun-hints)", () => {
  it("rerun for node --test", async () => {
    const run = await runInCart([...NO_JEV, "--format=json"], ["node", "--test", "cart.test.js"]);
    expect(run.code).toBe(1);
    expect(clusterById(envelopeOf(run.stdout), "c_9721831d")?.rerun).toBe(CART_RERUN);
  });

  it("The rerun command really reruns that one test", async () => {
    const run = await runInCart([...NO_JEV, "--format=json"], ["node", "--test", "cart.test.js"]);
    const rerun = clusterById(envelopeOf(run.stdout), "c_9721831d")?.rerun;
    expect(rerun).toBe(CART_RERUN);
    const output = shell(rerun ?? "false", run.dir);
    expect(output).toMatch(/^# tests 1$/m);
    expect(output).toMatch(/^# pass 0$/m);
    expect(output).toMatch(/^# fail 1$/m);
  });

  it("vitest, with a prefix from the command", async () => {
    const dir = vitestCart();
    const run = await runMain([...NO_JEV, "--format=json", "--", "npx", "vitest", "run"], {
      cwd: dir,
      home: tempDir("dtd-home-"),
    });
    expect(run.code).toBe(1);
    expect(clusterById(envelopeOf(run.stdout), "c_992bb564")?.rerun).toBe(VITEST_RERUN);
  });

  it("vitest, executed", async () => {
    const dir = vitestCart();
    const run = await runMain([...NO_JEV, "--format=json", "--", "npx", "vitest", "run"], {
      cwd: dir,
      home: tempDir("dtd-home-"),
    });
    const rerun = clusterById(envelopeOf(run.stdout), "c_992bb564")?.rerun;
    expect(rerun).toBe(VITEST_RERUN);
    expect(shell(rerun ?? "false", dir)).toContain("1 failed | 28 skipped (29)");
  });

  it("Regular-expression characters in a name are escaped and quoted", async () => {
    const run = await runInCart([...NO_JEV, "--format=json"], ["node", "--test", "cart.test.js"], {
      files: nodeCartFailure("parses a.b (v2)"),
    });
    expect(clustersOf(envelopeOf(run.stdout)).map((cluster) => cluster.rerun)).toEqual([
      "node --test --test-name-pattern '^parses a\\.b \\(v2\\)$' cart.test.js",
    ]);
  });

  it("A single quote in a name is escaped for the shell", async () => {
    const run = await runInCart([...NO_JEV, "--format=json"], ["node", "--test", "cart.test.js"], {
      files: nodeCartFailure("it's broken"),
    });
    const [cluster] = clustersOf(envelopeOf(run.stdout));
    expect(cluster?.rerun).toContain("--test-name-pattern '^it'\\''s broken$'");
    // The quoting survives the shell: the pattern selects the test.
    expect(shell(cluster?.rerun ?? "false", run.dir)).toMatch(/^# fail 1$/m);
  });

  it("A wrapped script has no runner token", async () => {
    const files = { "package.json": JSON.stringify({ type: "module", scripts: { test: "node --test cart.test.js" } }) };
    const json = await runInCart([...NO_JEV, "--format=json"], ["pnpm", "test"], { files });
    const envelope = envelopeOf(json.stdout);
    expect(envelope.status).toBe("FAIL");
    expect(clustersOf(envelope).length).toBeGreaterThan(0);
    for (const cluster of clustersOf(envelope)) expect(cluster).not.toHaveProperty("rerun");

    const digest = await runInCart(NO_JEV, ["pnpm", "test"], { files });
    expect(digest.stdout).toMatch(/^c_/m);
    expect(digest.stdout).not.toMatch(/^ {2}rerun: /m);
  });

  it("pytest, cargo, go and eslint from fixtures", () => {
    expect(rerunsOf(pythonAdapter.parse(captured(PYTEST), ["pytest", "-q"]).failures)).toEqual([
      "pytest tests/test_cart.py::test_total",
    ]);
    expect(rerunsOf(rustGoAdapter.parse(captured(CARGO), ["cargo", "test"]).failures)).toEqual([
      "cargo test cart::tests::total -- --exact",
    ]);
    expect(rerunsOf(rustGoAdapter.parse(captured(GO), ["go", "test", "./..."]).failures)).toEqual([
      "go test -run '^TestTotal$' ./...",
    ]);
    expect(rerunsOf(tscEslintAdapter.parse(captured(ESLINT), ["eslint", "."]).failures)).toEqual([
      "eslint /abs/src/a.ts",
    ]);
  });

  it("tsc has no rerun", async () => {
    const dir = tempDir("dtd-tsc-small-");
    fs.cpSync(path.join(REPO, "tests", "fixtures", "tsc-small"), dir, { recursive: true });
    markRepositoryRoot(dir);
    const tsc = path.join(REPO, "node_modules", ".bin", "tsc");
    const run = await runMain([...NO_JEV, "--format=json", "--", tsc, "--noEmit"], { cwd: dir, home: tempDir("dtd-home-") });
    const clusters = clustersOf(envelopeOf(run.stdout));
    expect(clusters.length).toBeGreaterThan(0);
    for (const cluster of clusters) expect(cluster).not.toHaveProperty("rerun");
  });

  it("The row appears on the first block only", async () => {
    const run = await runInCart(NO_JEV, ["node", "--test", "cart.test.js"]);
    const lines = run.stdout.split("\n");
    const rows = lines.flatMap((line, index) => (line.startsWith("  rerun: ") ? [index] : []));
    expect(rows).toHaveLength(1);
    const blockStarts = lines.flatMap((line, index) => (line.startsWith("c_") ? [index] : []));
    const [row = -1] = rows;
    expect(row).toBeGreaterThan(blockStarts[0] ?? Infinity);
    if (blockStarts[1] !== undefined) expect(row).toBeLessThan(blockStarts[1]);
    expect(lines[row]).toBe(`  rerun: ${CART_RERUN}`);
    expect(lines[row + 1]).toMatch(/^ {2}raw: L\d+-L\d+$/);
  });
});
