import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMain, runNodeCart, tempDir } from "./helpers/node-cart.js";
import { syntheticHome } from "./helpers/run-home.js";

const MINUTE = 60_000;
const HOUR = 60 * MINUTE;
const DAY = 24 * HOUR;
const NO_JEV = ["--no-jev"];
const PROJECT_FILE = ".dot-test-digest.json";

interface PairsOptions {
  prefix?: string;
  /** How long ago the files were last modified; the age of `created_at` by default. */
  mtimeAgeMs?: number;
  home?: string;
}

/**
 * `count` run pairs `<prefix>001`.. created `ageMs` ago, one minute apart so the higher number is the newer run.
 * Returns the home.
 */
function oldPairs(count: number, ageMs: number, options: PairsOptions = {}): string {
  const { prefix = "run_old", mtimeAgeMs = ageMs } = options;
  const now = Date.now();
  const runs = Array.from({ length: count }, (_, index) => ({
    id: `${prefix}${String(index + 1).padStart(3, "0")}`,
    cwd: "/elsewhere",
    createdAt: new Date(now - ageMs + index * MINUTE).toISOString(),
    mtime: new Date(now - mtimeAgeMs + index * MINUTE),
  }));
  const home = syntheticHome(runs, options.home);
  for (const run of runs) {
    for (const ext of [".log", ".json"]) fs.utimesSync(path.join(home, "logs", `${run.id}${ext}`), run.mtime, run.mtime);
  }
  return home;
}

/** Run ids that still have a log, sorted; every one of them also has its record unless `legacy` lists it. */
function runsIn(home: string, legacy: readonly string[] = []): string[] {
  const names = fs.existsSync(path.join(home, "logs")) ? fs.readdirSync(path.join(home, "logs")) : [];
  const ids = names.filter((name) => name.endsWith(".log")).map((name) => name.slice(0, -".log".length));
  for (const id of ids) if (!legacy.includes(id)) expect(names).toContain(`${id}.json`);
  return ids.sort();
}

function numbered(prefix: string, from: number, to: number): string[] {
  return Array.from({ length: to - from + 1 }, (_, index) => `${prefix}${String(from + index).padStart(3, "0")}`);
}

function setMtime(file: string, ageMs: number): void {
  const when = new Date(Date.now() - ageMs);
  fs.utimesSync(file, when, when);
}

async function gc(home: string, ...args: string[]) {
  return runMain(["gc", ...args], { cwd: tempDir("dtd-gc-cwd-"), home });
}

describe("automatic prune after a run (cache-retention)", () => {
  it("Old runs beyond the newest 50 are removed", async () => {
    const home = oldPairs(60, 20 * DAY);
    const run = await runNodeCart(NO_JEV, ["passing.test.js"], { home });
    const left = runsIn(home);
    expect(left).toHaveLength(50);
    expect(left.filter((id) => id.startsWith("run_old"))).toEqual(numbered("run_old", 12, 60));
    expect(run.code).toBe(0);
    expect(run.stderr).toBe("");
  });

  it("Recent runs are kept even beyond 50", async () => {
    const home = oldPairs(60, DAY);
    await runNodeCart(NO_JEV, ["passing.test.js"], { home });
    expect(runsIn(home)).toHaveLength(61);
  });

  it("Fewer than 50 runs are never pruned", async () => {
    const home = oldPairs(30, 100 * DAY);
    await runNodeCart(NO_JEV, ["passing.test.js"], { home });
    expect(runsIn(home)).toHaveLength(31);
  });

  it("A log without a record is pruned by its mtime", async () => {
    const home = oldPairs(55, DAY, { prefix: "run_new" });
    const legacy = ["run_legacy1", "run_legacy2", "run_legacy3"];
    for (const id of legacy) {
      const file = path.join(home, "logs", `${id}.log`);
      fs.writeFileSync(file, "a line from 0.1.x\n");
      setMtime(file, 30 * DAY);
    }
    await runNodeCart(NO_JEV, ["passing.test.js"], { home });
    const left = runsIn(home, legacy);
    for (const id of legacy) expect(left).not.toContain(id);
    expect(left.filter((id) => id.startsWith("run_new"))).toEqual(numbered("run_new", 1, 55));
  });

  it("Files modified in the last hour are never deleted", async () => {
    const home = oldPairs(60, 20 * DAY);
    for (const name of fs.readdirSync(path.join(home, "logs"))) setMtime(path.join(home, "logs", name), 10 * MINUTE);
    await runNodeCart(NO_JEV, ["passing.test.js"], { home });
    expect(runsIn(home).filter((id) => id.startsWith("run_old"))).toEqual(numbered("run_old", 1, 60));
  });

  it("Old state files go, the current one stays", async () => {
    const home = tempDir("dtd-state-home-");
    const state = (name: string) => path.join(home, `state-${name}.json`);
    for (const [name, age] of [["aaa", 100 * DAY], ["bbb", 10 * DAY], ["cur", 100 * DAY]] as const) {
      fs.writeFileSync(state(name), "{}\n");
      setMtime(state(name), age);
    }
    const before = Date.now();
    await runNodeCart(["--no-jev", "--tdd-phase=red", "--scope-id=cur"], ["cart.test.js"], { home });
    expect(fs.existsSync(state("aaa"))).toBe(false);
    expect(fs.existsSync(state("bbb"))).toBe(true);
    expect(JSON.parse(fs.readFileSync(state("cur"), "utf8"))).toMatchObject({ scope_id: "cur", phase: "red" });
    expect(fs.statSync(state("cur")).mtimeMs).toBeGreaterThanOrEqual(before - 1000);
  });

  it("The automatic prune can be switched off", async () => {
    const home = oldPairs(60, 20 * DAY);
    await runNodeCart(NO_JEV, ["passing.test.js"], { home, deps: { env: { DOT_TEST_DIGEST_PRUNE: "0" } } });
    expect(runsIn(home)).toHaveLength(61);
  });

  it("A prune failure keeps the exit code", async () => {
    const run = await runNodeCart(NO_JEV, ["cart.test.js"], {
      deps: {
        prune: () => {
          throw new Error("locked");
        },
      },
    });
    expect(run.code).toBe(1);
    expect(run.stderr).toBe("dot-test-digest: could not prune the cache: locked\n");
  });

  it("deletes at most 200 files per run, oldest first", async () => {
    const home = oldPairs(260, 20 * DAY);
    await runNodeCart(NO_JEV, ["passing.test.js"], { home });
    const left = runsIn(home).filter((id) => id.startsWith("run_old"));
    expect(left).toEqual(numbered("run_old", 101, 260));
  });
});

describe("retention settings (config-file)", () => {
  it("The retention settings reach the prune", async () => {
    const home = oldPairs(5, 2 * HOUR);
    const run = await runNodeCart(NO_JEV, ["passing.test.js"], {
      home,
      files: { [PROJECT_FILE]: '{ "retention": { "keepRuns": 2, "maxAgeDays": 0 } }' },
    });
    const left = runsIn(home);
    expect(left).toHaveLength(2);
    expect(left).toContain("run_old005");
    expect(run.code).toBe(0);
  });

  it("The prune switch has its legacy spelling", async () => {
    const home = oldPairs(60, 20 * DAY);
    await runNodeCart(NO_JEV, ["passing.test.js"], {
      home,
      files: { [PROJECT_FILE]: '{ "retention": { "auto": false } }' },
    });
    expect(runsIn(home)).toHaveLength(61);
  });
});

describe("gc (cache-retention)", () => {
  it("gc with defaults on the 60-old-runs home", async () => {
    const home = oldPairs(60, 20 * DAY);
    const run = await gc(home);
    expect(run.stdout).toBe("removed 10 runs (0 state files), kept 50 runs\n");
    expect(run.code).toBe(0);
    expect(runsIn(home)).toEqual(numbered("run_old", 11, 60));
  });

  it("gc with stricter numbers", async () => {
    const home = oldPairs(60, 5 * DAY);
    const run = await gc(home, "--keep", "10", "--max-age-days", "2");
    expect(run.stdout).toBe("removed 50 runs (0 state files), kept 10 runs\n");
    expect(run.code).toBe(0);
    expect(runsIn(home)).toEqual(numbered("run_old", 51, 60));
  });

  it("dry-run deletes nothing", async () => {
    const home = oldPairs(60, 20 * DAY);
    const run = await gc(home, "--dry-run");
    expect(run.stdout).toBe("would remove 10 runs (0 state files), keeping 50 runs\n");
    expect(run.code).toBe(0);
    expect(runsIn(home)).toHaveLength(60);
  });

  it("Bad values are usage errors", async () => {
    const home = oldPairs(60, 20 * DAY);
    const negative = await gc(home, "--keep", "-1");
    expect(negative.code).toBe(64);
    expect(negative.stderr).toBe("--keep must be a non-negative integer, got -1\n");
    const word = await gc(home, "--max-age-days", "abc");
    expect(word.code).toBe(64);
    expect(word.stderr).toBe("--max-age-days must be a non-negative integer, got abc\n");
    expect(runsIn(home)).toHaveLength(60);
  });

  it("gc on a missing cache", async () => {
    const home = path.join(tempDir("dtd-gc-missing-"), "cache");
    const run = await gc(home);
    expect(run.stdout).toBe("removed 0 runs (0 state files), kept 0 runs\n");
    expect(run.code).toBe(0);
    expect(fs.existsSync(home)).toBe(false);
  });

  it("deletes only run and state files of the cache, never through a symlink", async () => {
    const home = oldPairs(60, 20 * DAY);
    const outside = tempDir("dtd-outside-");
    const victim = path.join(outside, "run_victim.log");
    const victimState = path.join(outside, "state-victim.json");
    fs.writeFileSync(victim, "not the cache's\n");
    fs.writeFileSync(victimState, "{}\n");
    const foreign = [path.join(home, "logs", "notes.txt"), path.join(home, "logs", "run_x.json.1.ab.tmp"), path.join(home, "keep.json")];
    for (const file of foreign) fs.writeFileSync(file, "mine\n");
    fs.symlinkSync(victim, path.join(home, "logs", "run_victim.log"));
    fs.symlinkSync(victimState, path.join(home, "state-victim.json"));
    for (const file of [victim, victimState, ...foreign]) setMtime(file, 200 * DAY);

    const run = await gc(home, "--keep", "0", "--max-age-days", "0", "--state-max-age-days", "0");
    expect(run.code).toBe(0);
    for (const file of [victim, victimState, ...foreign]) expect(fs.existsSync(file)).toBe(true);
    expect(fs.lstatSync(path.join(home, "logs", "run_victim.log")).isSymbolicLink()).toBe(true);
    expect(fs.lstatSync(path.join(home, "state-victim.json")).isSymbolicLink()).toBe(true);
    expect(runsIn(home, ["run_victim"])).toEqual(["run_victim"]);
  });

  it("removes a record whose log is gone and counts state files", async () => {
    const home = oldPairs(3, 20 * DAY);
    fs.rmSync(path.join(home, "logs", "run_old001.log"));
    const stale = path.join(home, "state-stale.json");
    fs.writeFileSync(stale, "{}\n");
    setMtime(stale, 100 * DAY);
    const run = await gc(home);
    expect(run.stdout).toBe("removed 1 runs (1 state files), kept 2 runs\n");
    expect(fs.existsSync(path.join(home, "logs", "run_old001.json"))).toBe(false);
    expect(fs.existsSync(stale)).toBe(false);
  });
});
