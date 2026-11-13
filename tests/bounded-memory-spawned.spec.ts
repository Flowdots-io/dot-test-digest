import { spawn, spawnSync } from "node:child_process";
import fs from "node:fs";
import { tmpdir } from "node:os";
import path from "node:path";
import { afterAll, beforeAll, describe, expect, it } from "vitest";
import { hermeticEnv, markRepositoryRoot } from "./helpers/hermetic-env.js";

const ROOT = path.resolve(import.meta.dirname, "..");
const CACHE = path.join(ROOT, "node_modules", ".cache");
const TAP_CART = path.join(ROOT, "tests", "fixtures", "logs", "node-tap-cart.log");
const SMALL_HEAP = "--max-old-space-size=96";
const FOUR_HUNDRED_THOUSAND =
  "for(let i=0;i<400000;i++)console.log('line '+i+' some padding text to make it longer than usual')";

let build: string;
let work: string;

beforeAll(() => {
  fs.mkdirSync(CACHE, { recursive: true });
  build = fs.mkdtempSync(path.join(CACHE, "bounded-memory-"));
  fs.writeFileSync(path.join(build, "package.json"), '{"type":"module"}');
  const tsc = spawnSync(path.join(ROOT, "node_modules", ".bin", "tsc"), ["-p", "tsconfig.json", "--outDir", build], {
    cwd: ROOT,
    encoding: "utf8",
  });
  expect(tsc.status, tsc.stdout).toBe(0);
  work = fs.mkdtempSync(path.join(tmpdir(), "dtd-bounded-memory-"));
}, 60_000);

afterAll(() => {
  fs.rmSync(build, { recursive: true, force: true });
  fs.rmSync(work, { recursive: true, force: true });
});

interface Spawned {
  code: number | null;
  stdout: string;
  stderr: string;
  ms: number;
}

/** Runs the built CLI in `cwd` with a fresh home under it; `nodeFlags` go to the node that runs the CLI. */
function runBuilt(nodeFlags: readonly string[], args: readonly string[], cwd: string): Promise<Spawned> {
  const startedAt = Date.now();
  return new Promise((done, fail) => {
    const child = spawn(process.execPath, [...nodeFlags, path.join(build, "index.js"), ...args], {
      cwd,
      stdio: "pipe",
      env: {
        ...hermeticEnv(),
        DOT_TEST_DIGEST_HOME: path.join(cwd, "home"),
        XDG_CONFIG_HOME: path.join(cwd, "config-home"),
      },
    });
    let stdout = "";
    let stderr = "";
    child.stdout.setEncoding("utf8").on("data", (chunk: string) => (stdout += chunk));
    child.stderr.setEncoding("utf8").on("data", (chunk: string) => (stderr += chunk));
    child.on("error", fail);
    child.on("close", (code) => done({ code, stdout, stderr, ms: Date.now() - startedAt }));
  });
}

function freshDir(prefix: string): string {
  const dir = fs.mkdtempSync(path.join(work, prefix));
  markRepositoryRoot(dir);
  return dir;
}

function countLines(file: string): number {
  const buffer = fs.readFileSync(file);
  let count = 0;
  for (let at = buffer.indexOf(10); at >= 0; at = buffer.indexOf(10, at + 1)) count += 1;
  return count;
}

describe("bounded memory (spawned)", () => {
  it("Four hundred thousand lines under a small heap; A large run", async () => {
    const dir = freshDir("heap-");
    const run = await runBuilt([SMALL_HEAP], ["--no-jev", "--", "node", "-e", FOUR_HUNDRED_THOUSAND], dir);
    expect(run.code, run.stderr.slice(-400)).toBe(0);
    expect(run.stdout).toMatch(/^\[PASS\] exit 0 in \d+ms \| log: \S+\.log\n$/);
    const logPath = /log: (\S+\.log)/.exec(run.stdout)?.[1] ?? "";
    expect(countLines(logPath)).toBe(400_000);

    const record = JSON.parse(fs.readFileSync(logPath.replace(/\.log$/, ".json"), "utf8")) as Record<string, unknown>;
    expect(record["raw_lines"]).toBe(400_000);
    expect(record["raw_bytes"]).toBe(fs.statSync(logPath).size);
  }, 60_000);

  it("A failure in the middle of a huge output is still found", async () => {
    const dir = freshDir("middle-");
    const fixture = fs.readFileSync(TAP_CART, "utf8").split("\n").slice(0, 120);
    expect(fixture).toHaveLength(120);
    fs.writeFileSync(path.join(dir, "fixture.log"), `${fixture.join("\n")}\n`);
    fs.writeFileSync(
      path.join(dir, "child.cjs"),
      [
        'const fs = require("node:fs");',
        "const filler = () => { let out = ''; for (let i = 0; i < 200000; i++) out += 'filler ' + i + '\\n'; return out; };",
        "process.stdout.write(filler());",
        'process.stdout.write(fs.readFileSync(__dirname + "/fixture.log", "utf8"));',
        "process.stdout.write(filler(), () => process.exit(1));",
      ].join("\n"),
    );

    const run = await runBuilt([SMALL_HEAP], ["--no-jev", "--format=json", "--", "node", "child.cjs"], dir);
    expect(run.code, run.stderr.slice(-400)).toBe(1);
    const envelope = JSON.parse(run.stdout) as { clusters: { sample_tests: string[]; raw_log_lines: string }[] };
    const cluster = envelope.clusters.find((candidate) => candidate.sample_tests.includes("discount 10% leaves 90%"));
    expect(cluster?.raw_log_lines).toBe("L200015-L200039");

    const show = await runBuilt([SMALL_HEAP], ["show", "last", "L200015-L200016"], dir);
    expect(show.code, show.stderr).toBe(0);
    expect(show.stdout).toBe(`${fixture[14]}\n${fixture[15]}\n`);
  }, 60_000);

  it("The time cost stays bounded", async () => {
    const dir = freshDir("time-");
    const run = await runBuilt([], ["--no-jev", "--", "node", "-e", FOUR_HUNDRED_THOUSAND], dir);
    expect(run.code, run.stderr.slice(-400)).toBe(0);
    expect(run.ms).toBeLessThan(15_000);
  }, 60_000);
});
