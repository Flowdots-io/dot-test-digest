import fs from "node:fs";
import path from "node:path";
import { findProjectFile, loadConfig, userConfigPath, type LoadedConfig } from "../config/load.js";
import { VERSION } from "../version.js";
import type { Subcommand } from "./dispatch.js";
import { CliError, UsageError } from "./errors.js";

const DOCTOR_USAGE = "dot-test-digest doctor [--json]";
const MIN_NODE_MAJOR = 20;
const FIXTURES_ONLY = "grammar checked against fixtures only";
const NO_GRAMMAR = "no grammar; heuristic fallback";

export type CheckStatus = "ok" | "warn" | "fail";

export interface Check {
  name: string;
  status: CheckStatus;
  detail: string;
}

export interface DetectedRunner {
  name: string;
  status: Exclude<CheckStatus, "fail">;
  /** The file that gave the runner away. */
  source: string;
  /** The suggested wrapped command. */
  command: string;
  /** Why the status is `warn`. */
  note?: string;
}

/** What runner detection reads of the working directory: its entry names and the few files it looks into. */
export interface ProjectListing {
  names: readonly string[];
  /** The text of `package.json`, `pyproject.toml` and `setup.cfg`, for those that exist. */
  contents: Readonly<Record<string, string>>;
}

const LOOKED_INTO = ["package.json", "pyproject.toml", "setup.cfg"] as const;

export function listProject(dir: string): ProjectListing {
  let names: string[];
  try {
    names = fs.readdirSync(dir);
  } catch {
    names = [];
  }
  const contents: Record<string, string> = {};
  for (const name of LOOKED_INTO) {
    if (!names.includes(name)) continue;
    try {
      contents[name] = fs.readFileSync(path.join(dir, name), "utf8");
    } catch {
      // An unreadable file gives nothing away.
    }
  }
  return { names, contents };
}

interface PackageJson {
  dependencies: ReadonlySet<string>;
  testScript: string;
}

/** The parsed file, `undefined` when there is none, or why it cannot be read. */
function readPackageJson(text: string | undefined): PackageJson | undefined | { problem: string } {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return { problem: "package.json is not valid JSON" };
  }
  if (typeof parsed !== "object" || parsed === null || Array.isArray(parsed)) {
    return { problem: "package.json is not a JSON object" };
  }
  const record = parsed as Record<string, unknown>;
  const dependencies = new Set<string>();
  for (const field of ["dependencies", "devDependencies", "optionalDependencies", "peerDependencies"]) {
    const value = record[field];
    if (typeof value === "object" && value !== null) for (const name of Object.keys(value)) dependencies.add(name);
  }
  const scripts = record["scripts"];
  const test = typeof scripts === "object" && scripts !== null ? (scripts as Record<string, unknown>)["test"] : undefined;
  return { dependencies, testScript: typeof test === "string" ? test : "" };
}

function runner(name: string, source: string, command: string, note?: string): DetectedRunner {
  return {
    name,
    status: note === undefined ? "ok" : "warn",
    source,
    command: `dot-test-digest -- ${command}`,
    ...(note === undefined ? {} : { note }),
  };
}

export interface RunnerDetection {
  runners: DetectedRunner[];
  /** A file that should have told something but could not be read, such as a malformed `package.json`. */
  problems: string[];
}

/** The runners a directory's files name, in a fixed order; pure over the listing. */
export function detectRunners(listing: ProjectListing): RunnerDetection {
  const names = new Set(listing.names);
  const read = readPackageJson(listing.contents["package.json"]);
  const pkg = read === undefined || "problem" in read ? undefined : read;
  const dependsOn = (name: string): boolean => pkg?.dependencies.has(name) === true;
  const mentionsPytest = (file: string): boolean => listing.contents[file]?.includes("pytest") === true;
  const pytestSource = names.has("pytest.ini")
    ? "pytest.ini"
    : (["pyproject.toml", "setup.cfg"] as const).find(mentionsPytest);

  const found: (DetectedRunner | false)[] = [
    dependsOn("vitest") && runner("vitest", "package.json", "npx vitest run"),
    dependsOn("jest") && runner("jest", "package.json", "npx jest", FIXTURES_ONLY),
    dependsOn("mocha") && runner("mocha", "package.json", "npx mocha", NO_GRAMMAR),
    pkg?.testScript.includes("node --test") === true && runner("node --test", "package.json scripts.test", "node --test"),
    pytestSource !== undefined && runner("pytest", pytestSource, "pytest", FIXTURES_ONLY),
    names.has("Cargo.toml") && runner("cargo", "Cargo.toml", "cargo test", FIXTURES_ONLY),
    names.has("go.mod") && runner("go", "go.mod", "go test ./...", FIXTURES_ONLY),
    names.has("tsconfig.json") && runner("tsc", "tsconfig.json", "npx tsc --noEmit"),
    dependsOn("eslint") && runner("eslint", "package.json", "npx eslint .", FIXTURES_ONLY),
  ];
  return {
    runners: found.filter((entry): entry is DetectedRunner => entry !== false),
    problems: read !== undefined && "problem" in read ? [read.problem] : [],
  };
}

export function nodeCheck(version: string): Check {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", status: "ok", detail: `${version} (>= ${MIN_NODE_MAJOR})` }
    : { name: "node", status: "fail", detail: `${version} (needs >= ${MIN_NODE_MAJOR})` };
}

/** The rule of `JevClient`: `TYPESAFE_API_KEY ?? JEV_API_KEY`, so an empty first one wins and means not configured. */
export function gear1Check(env: NodeJS.ProcessEnv, noJevSource?: string): Check {
  const disabled = (detail: string): Check => ({ name: "gear1", status: "warn", detail });
  if (noJevSource !== undefined) return disabled(`Jev disabled by noJev (${noJevSource}); heuristic fallback`);
  const name = env["TYPESAFE_API_KEY"] !== undefined ? "TYPESAFE_API_KEY" : env["JEV_API_KEY"] !== undefined ? "JEV_API_KEY" : undefined;
  if (name === undefined) return disabled("TYPESAFE_API_KEY not set (Jev disabled; heuristic fallback)");
  if (env[name] === "") return disabled(`${name} is empty (Jev disabled; heuristic fallback)`);
  return { name: "gear1", status: "ok", detail: `${name} is set` };
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? String(error);
}

class UnreadableEntry extends Error {
  constructor(readonly entry: string, readonly code: string) {
    super(`cannot read ${entry}: ${code}`);
  }
}

/** Bytes of every file under `dir`; an entry that vanishes meanwhile (a concurrent prune) counts as nothing. */
function sizeOf(dir: string): number {
  const attempt = <T>(entry: string, read: () => T, gone: T): T => {
    try {
      return read();
    } catch (error) {
      if (errorCode(error) === "ENOENT") return gone;
      throw new UnreadableEntry(entry, errorCode(error));
    }
  };
  let bytes = 0;
  for (const entry of attempt(dir, () => fs.readdirSync(dir, { withFileTypes: true }), [])) {
    const full = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? sizeOf(full) : entry.isFile() ? attempt(full, () => fs.statSync(full).size, 0) : 0;
  }
  return bytes;
}

function runCount(logDir: string): number {
  let names: string[];
  try {
    names = fs.readdirSync(logDir);
  } catch {
    return 0;
  }
  return new Set(names.filter((name) => /^run_.*\.(log|json)$/.test(name)).map((name) => name.replace(/\.\w+$/, ""))).size;
}

/** Whether `home` could hold the cache, decided without creating anything. */
function cacheProblem(home: string): string | undefined {
  for (let dir = home; ; dir = path.dirname(dir)) {
    let stat: fs.Stats;
    try {
      stat = fs.statSync(dir);
    } catch (error) {
      if (errorCode(error) !== "ENOENT") return `cannot inspect ${dir}: ${errorCode(error)}`;
      if (path.dirname(dir) === dir) return `${dir} does not exist`;
      continue;
    }
    if (!stat.isDirectory()) return `not a directory: ${dir}`;
    try {
      fs.accessSync(dir, fs.constants.W_OK | fs.constants.X_OK);
    } catch {
      return `not writable: ${dir}`;
    }
    return undefined;
  }
}

export function cacheCheck(home: string, logDir: string): Check {
  const problem = cacheProblem(home);
  if (problem !== undefined) return { name: "cache", status: "fail", detail: `${home} (${problem})` };
  let bytes: number;
  try {
    bytes = sizeOf(home);
  } catch (error) {
    if (error instanceof UnreadableEntry) return { name: "cache", status: "fail", detail: `${home} (${error.message})` };
    throw error;
  }
  const kib = Math.ceil(bytes / 1024);
  return { name: "cache", status: "ok", detail: `${home} (writable, ${runCount(logDir)} runs, ${kib} KiB)` };
}

const WARNING_PREFIX = "dot-test-digest: ";

/** The `config` check and its warnings, plus where `noJev` was turned on, if it was. */
export function configChecks(cwd: string, env: NodeJS.ProcessEnv): { checks: Check[]; noJevSource?: string } {
  let config: LoadedConfig;
  try {
    config = loadConfig({ cwd, env });
  } catch (error) {
    if (error instanceof CliError) return { checks: [{ name: "config", status: "fail", detail: error.message }] };
    throw error;
  }
  const files = [
    ...[findProjectFile(cwd, env)].filter((file) => file !== undefined).map((file) => `project ${file}`),
    ...[userConfigPath(env)].filter((file) => fs.existsSync(file)).map((file) => `user ${file}`),
  ];
  const warnings = config.warnings.map(
    (warning): Check => ({
      name: "config",
      status: "warn",
      detail: warning.startsWith(WARNING_PREFIX) ? warning.slice(WARNING_PREFIX.length) : warning,
    }),
  );
  return {
    checks: [{ name: "config", status: "ok", detail: files.length === 0 ? "none found" : files.join(", ") }, ...warnings],
    ...(config.values.noJev ? { noJevSource: config.sources.noJev } : {}),
  };
}

function runnerCheck(detected: DetectedRunner): Check {
  const note = detected.note === undefined ? "" : ` (${detected.note})`;
  return { name: "runner", status: detected.status, detail: `${detected.name} (${detected.source}) -> ${detected.command}${note}` };
}

const NO_RUNNER: Check = {
  name: "runner",
  status: "warn",
  detail: "none detected (wrap your own command: dot-test-digest -- <command>)",
};

export function formatCheck(check: Check): string {
  return `${check.status.padEnd(6)}${check.name}: ${check.detail}`;
}

function parseDoctorArgs(args: readonly string[]): { json: boolean } {
  let json = false;
  for (const arg of args) {
    if (arg === "--json") json = true;
    else throw new UsageError(`unexpected argument "${arg}": ${DOCTOR_USAGE}`);
  }
  return { json };
}

/** `doctor [--json]`: one line per check; exit 1 when one failed. Reads only, never the network. */
export const runDoctor: Subcommand = (args, context) => {
  const options = parseDoctorArgs(args);
  const config = configChecks(context.cwd, context.env);
  const { runners, problems } = detectRunners(listProject(context.cwd));
  const checks: Check[] = [
    nodeCheck(process.version),
    { name: "version", status: "ok", detail: VERSION },
    cacheCheck(path.dirname(context.logDir), context.logDir),
    ...config.checks,
    gear1Check(context.env, config.noJevSource),
    ...problems.map((detail): Check => ({ name: "runner", status: "warn", detail })),
  ];
  const failed = checks.some((check) => check.status === "fail");
  if (options.json) {
    context.write(`${JSON.stringify({ ok: !failed, checks, runners })}\n`);
  } else {
    const lines = [...checks, ...(runners.length === 0 ? [NO_RUNNER] : runners.map(runnerCheck))].map(formatCheck);
    context.write(`${lines.join("\n")}\n`);
  }
  return failed ? 1 : 0;
};
