import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { runMain, runNodeCart, tempDir } from "./helpers/node-cart.js";

const NO_JEV = ["--no-jev"];
const PROJECT_FILE = ".dot-test-digest.json";

function header(stdout: string): string {
  return stdout.split("\n")[0] ?? "";
}

/** A config home with an optional user file; `env` is the whole environment the run sees. */
function userConfig(contents?: string): { env: NodeJS.ProcessEnv; file: string } {
  const configHome = fs.realpathSync(tempDir("dtd-xdg-"));
  const file = path.join(configHome, "dot-test-digest", "config.json");
  if (contents !== undefined) {
    fs.mkdirSync(path.dirname(file), { recursive: true });
    fs.writeFileSync(file, contents);
  }
  return { env: { XDG_CONFIG_HOME: configHome, HOME: os.homedir() }, file };
}

/** A working directory (its own `.git`, so the walk stops there) holding `files`. */
function project(files: Readonly<Record<string, string>> = {}): string {
  const dir = fs.realpathSync(tempDir("dtd-project-"));
  fs.mkdirSync(path.join(dir, ".git"));
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents);
  return dir;
}

async function config(cwd: string, env: NodeJS.ProcessEnv) {
  return runMain(["config"], { cwd, home: tempDir("dtd-config-home-"), deps: { env } });
}

describe("configuration layers (config-file)", () => {
  it("A project file sets a default", async () => {
    const { env } = userConfig();
    const run = await runNodeCart(NO_JEV, ["cart.test.js"], {
      files: { [PROJECT_FILE]: '{ "maxClusters": 1 }' },
      deps: { env },
    });
    expect(header(run.stdout)).toMatch(/\| 1 cluster \|/);
    expect(run.stdout).toContain("+3 more clusters (see log)");
    expect(run.code).toBe(1);
  });

  it("A flag beats the environment, the environment beats the file", async () => {
    const { env } = userConfig();
    const files = { [PROJECT_FILE]: '{ "maxClusters": 1 }' };
    const deps = { env: { ...env, DOT_TEST_DIGEST_MAX_CLUSTERS: "2" } };
    const totalClusters = (stdout: string): number =>
      (JSON.parse(stdout) as { summary: { total_clusters: number } }).summary.total_clusters;
    const fromEnv = await runNodeCart([...NO_JEV, "--format=json"], ["cart.test.js"], { files, deps });
    expect(totalClusters(fromEnv.stdout)).toBe(2);
    const fromFlag = await runNodeCart([...NO_JEV, "--format=json", "--max-clusters=3"], ["cart.test.js"], { files, deps });
    expect(totalClusters(fromFlag.stdout)).toBe(3);
  });

  it("The user file is the lowest layer", async () => {
    const user = userConfig('{ "maxClusters": 4, "contextLines": 0 }');
    const dir = project({ [PROJECT_FILE]: '{ "maxClusters": 1 }' });
    const run = await config(dir, user.env);
    const lines = run.stdout.split("\n");
    expect(lines).toContain(`maxClusters = 1 (project ${path.join(dir, PROJECT_FILE)})`);
    expect(lines).toContain(`contextLines = 0 (user ${user.file})`);
    expect(run.code).toBe(0);
  });

  it("The nearest project file wins and the walk stops at .git", async () => {
    const w = fs.realpathSync(tempDir("dtd-walk-"));
    fs.writeFileSync(path.join(w, PROJECT_FILE), '{ "maxClusters": 9 }');
    fs.mkdirSync(path.join(w, "pkg", ".git"), { recursive: true });
    fs.mkdirSync(path.join(w, "pkg", "sub"));
    const run = await config(path.join(w, "pkg", "sub"), userConfig().env);
    expect(run.stdout.split("\n")).toContain("maxClusters = 5 (default)");
    expect(run.code).toBe(0);
  });

  it("the walk stops at a symlinked home, compared by real path", async () => {
    const root = fs.realpathSync(tempDir("dtd-symhome-"));
    fs.writeFileSync(path.join(root, PROJECT_FILE), '{ "maxClusters": 9 }');
    fs.mkdirSync(path.join(root, "real-home", "work"), { recursive: true });
    fs.symlinkSync(path.join(root, "real-home"), path.join(root, "home-link"));
    const env = { ...userConfig().env, HOME: path.join(root, "home-link") };
    const run = await config(path.join(root, "real-home", "work"), env);
    expect(run.stdout.split("\n")).toContain("maxClusters = 5 (default)");
  });

  it("outside home, a directory without .git above it uses no project file", async () => {
    const shared = fs.realpathSync(tempDir("dtd-shared-"));
    fs.writeFileSync(path.join(shared, PROJECT_FILE), '{ "maxClusters": 9 }');
    fs.mkdirSync(path.join(shared, "scratch"));
    const env = { ...userConfig().env, HOME: fs.realpathSync(tempDir("dtd-elsewhere-home-")) };
    const run = await config(path.join(shared, "scratch"), env);
    expect(run.stdout.split("\n")).toContain("maxClusters = 5 (default)");
    const bounded = project({ [PROJECT_FILE]: '{ "maxClusters": 9 }' });
    fs.mkdirSync(path.join(bounded, "sub"));
    const inRepo = await config(path.join(bounded, "sub"), env);
    expect(inRepo.stdout.split("\n")).toContain(`maxClusters = 9 (project ${path.join(bounded, PROJECT_FILE)})`);
  });

  it("An unknown key is a usage error naming file and key", async () => {
    const dir = project({ [PROJECT_FILE]: '{ "maxCluster": 3 }' });
    const run = await runMain(["--", "true"], { cwd: dir, home: tempDir("dtd-cfg-"), deps: { env: userConfig().env } });
    expect(run.code).toBe(64);
    expect(run.stderr).toBe(`${path.join(dir, PROJECT_FILE)}: unknown key "maxCluster"\n`);
    expect(run.stdout).toBe("");
  });

  it("A bad config value is a usage error", async () => {
    const { env } = userConfig();
    const bad = project({ [PROJECT_FILE]: '{ "maxClusters": 99 }' });
    const fromFile = await runMain(["--", "true"], { cwd: bad, home: tempDir("dtd-cfg-"), deps: { env } });
    expect(fromFile.code).toBe(64);
    expect(fromFile.stderr).toBe(`${path.join(bad, PROJECT_FILE)}: maxClusters must be between 1 and 15, got 99\n`);

    const fromEnv = await runMain(["--", "true"], {
      cwd: project(),
      home: tempDir("dtd-cfg-"),
      deps: { env: { ...env, DOT_TEST_DIGEST_MAX_CLUSTERS: "abc" } },
    });
    expect(fromEnv.code).toBe(64);
    expect(fromEnv.stderr).toBe("DOT_TEST_DIGEST_MAX_CLUSTERS must be an integer between 1 and 15, got abc\n");
  });

  it("Malformed JSON is a usage error", async () => {
    const dir = project({ [PROJECT_FILE]: '{ "maxClusters": ' });
    const run = await runMain(["--", "true"], { cwd: dir, home: tempDir("dtd-cfg-"), deps: { env: userConfig().env } });
    expect(run.code).toBe(64);
    expect(run.stderr.startsWith(`${path.join(dir, PROJECT_FILE)}: invalid JSON:`)).toBe(true);
  });
});

describe("the config subcommand (config-file)", () => {
  it("Defaults are printed with their source", async () => {
    const run = await config(project(), userConfig().env);
    expect(run.stdout).toBe(
      [
        "maxClusters = 5 (default)",
        "contextLines = 2 (default)",
        "format = compact-md (default)",
        "noJev = false (default)",
        "retryFlakes = false (default)",
        "color = auto (default)",
        "progress = false (default)",
        "retention.auto = true (default)",
        "retention.keepRuns = 50 (default)",
        "retention.maxAgeDays = 14 (default)",
        "retention.stateMaxAgeDays = 90 (default)",
        "",
      ].join("\n"),
    );
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  });

  it("Environment is reported by name", async () => {
    const { env } = userConfig();
    const run = await config(project(), { ...env, DOT_TEST_DIGEST_FORMAT: "json", DOT_TEST_DIGEST_PRUNE: "0" });
    const lines = run.stdout.split("\n");
    expect(lines).toContain("format = json (env DOT_TEST_DIGEST_FORMAT)");
    expect(lines).toContain("retention.auto = false (env DOT_TEST_DIGEST_PRUNE)");
    expect(run.code).toBe(0);
  });
});

describe("the MCP allowlist (config-file)", () => {
  it("The project allowlist is ignored with a warning", async () => {
    const user = userConfig('{ "mcp": { "allow": [["pnpm", "test"]] } }');
    const dir = project({ [PROJECT_FILE]: '{ "mcp": { "allow": [["rm"]] } }' });
    const run = await config(dir, user.env);
    expect(run.stdout.split("\n")).toContain(`mcp.allow = [["pnpm","test"]] (user ${user.file})`);
    expect(run.code).toBe(0);
    expect(run.stderr).toBe(
      `dot-test-digest: ignoring "mcp" in ${path.join(dir, PROJECT_FILE)}: the command allowlist is read from the user config only\n`,
    );
  });
});
