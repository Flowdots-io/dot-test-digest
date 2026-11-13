import fs from "node:fs";
import path from "node:path";
import { findProjectFile, loadConfig, userConfigPath } from "../config/load.js";
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

function readPackageJson(text: string | undefined): PackageJson | undefined {
  if (text === undefined) return undefined;
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof parsed !== "object" || parsed === null) return undefined;
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

/** The runners a directory's files name, in a fixed order; pure over the listing. */
export function detectRunners(listing: ProjectListing): DetectedRunner[] {
  const names = new Set(listing.names);
  const pkg = readPackageJson(listing.contents["package.json"]);
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
  return found.filter((entry): entry is DetectedRunner => entry !== false);
}

export function nodeCheck(version: string): Check {
  const major = Number(/^v?(\d+)/.exec(version)?.[1] ?? 0);
  return major >= MIN_NODE_MAJOR
    ? { name: "node", status: "ok", detail: `${version} (>= ${MIN_NODE_MAJOR})` }
    : { name: "node", status: "fail", detail: `${version} (needs >= ${MIN_NODE_MAJOR})` };
}

export function gear1Check(env: NodeJS.ProcessEnv): Check {
  for (const name of ["TYPESAFE_API_KEY", "JEV_API_KEY"]) {
    if (env[name]) return { name: "gear1", status: "ok", detail: `${name} is set` };
  }
  return { name: "gear1", status: "warn", detail: "TYPESAFE_API_KEY not set (Jev disabled; heuristic fallback)" };
}

function errorCode(error: unknown): string {
  return (error as NodeJS.ErrnoException).code ?? String(error);
}

/** Bytes of every file under `dir`. */
function sizeOf(dir: string): number {
  let bytes = 0;
  for (const entry of fs.readdirSync(dir, { withFileTypes: true })) {
    const full = path.join(dir, entry.name);
    bytes += entry.isDirectory() ? sizeOf(full) : entry.isFile() ? fs.statSync(full).size : 0;
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
  const kib = fs.existsSync(home) ? Math.ceil(sizeOf(home) / 1024) : 0;
  return { name: "cache", status: "ok", detail: `${home} (writable, ${runCount(logDir)} runs, ${kib} KiB)` };
}

export function configCheck(cwd: string, env: NodeJS.ProcessEnv): Check {
  try {
    loadConfig({ cwd, env });
  } catch (error) {
    if (error instanceof CliError) return { name: "config", status: "fail", detail: error.message };
    throw error;
  }
  const files = [
    ...[findProjectFile(cwd, env)].filter((file) => file !== undefined).map((file) => `project ${file}`),
    ...[userConfigPath(env)].filter((file) => fs.existsSync(file)).map((file) => `user ${file}`),
  ];
  return { name: "config", status: "ok", detail: files.length === 0 ? "none found" : files.join(", ") };
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
  const checks: Check[] = [
    nodeCheck(process.version),
    { name: "version", status: "ok", detail: VERSION },
    cacheCheck(path.dirname(context.logDir), context.logDir),
    configCheck(context.cwd, context.env),
    gear1Check(context.env),
  ];
  const runners = detectRunners(listProject(context.cwd));
  const failed = checks.some((check) => check.status === "fail");
  if (options.json) {
    context.write(`${JSON.stringify({ ok: !failed, checks, runners })}\n`);
  } else {
    const lines = [...checks, ...(runners.length === 0 ? [NO_RUNNER] : runners.map(runnerCheck))].map(formatCheck);
    context.write(`${lines.join("\n")}\n`);
  }
  return failed ? 1 : 0;
};
