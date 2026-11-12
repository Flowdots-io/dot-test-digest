import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import { UsageError } from "../cli/errors.js";
import {
  SETTINGS,
  SETTINGS_BY_KEY,
  SETTING_GROUPS,
  defaultValues,
  type SettingKey,
  type SettingSpec,
  type SettingValues,
} from "./settings.js";

export const PROJECT_FILE = ".dot-test-digest.json";

/** `default`, `user <path>`, `project <path>` or `env <NAME>`, as `config` prints it. */
export type SettingSource = "default" | `user ${string}` | `project ${string}` | `env ${string}`;

export interface LoadedConfig {
  values: SettingValues;
  sources: Record<SettingKey, SettingSource>;
  /** stderr lines (without the newline) the caller prints once. */
  warnings: string[];
}

export interface ConfigLocation {
  cwd: string;
  env: NodeJS.ProcessEnv;
}

function homeOf(env: NodeJS.ProcessEnv): string {
  return env["HOME"] || os.homedir();
}

/** `$XDG_CONFIG_HOME/dot-test-digest/config.json`, else under `~/.config`. */
export function userConfigPath(env: NodeJS.ProcessEnv): string {
  const xdg = env["XDG_CONFIG_HOME"];
  const base = xdg && path.isAbsolute(xdg) ? xdg : path.join(homeOf(env), ".config");
  return path.join(base, "dot-test-digest", "config.json");
}

function realOrResolved(target: string): string {
  try {
    return fs.realpathSync(target);
  } catch {
    return path.resolve(target);
  }
}

/**
 * The nearest project file, walking up to the first directory holding `.git` and never above the home directory
 * (by real path). Outside home, a walk that no `.git` bounds finds nothing: a shared directory such as `/tmp` must
 * not configure someone else's run.
 */
export function findProjectFile(cwd: string, env: NodeJS.ProcessEnv): string | undefined {
  const home = realOrResolved(homeOf(env));
  let nearest: string | undefined;
  for (let dir = realOrResolved(cwd); ; ) {
    const candidate = path.join(dir, PROJECT_FILE);
    nearest ??= fs.existsSync(candidate) ? candidate : undefined;
    if (fs.existsSync(path.join(dir, ".git")) || dir === home) return nearest;
    const parent = path.dirname(dir);
    if (parent === dir) return undefined;
    dir = parent;
  }
}

/** The file's top-level object, or `undefined` when it does not exist. */
function readJsonObject(file: string): Record<string, unknown> | undefined {
  let text: string;
  try {
    text = fs.readFileSync(file, "utf8");
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === "ENOENT") return undefined;
    throw new UsageError(`${file}: cannot read: ${(error as Error).message}`);
  }
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (error) {
    throw new UsageError(`${file}: invalid JSON: ${(error as Error).message}`);
  }
  if (!isObject(parsed)) throw new UsageError(`${file}: must be a JSON object`);
  return parsed;
}

function isObject(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

/** `{ "retention": { "keepRuns": 2 } }` becomes the setting `retention.keepRuns` and `2`; an unknown key is a usage error. */
function settingsIn(file: string, object: Record<string, unknown>): [SettingSpec, unknown][] {
  const lookup = (key: string, nested = false): SettingSpec => {
    // A dotted name is how `config` prints a nested key, not a key a file may use at the top.
    const spec = nested || !key.includes(".") ? SETTINGS_BY_KEY.get(key) : undefined;
    if (spec === undefined) throw new UsageError(`${file}: unknown key ${JSON.stringify(key)}`);
    return spec;
  };
  const entries: [SettingSpec, unknown][] = [];
  for (const [key, value] of Object.entries(object)) {
    if (!SETTING_GROUPS.has(key)) {
      entries.push([lookup(key), value]);
      continue;
    }
    if (!isObject(value)) throw new UsageError(`${file}: ${key} must be an object, got ${JSON.stringify(value)}`);
    for (const [inner, innerValue] of Object.entries(value)) entries.push([lookup(`${key}.${inner}`, true), innerValue]);
  }
  return entries;
}

export function loadConfig(location: ConfigLocation): LoadedConfig {
  const values = defaultValues() as unknown as Record<SettingKey, unknown>;
  const sources = Object.fromEntries(SETTINGS.map((spec) => [spec.key, "default"])) as Record<SettingKey, SettingSource>;
  const warnings: string[] = [];

  const applyFile = (file: string, layer: "user" | "project"): void => {
    const object = readJsonObject(file);
    if (object === undefined) return;
    if (layer === "project" && "mcp" in object) {
      // A repository must not widen what the MCP server may run on this machine.
      warnings.push(
        `dot-test-digest: ignoring "mcp" in ${file}: the command allowlist is read from the user config only`,
      );
      delete object["mcp"];
    }
    for (const [spec, raw] of settingsIn(file, object)) {
      const parsed = spec.kind.fromFile(raw);
      if (!parsed.ok) throw new UsageError(`${file}: ${spec.key} ${parsed.reason}`);
      values[spec.key] = parsed.value;
      sources[spec.key] = `${layer} ${file}`;
    }
  };

  applyFile(userConfigPath(location.env), "user");
  const projectFile = findProjectFile(location.cwd, location.env);
  if (projectFile !== undefined) applyFile(projectFile, "project");

  for (const spec of SETTINGS) {
    if (spec.env === undefined) continue;
    const raw = location.env[spec.env];
    if (raw === undefined || raw === "") continue;
    const parsed = spec.kind.fromEnv(raw);
    if (!parsed.ok) throw new UsageError(`${spec.env} ${parsed.reason}`);
    values[spec.key] = parsed.value;
    sources[spec.key] = `env ${spec.env}`;
  }

  return { values: values as unknown as SettingValues, sources, warnings };
}
