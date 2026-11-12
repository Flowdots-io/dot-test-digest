import { spawn } from "node:child_process";
import fs from "node:fs";
import path from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { MainDeps } from "../src/index.js";
import type { DigestEnvelope } from "../src/types/schema.js";
import { runMain, runNodeCart, tempDir, type CartRun } from "./helpers/node-cart.js";
import { syntheticHome, workDirs } from "./helpers/run-home.js";

// Every spawn still runs; the spy only counts them.
vi.mock("node:child_process", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:child_process")>();
  return { ...actual, spawn: vi.fn(actual.spawn) };
});

const NO_JEV = ["--no-jev"];

const failIfCalled: MainDeps = {
  client: {
    isConfigured: () => {
      throw new Error("replay called the Jev client");
    },
    ask: () => {
      throw new Error("replay called the Jev client");
    },
  },
};

function replay(args: readonly string[], run: Pick<CartRun, "dir" | "home">) {
  return runMain(["replay", ...args], { cwd: run.dir, home: run.home, deps: failIfCalled });
}

/** Every file under `dir` with its mtime, so a write, a new file or a removal shows. */
function snapshot(dir: string): Record<string, number> {
  const files: Record<string, number> = {};
  for (const entry of fs.readdirSync(dir, { recursive: true, withFileTypes: true })) {
    const file = path.join(entry.parentPath, entry.name);
    files[file] = fs.statSync(file).mtimeMs;
  }
  return files;
}

/** The lines of the first full block, from its `c_` head to the next one. */
function firstBlock(stdout: string): string[] {
  const lines = stdout.split("\n");
  const start = lines.findIndex((line) => line.startsWith("c_"));
  const next = lines.findIndex((line, index) => index > start && !line.startsWith(" "));
  return lines.slice(start, next === -1 ? undefined : next);
}

describe("replay (run-replay)", () => {
  it("Replaying with the stored options reproduces the digest", async () => {
    const original = await runNodeCart(NO_JEV, ["cart.test.js"]);
    expect(original.code).toBe(1);
    const again = await replay(["last"], original);
    expect(again.stdout).toBe(original.stdout);
    expect(again.code).toBe(1);
  });

  it("Replay can show every cluster as JSON", async () => {
    const original = await runNodeCart(NO_JEV, ["cart.test.js"]);
    const again = await replay(["last", "--format=json", "--max-clusters=15"], original);
    expect(again.code).toBe(1);
    const envelope = JSON.parse(again.stdout) as DigestEnvelope;
    expect(envelope.summary.total_clusters).toBe(4);
    expect((envelope.clusters ?? []).map((cluster) => cluster.cluster_id).sort()).toEqual(
      ["c_9721831d", "c_6edce10a", "c_fdff652c", "c_53a8182a"].sort(),
    );
  });

  it("Replay changes the source window", async () => {
    const original = await runNodeCart(NO_JEV, ["cart.test.js"]);
    const again = await replay(["last", "--context-lines=0"], original);
    const window = firstBlock(again.stdout).filter((line) => /^ {2}\d+ [>|] /.test(line));
    expect(window).toHaveLength(1);
    expect(window[0]?.startsWith('  7 > test("discount 10% leaves 90%", ')).toBe(true);
  });

  it("Replay writes and starts nothing", async () => {
    const original = await runNodeCart(NO_JEV, ["cart.test.js"]);
    const before = snapshot(original.home);
    const spawned = vi.mocked(spawn).mock.calls.length;
    for (let round = 0; round < 3; round += 1) {
      const again = await replay(["last"], original);
      expect(again.code).toBe(1);
    }
    expect(snapshot(original.home)).toEqual(before);
    expect(vi.mocked(spawn).mock.calls.length).toBe(spawned);
  });

  it("Replay of a red run keeps its verdict and exit code", async () => {
    const original = await runNodeCart([...NO_JEV, "--tdd-phase=red", "--scope-id=p1"], ["passing.test.js"]);
    expect(original.code).toBe(64);
    const again = await replay(["last"], original);
    expect(again.code).toBe(64);
    expect(again.stdout.startsWith("[INVALID_RED | RED]")).toBe(true);
    expect(again.stderr).toBe("New test passed before implementation; expected a failing behavioral assertion.\n");
  });

  it("Replay of a green run prints no delta", async () => {
    const failing = 'import { test } from "node:test";\nimport assert from "node:assert/strict";\ntest("one", () => assert.equal(1, 2));\n';
    const red = await runNodeCart([...NO_JEV, "--tdd-phase=red", "--scope-id=g1"], ["one.test.js"], {
      files: { "one.test.js": failing },
    });
    expect(red.code).toBe(0);
    fs.writeFileSync(path.join(red.dir, "one.test.js"), failing.replace("equal(1, 2)", "equal(1, 1)"));
    const green = await runMain([...NO_JEV, "--tdd-phase=green", "--scope-id=g1", "--", process.execPath, "--test", "one.test.js"], {
      cwd: red.dir,
      home: red.home,
    });
    expect(green.stdout).toContain("(delta: +1 newly passing, 0 regressions)");
    const again = await replay(["last"], red);
    expect(again.stdout).toMatch(/^\[PASS \| GREEN\] 1 passed, 0 failed in \d+ms \| log: \S+run_[0-9a-z]{9,}\.log\n$/);
    expect(again.code).toBe(0);
  });

  it("A run without a record cannot be replayed", async () => {
    const dirs = workDirs("legacy");
    const home = syntheticHome([{ id: "run_legacy1", cwd: dirs.legacy, createdAt: "2026-11-01T10:00:00Z", record: null }]);
    const again = await replay(["run_legacy1"], { dir: dirs.legacy, home });
    expect(again.code).toBe(66);
    expect(again.stderr).toBe("run_legacy1 has no record (written by an older version); replay needs one\n");
    expect(again.stdout).toBe("");
  });

  it("A removed log cannot be replayed", async () => {
    const dirs = workDirs("gone");
    const home = syntheticHome([{ id: "run_gonelog1", cwd: dirs.gone, createdAt: "2026-11-01T10:00:00Z", log: null }]);
    const again = await replay(["run_gonelog1"], { dir: dirs.gone, home });
    expect(again.code).toBe(66);
    expect(again.stderr).toBe("log of run_gonelog1 was removed\n");
    expect(again.stdout).toBe("");
  });

  it("A replay needs a run", async () => {
    const again = await replay([], { dir: process.cwd(), home: tempDir("dtd-replay-") });
    expect(again.code).toBe(64);
  });
});
