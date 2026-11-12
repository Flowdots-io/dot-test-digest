import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runInCart, runMain, runNodeCart, tempDir, type CartRun } from "./helpers/node-cart.js";
import { syntheticHome, workDirs, type SyntheticRun } from "./helpers/run-home.js";

const NO_JEV = ["--no-jev"];

/** The home of the reference scenarios: two runs in a, one in b. */
function referenceHome(dirs: { a: string; b: string }, extra: SyntheticRun[] = []): string {
  return syntheticHome([
    { id: "run_aaaaaa1", cwd: dirs.a, createdAt: "2026-11-01T10:00:00Z" },
    { id: "run_bbbbbb2", cwd: dirs.b, createdAt: "2026-11-01T11:00:00Z" },
    { id: "run_cccccc3", cwd: dirs.a, createdAt: "2026-11-01T09:00:00Z" },
    ...extra,
  ]);
}

describe("run references (run-record)", () => {
  const dirs = workDirs("a", "b", "c");

  it("last is the newest run of this directory", async () => {
    const run = await runMain(["show", "last"], { cwd: dirs.a, home: referenceHome(dirs) });
    expect(run.stdout).toBe("log of run_aaaaaa1\n");
    expect(run.code).toBe(0);
  });

  it("A unique prefix resolves", async () => {
    const run = await runMain(["show", "run_aaaaaa"], { cwd: dirs.a, home: referenceHome(dirs) });
    expect(run.stdout).toBe("log of run_aaaaaa1\n");
    expect(run.code).toBe(0);
  });

  it("An ambiguous prefix is a usage error", async () => {
    const home = referenceHome(dirs, [{ id: "run_aaaaaa9", cwd: dirs.a, createdAt: "2026-11-01T08:00:00Z" }]);
    const run = await runMain(["show", "run_aaaaaa"], { cwd: dirs.a, home });
    expect(run.code).toBe(64);
    expect(run.stderr).toBe('ambiguous run reference "run_aaaaaa": run_aaaaaa1, run_aaaaaa9\n');
    expect(run.stdout).toBe("");
  });

  it("Unknown references exit 66", async () => {
    const home = referenceHome(dirs);
    const last = await runMain(["show", "last"], { cwd: dirs.c, home });
    expect(last.code).toBe(66);
    expect(last.stderr).toBe("no run recorded for this directory\n");
    const missing = await runMain(["show", "run_zzzzzz"], { cwd: dirs.c, home });
    expect(missing.code).toBe(66);
    expect(missing.stderr).toBe("no such run: run_zzzzzz\n");
  });

  it("A short prefix is a usage error", async () => {
    const run = await runMain(["show", "run_a"], { cwd: dirs.a, home: referenceHome(dirs) });
    expect(run.code).toBe(64);
    expect(run.stderr).toBe('run reference "run_a" is too short (6 characters minimum)\n');
  });
});

describe("subcommand dispatch (run-record)", () => {
  it("show dispatches", async () => {
    const first = await runInCart(NO_JEV, ["sh", "-c", "echo hi"]);
    const run = await runMain(["show", "last"], { cwd: first.dir, home: first.home });
    expect(run.code).toBe(0);
    expect(run.stdout.split("\n")).toContain("hi");
  });

  it("Other bare words keep the old error", async () => {
    const where = { cwd: process.cwd(), home: tempDir("dtd-words-") };
    const bogus = await runMain(["bogus", "--", "true"], where);
    expect(bogus.code).toBe(64);
    expect(bogus.stderr).toBe('missing -- delimiter before "bogus": dot-test-digest [flags] -- <command>\n');
    const late = await runMain(["--no-jev", "show", "last"], where);
    expect(late.code).toBe(64);
    expect(late.stderr).toBe('missing -- delimiter before "show": dot-test-digest [flags] -- <command>\n');
  });

  it("A program called show is still a program", async () => {
    const run = await runMain(["--", "show"], { cwd: tempDir("dtd-prog-"), home: tempDir("dtd-prog-home-") });
    expect(run.code).toBe(127);
    expect(run.stderr).toBe("dot-test-digest: spawn show ENOENT\n");
  });

  it("The help lists the subcommands", async () => {
    const run = await runMain(["--help"], { cwd: process.cwd(), home: tempDir("dtd-help-") });
    const lines = run.stdout.split("\n");
    for (const line of [
      "  show <run> [range|cluster_id]",
      "  replay <run>",
      "  digest <file|->",
      "  gc",
      "  stats",
      "  doctor",
      "  init",
      "  mcp",
      "  config",
      "  schema",
    ]) {
      expect(lines).toContain(line);
    }
    expect(run.code).toBe(0);
  });
});

function logLines(cart: CartRun, from: number, to: number): string {
  const [record] = fs.readdirSync(path.join(cart.home, "logs")).filter((name) => name.endsWith(".log"));
  const lines = fs.readFileSync(path.join(cart.home, "logs", record ?? ""), "utf8").split("\n");
  return lines.slice(from - 1, to).map((line) => `${line}\n`).join("");
}

function recordFile(cart: CartRun): string {
  const [name] = fs.readdirSync(path.join(cart.home, "logs")).filter((file) => file.endsWith(".json"));
  return path.join(cart.home, "logs", name ?? "");
}

describe("show (run-record)", () => {
  let cart: CartRun | undefined;
  async function cartRun(): Promise<CartRun> {
    cart ??= await runNodeCart(NO_JEV, ["cart.test.js"]);
    return cart;
  }
  async function show(...args: string[]) {
    const run = await cartRun();
    return runMain(["show", ...args], { cwd: run.dir, home: run.home });
  }

  it("A range of the cart log", async () => {
    const out = await show("last", "L15-L17");
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(logLines(await cartRun(), 15, 17));
    expect(out.stdout.split("\n")).toHaveLength(4);
    expect(out.stdout.split("\n")[0]).toBe("not ok 3 - discount 10% leaves 90%");
  });

  it("A cluster id selects its range", async () => {
    const run = await cartRun();
    expect(run.stdout).toContain("raw: L15-L39");
    const out = await show("last", "c_9721831d");
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(logLines(run, 15, 39));
  });

  it("Numbers are prefixed", async () => {
    const out = await show("last", "L15-L16", "--numbers");
    expect(out.stdout).toBe("15\tnot ok 3 - discount 10% leaves 90%\n16\t  ---\n");
  });

  it("An unknown cluster id is rejected", async () => {
    const run = await cartRun();
    const runId = path.basename(recordFile(run), ".json");
    const out = await show("last", "c_00000000");
    expect(out.code).toBe(64);
    expect(out.stderr).toBe(`no cluster c_00000000 in ${runId}\n`);
  });

  it("The record can be printed", async () => {
    const out = await show("last", "--record");
    expect(out.code).toBe(0);
    expect(out.stdout).toBe(fs.readFileSync(recordFile(await cartRun()), "utf8"));
  });
});

describe("show on synthetic runs (run-record)", () => {
  const dirs = workDirs("p");

  it("A range is clamped, a bad range is rejected", async () => {
    const lines = Array.from({ length: 120 }, (_, index) => `line ${index + 1}`);
    const home = syntheticHome([{ id: "run_long120", cwd: dirs.p, createdAt: "2026-11-01T10:00:00Z", log: lines }]);

    const clamped = await runMain(["show", "last", "L110-L500"], { cwd: dirs.p, home });
    expect(clamped.code).toBe(0);
    expect(clamped.stdout).toBe(lines.slice(109).map((line) => `${line}\n`).join(""));

    const beyond = await runMain(["show", "last", "L500-L600"], { cwd: dirs.p, home });
    expect(beyond.code).toBe(64);
    expect(beyond.stderr).toBe("the log has 120 lines\n");

    const reversed = await runMain(["show", "last", "L9-L3"], { cwd: dirs.p, home });
    expect(reversed.code).toBe(64);
    expect(reversed.stderr).toBe("invalid range: L9-L3\n");
  });

  it("A pruned run says so", async () => {
    const home = syntheticHome([{ id: "run_pruned1", cwd: dirs.p, createdAt: "2026-11-01T10:00:00Z", log: null }]);
    const out = await runMain(["show", "run_pruned1"], { cwd: dirs.p, home });
    expect(out.code).toBe(66);
    expect(out.stderr).toBe("log of run_pruned1 was removed\n");
  });
});
