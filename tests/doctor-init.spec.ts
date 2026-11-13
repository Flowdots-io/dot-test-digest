import fs from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { hermeticEnv, markRepositoryRoot } from "./helpers/hermetic-env.js";
import { runMain, tempDir } from "./helpers/node-cart.js";

const REPO = process.cwd();
const PROJECT_FILE = ".dot-test-digest.json";
const PACKAGE_VERSION = (JSON.parse(fs.readFileSync(path.join(REPO, "package.json"), "utf8")) as { version: string })
  .version;

/** The test's environment without any Jev key the machine running it may have. */
function envWithoutKey(extra: NodeJS.ProcessEnv = {}): NodeJS.ProcessEnv {
  const env = hermeticEnv();
  delete env["TYPESAFE_API_KEY"];
  delete env["JEV_API_KEY"];
  return { ...env, ...extra };
}

/** A working directory that is its own repository, holding `files`. */
function project(files: Readonly<Record<string, string>> = {}): string {
  const dir = fs.realpathSync(tempDir("dtd-doctor-project-"));
  markRepositoryRoot(dir);
  for (const [name, contents] of Object.entries(files)) fs.writeFileSync(path.join(dir, name), contents);
  return dir;
}

function vitestCart(): string {
  const dir = fs.realpathSync(tempDir("dtd-doctor-vitest-cart-"));
  fs.cpSync(path.join(REPO, "tests", "fixtures", "vitest-cart"), dir, { recursive: true });
  markRepositoryRoot(dir);
  return dir;
}

/** Every path under `dir` with its contents (a directory as `<dir>`), or `null` when `dir` does not exist. */
function snapshot(dir: string): Record<string, string> | null {
  if (!fs.existsSync(dir)) return null;
  const entries: Record<string, string> = {};
  for (const relative of fs.readdirSync(dir, { recursive: true }) as string[]) {
    const full = path.join(dir, relative);
    entries[relative] = fs.statSync(full).isDirectory() ? "<dir>" : fs.readFileSync(full, "utf8");
  }
  return entries;
}

interface DoctorJson {
  ok: boolean;
  checks: { name: string; status: string; detail: string }[];
  runners: { name: string; status: string; source: string; command: string; note?: string }[];
}

describe("doctor (doctor-and-init)", () => {
  it("doctor on a vitest project", async () => {
    const dir = vitestCart();
    const home = fs.realpathSync(tempDir("dtd-doctor-home-"));
    const run = await runMain(["doctor"], { cwd: dir, home, deps: { env: envWithoutKey() } });
    expect(process.version).toMatch(/^v\d+\.\d+\.\d+$/);
    expect(run.stdout).toBe(
      [
        `ok    node: ${process.version} (>= 20)`,
        `ok    version: ${PACKAGE_VERSION}`,
        `ok    cache: ${home} (writable, 0 runs, 0 KiB)`,
        "ok    config: none found",
        "warn  gear1: TYPESAFE_API_KEY not set (Jev disabled; heuristic fallback)",
        "ok    runner: vitest (package.json) -> dot-test-digest -- npx vitest run",
        "",
      ].join("\n"),
    );
    expect(run.code).toBe(0);
  });

  it("doctor on a project with several runners", async () => {
    const dir = project({
      "package.json": JSON.stringify({
        devDependencies: { jest: "29", mocha: "10" },
        scripts: { test: "node --test" },
      }),
      "Cargo.toml": '[package]\nname = "x"\n',
      "tsconfig.json": "{}",
    });
    const run = await runMain(["doctor", "--json"], {
      cwd: dir,
      home: tempDir("dtd-doctor-home-"),
      deps: { env: envWithoutKey() },
    });
    expect(run.stdout).toMatch(/^\{.*\}\n$/);
    const report = JSON.parse(run.stdout) as DoctorJson;
    const byName = new Map(report.runners.map((runner) => [runner.name, runner]));
    expect([...byName.keys()].sort()).toEqual(["cargo", "jest", "mocha", "node --test", "tsc"]);
    expect(byName.get("jest")).toMatchObject({ status: "warn", command: "dot-test-digest -- npx jest" });
    expect(byName.get("jest")?.note).toContain("fixtures only");
    expect(byName.get("mocha")).toMatchObject({ status: "warn", command: "dot-test-digest -- npx mocha" });
    expect(byName.get("mocha")?.note).toContain("no grammar");
    expect(byName.get("node --test")).toMatchObject({ status: "ok", command: "dot-test-digest -- node --test" });
    expect(byName.get("cargo")).toMatchObject({ status: "warn", command: "dot-test-digest -- cargo test" });
    expect(byName.get("cargo")?.note).toContain("fixtures only");
    expect(byName.get("tsc")).toMatchObject({ status: "ok", command: "dot-test-digest -- npx tsc --noEmit" });
    expect(report.ok).toBe(true);
    expect(run.code).toBe(0);
  });

  it("An invalid config fails the check", async () => {
    const dir = project({ [PROJECT_FILE]: '{ "maxCluster": 3 }' });
    const run = await runMain(["doctor"], { cwd: dir, home: tempDir("dtd-doctor-home-"), deps: { env: envWithoutKey() } });
    expect(run.stdout.split("\n")).toContain(`fail  config: ${path.join(dir, PROJECT_FILE)}: unknown key "maxCluster"`);
    expect(run.code).toBe(1);
  });

  it("An unusable cache fails the check", async () => {
    const file = path.join(fs.realpathSync(tempDir("dtd-doctor-file-")), "plain-file");
    fs.writeFileSync(file, "not a directory\n");
    const run = await runMain(["doctor"], { cwd: project(), home: path.join(file, "cache"), deps: { env: envWithoutKey() } });
    expect(run.stdout.split("\n").some((line) => line.startsWith(`fail  cache: ${file}/cache`))).toBe(true);
    expect(run.code).toBe(1);
  });

  it("The API key is never printed", async () => {
    const dir = project();
    const env = envWithoutKey({ TYPESAFE_API_KEY: "sk-secret-123" });
    const text = await runMain(["doctor"], { cwd: dir, home: tempDir("dtd-doctor-home-"), deps: { env } });
    const json = await runMain(["doctor", "--json"], { cwd: dir, home: tempDir("dtd-doctor-home-"), deps: { env } });
    for (const run of [text, json]) expect(run.stdout + run.stderr).not.toContain("sk-secret-123");
    expect(text.stdout.split("\n")).toContain("ok    gear1: TYPESAFE_API_KEY is set");
    const gear1 = (JSON.parse(json.stdout) as DoctorJson).checks.find((check) => check.name === "gear1");
    expect(gear1).toEqual({ name: "gear1", status: "ok", detail: "TYPESAFE_API_KEY is set" });
  });

  it("doctor writes nothing", async () => {
    const dir = vitestCart();
    const parent = fs.realpathSync(tempDir("dtd-doctor-parent-"));
    const home = path.join(parent, "home");
    const before = { dir: snapshot(dir), parent: snapshot(parent) };
    const run = await runMain(["doctor"], { cwd: dir, home, deps: { env: envWithoutKey() } });
    expect(run.stdout.split("\n")).toContain(`ok    cache: ${home} (writable, 0 runs, 0 KiB)`);
    expect(fs.existsSync(home)).toBe(false);
    expect({ dir: snapshot(dir), parent: snapshot(parent) }).toEqual(before);
    expect(run.code).toBe(0);
  });
});

describe("init (doctor-and-init)", () => {
  it("init writes a new file", async () => {
    const dir = project();
    const home = tempDir("dtd-init-home-");
    const file = path.join(dir, PROJECT_FILE);
    const run = await runMain(["init"], { cwd: dir, home, deps: { env: envWithoutKey() } });
    expect(run.code).toBe(0);
    expect(run.stdout).toBe(`wrote ${file}\n`);
    expect(fs.readFileSync(file, "utf8")).toBe(
      '{\n  "maxClusters": 5,\n  "contextLines": 2,\n  "format": "compact-md",\n  "noJev": false\n}\n',
    );
    expect(fs.readdirSync(dir).sort()).toEqual([".dot-test-digest.json", ".git"]);
    const config = await runMain(["config"], { cwd: dir, home, deps: { env: envWithoutKey() } });
    const lines = config.stdout.split("\n");
    for (const line of ["maxClusters = 5", "contextLines = 2", "format = compact-md", "noJev = false"]) {
      expect(lines).toContain(`${line} (project ${file})`);
    }
  });

  it("init keeps an existing file", async () => {
    const dir = project({ [PROJECT_FILE]: '{ "maxClusters": 9 }' });
    const file = path.join(dir, PROJECT_FILE);
    const home = tempDir("dtd-init-home-");
    const first = await runMain(["init"], { cwd: dir, home, deps: { env: envWithoutKey() } });
    expect(first.code).toBe(64);
    expect(first.stderr).toBe(`${file} already exists (use --force to overwrite)\n`);
    expect(first.stdout).toBe("");
    expect(fs.readFileSync(file, "utf8")).toBe('{ "maxClusters": 9 }');
    const forced = await runMain(["init", "--force"], { cwd: dir, home, deps: { env: envWithoutKey() } });
    expect(forced.code).toBe(0);
    expect((JSON.parse(fs.readFileSync(file, "utf8")) as { maxClusters: number }).maxClusters).toBe(5);
  });
});

const asRoot = process.getuid?.() === 0;

/** Runs `body` with `target` at `mode`, restoring a writable mode afterwards so the temp dir can be removed. */
async function withMode<T>(target: string, mode: number, body: () => Promise<T>): Promise<T> {
  fs.chmodSync(target, mode);
  try {
    return await body();
  } finally {
    fs.chmodSync(target, 0o755);
  }
}

describe("doctor reports what it cannot read (review fixes)", () => {
  it.skipIf(asRoot)("an unreadable directory in the cache fails the cache check, not the run", async () => {
    const home = fs.realpathSync(tempDir("dtd-doctor-home-"));
    const locked = path.join(home, "logs", "x");
    fs.mkdirSync(locked, { recursive: true });
    const run = await withMode(locked, 0o000, () =>
      runMain(["doctor"], { cwd: project(), home, deps: { env: envWithoutKey() } }),
    );
    expect(run.stdout.split("\n")).toContain(`fail  cache: ${home} (cannot read ${locked}: EACCES)`);
    expect(run.stderr).toBe("");
    expect(run.code).toBe(1);
  });

  it("an empty TYPESAFE_API_KEY wins over JEV_API_KEY and means not configured", async () => {
    const env = envWithoutKey({ TYPESAFE_API_KEY: "", JEV_API_KEY: "sk-other" });
    const run = await runMain(["doctor"], { cwd: project(), home: tempDir("dtd-doctor-home-"), deps: { env } });
    expect(run.stdout.split("\n")).toContain("warn  gear1: TYPESAFE_API_KEY is empty (Jev disabled; heuristic fallback)");
    expect(run.stdout).not.toContain("sk-other");
  });

  it("JEV_API_KEY alone counts as set", async () => {
    const env = envWithoutKey({ JEV_API_KEY: "sk-other" });
    const run = await runMain(["doctor"], { cwd: project(), home: tempDir("dtd-doctor-home-"), deps: { env } });
    expect(run.stdout.split("\n")).toContain("ok    gear1: JEV_API_KEY is set");
  });

  it("noJev in the config makes gear1 a warning even with a key", async () => {
    const dir = project({ [PROJECT_FILE]: '{ "noJev": true }' });
    const env = envWithoutKey({ TYPESAFE_API_KEY: "sk-secret-123" });
    const run = await runMain(["doctor"], { cwd: dir, home: tempDir("dtd-doctor-home-"), deps: { env } });
    expect(run.stdout.split("\n")).toContain(
      `warn  gear1: Jev disabled by noJev (project ${path.join(dir, PROJECT_FILE)}); heuristic fallback`,
    );
    expect(run.stdout).not.toContain("sk-secret-123");
    expect(run.code).toBe(0);
  });

  it("an unreadable package.json is a runner warning, not silence", async () => {
    for (const [contents, line] of [
      ["{", "warn  runner: package.json is not valid JSON"],
      ["[]", "warn  runner: package.json is not a JSON object"],
    ] as const) {
      const dir = project({ "package.json": contents, "tsconfig.json": "{}" });
      const run = await runMain(["doctor"], { cwd: dir, home: tempDir("dtd-doctor-home-"), deps: { env: envWithoutKey() } });
      const lines = run.stdout.split("\n");
      expect(lines).toContain(line);
      expect(lines).toContain("ok    runner: tsc (tsconfig.json) -> dot-test-digest -- npx tsc --noEmit");
      expect(run.code).toBe(0);
    }
  });

  it("a config warning is a warn line of the config check", async () => {
    const dir = project({ [PROJECT_FILE]: '{ "mcp": { "allow": [] } }' });
    const file = path.join(dir, PROJECT_FILE);
    const run = await runMain(["doctor"], { cwd: dir, home: tempDir("dtd-doctor-home-"), deps: { env: envWithoutKey() } });
    const lines = run.stdout.split("\n");
    expect(lines).toContain(`ok    config: project ${file}`);
    expect(lines).toContain(
      `warn  config: ignoring "mcp" in ${file}: the command allowlist is read from the user config only`,
    );
    expect(run.stderr).toBe("");
    expect(run.code).toBe(0);
  });
});

describe("init never writes through a link or into a directory (review fixes)", () => {
  function linkedProject(): { dir: string; file: string; outside: string } {
    const dir = project();
    const outside = path.join(fs.realpathSync(tempDir("dtd-init-outside-")), "bashrc");
    fs.writeFileSync(outside, "export SECRET=1\n");
    const file = path.join(dir, PROJECT_FILE);
    fs.symlinkSync(outside, file);
    return { dir, file, outside };
  }

  it("init on a symlink refuses and says it is a symlink", async () => {
    const { dir, file, outside } = linkedProject();
    const run = await runMain(["init"], { cwd: dir, home: tempDir("dtd-init-home-"), deps: { env: envWithoutKey() } });
    expect(run.code).toBe(64);
    expect(run.stderr).toBe(`${file} is a symlink (use --force to replace the link)\n`);
    expect(fs.readFileSync(outside, "utf8")).toBe("export SECRET=1\n");
    expect(fs.lstatSync(file).isSymbolicLink()).toBe(true);
  });

  it("init --force replaces the link itself and leaves its target unchanged", async () => {
    const { dir, file, outside } = linkedProject();
    const run = await runMain(["init", "--force"], { cwd: dir, home: tempDir("dtd-init-home-"), deps: { env: envWithoutKey() } });
    expect(run.code).toBe(0);
    expect(fs.readFileSync(outside, "utf8")).toBe("export SECRET=1\n");
    expect(fs.lstatSync(file).isFile()).toBe(true);
    expect((JSON.parse(fs.readFileSync(file, "utf8")) as { maxClusters: number }).maxClusters).toBe(5);
  });

  it("a directory at the config path is a usage error, with or without --force", async () => {
    const dir = project();
    const file = path.join(dir, PROJECT_FILE);
    fs.mkdirSync(file);
    for (const argv of [["init"], ["init", "--force"]]) {
      const run = await runMain(argv, { cwd: dir, home: tempDir("dtd-init-home-"), deps: { env: envWithoutKey() } });
      expect(run.code).toBe(64);
      expect(run.stderr).toBe(`${file} is a directory\n`);
    }
    expect(fs.statSync(file).isDirectory()).toBe(true);
  });

  it.skipIf(asRoot)("a read-only directory is a clear cannot-create error (exit 73)", async () => {
    const dir = project();
    const file = path.join(dir, PROJECT_FILE);
    const run = await withMode(dir, 0o555, () =>
      runMain(["init"], { cwd: dir, home: tempDir("dtd-init-home-"), deps: { env: envWithoutKey() } }),
    );
    expect(run.code).toBe(73);
    expect(run.stderr).toBe(`cannot create ${file}: EACCES\n`);
    expect(fs.existsSync(file)).toBe(false);
  });
});
