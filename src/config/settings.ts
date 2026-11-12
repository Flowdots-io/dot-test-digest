import { OutputFormatSchema, type OutputFormat } from "../types/schema.js";

export const COLOR_MODES = ["auto", "always", "never"] as const;
export type ColorMode = (typeof COLOR_MODES)[number];

/** Every setting, by the dotted name `config` prints and the files nest. */
export interface SettingValues {
  maxClusters: number;
  contextLines: number;
  format: OutputFormat;
  noJev: boolean;
  retryFlakes: boolean;
  color: ColorMode;
  progress: boolean;
  "retention.auto": boolean;
  "retention.keepRuns": number;
  "retention.maxAgeDays": number;
  "retention.stateMaxAgeDays": number;
  /** argv prefixes the MCP server may run; read from the user file only. */
  "mcp.allow": string[][];
}

export type SettingKey = keyof SettingValues;

type Parsed<T> = { ok: true; value: T } | { ok: false; reason: string };

/** How one kind of value is read from a JSON file and from an environment variable, and printed. */
interface Kind<T> {
  fromFile(value: unknown): Parsed<T>;
  fromEnv(raw: string): Parsed<T>;
  show(value: T): string;
}

const ok = <T>(value: T): Parsed<T> => ({ ok: true, value });
const bad = <T>(reason: string): Parsed<T> => ({ ok: false, reason });

function integer(min: number, max?: number): Kind<number> {
  const bounds = max === undefined ? `at least ${min}` : `between ${min} and ${max}`;
  const inRange = (value: number): boolean => value >= min && (max === undefined || value <= max);
  return {
    fromFile: (value) => {
      if (typeof value !== "number" || !Number.isInteger(value)) {
        return bad(`must be an integer ${bounds}, got ${JSON.stringify(value)}`);
      }
      return inRange(value) ? ok(value) : bad(`must be ${bounds}, got ${value}`);
    },
    fromEnv: (raw) => {
      const value = Number(raw);
      return /^-?\d+$/.test(raw) && inRange(value) ? ok(value) : bad(`must be an integer ${bounds}, got ${raw}`);
    },
    show: String,
  };
}

const BOOLEAN_WORDS: Readonly<Record<string, boolean>> = { true: true, false: false, "1": true, "0": false };

const boolean: Kind<boolean> = {
  fromFile: (value) =>
    typeof value === "boolean"
      ? ok(value)
      : value === 1 || value === 0
        ? ok(value === 1)
        : bad(`must be true, false, 1 or 0, got ${JSON.stringify(value)}`),
  fromEnv: (raw) => {
    const value = BOOLEAN_WORDS[raw];
    return value === undefined ? bad(`must be true, false, 1 or 0, got ${raw}`) : ok(value);
  },
  show: String,
};

function oneOf<const T extends string>(values: readonly T[]): Kind<T> {
  const list = `${values.slice(0, -1).join(", ")} or ${values[values.length - 1]}`;
  const accept = (value: unknown): value is T => typeof value === "string" && (values as readonly string[]).includes(value);
  return {
    fromFile: (value) => (accept(value) ? ok(value) : bad(`must be ${list}, got ${JSON.stringify(value)}`)),
    fromEnv: (raw) => (accept(raw) ? ok(raw) : bad(`must be ${list}, got ${raw}`)),
    show: String,
  };
}

const argvPrefixes: Kind<string[][]> = {
  fromFile: (value) => {
    const valid =
      Array.isArray(value) &&
      value.every(
        (prefix) => Array.isArray(prefix) && prefix.length > 0 && prefix.every((word) => typeof word === "string"),
      );
    return valid
      ? ok(value as string[][])
      : bad(`must be a list of argv prefixes such as [["pnpm", "test"]], got ${JSON.stringify(value)}`);
  },
  fromEnv: (raw) => bad(`cannot be set from the environment, got ${raw}`),
  show: (value) => JSON.stringify(value),
};

export interface SettingSpec<K extends SettingKey = SettingKey> {
  key: K;
  kind: Kind<SettingValues[K]>;
  default: SettingValues[K];
  env?: string;
  userFileOnly?: boolean;
  /** `config` prints the line only when a file set it. */
  hiddenWhenDefault?: boolean;
}

function setting<K extends SettingKey>(spec: SettingSpec<K>): SettingSpec {
  return spec as unknown as SettingSpec;
}

/** In the order `config` prints them. */
export const SETTINGS: readonly SettingSpec[] = [
  setting({ key: "maxClusters", kind: integer(1, 15), default: 5, env: "DOT_TEST_DIGEST_MAX_CLUSTERS" }),
  setting({ key: "contextLines", kind: integer(0, 5), default: 2, env: "DOT_TEST_DIGEST_CONTEXT_LINES" }),
  setting({ key: "format", kind: oneOf(OutputFormatSchema.options), default: "compact-md", env: "DOT_TEST_DIGEST_FORMAT" }),
  setting({ key: "noJev", kind: boolean, default: false, env: "DOT_TEST_DIGEST_NO_JEV" }),
  setting({ key: "retryFlakes", kind: boolean, default: false, env: "DOT_TEST_DIGEST_RETRY_FLAKES" }),
  setting({ key: "color", kind: oneOf(COLOR_MODES), default: "auto", env: "DOT_TEST_DIGEST_COLOR" }),
  setting({ key: "progress", kind: boolean, default: false, env: "DOT_TEST_DIGEST_PROGRESS" }),
  setting({ key: "retention.auto", kind: boolean, default: true, env: "DOT_TEST_DIGEST_PRUNE" }),
  setting({ key: "retention.keepRuns", kind: integer(0), default: 50 }),
  setting({ key: "retention.maxAgeDays", kind: integer(0), default: 14 }),
  setting({ key: "retention.stateMaxAgeDays", kind: integer(0), default: 90 }),
  setting({ key: "mcp.allow", kind: argvPrefixes, default: [], userFileOnly: true, hiddenWhenDefault: true }),
];

export const SETTINGS_BY_KEY: ReadonlyMap<string, SettingSpec> = new Map(SETTINGS.map((spec) => [spec.key, spec]));

/** The objects a file nests its dotted keys under (`retention`, `mcp`). */
export const SETTING_GROUPS: ReadonlySet<string> = new Set(
  SETTINGS.filter((spec) => spec.key.includes(".")).map((spec) => spec.key.split(".")[0] ?? ""),
);

export function defaultValues(): SettingValues {
  return Object.fromEntries(SETTINGS.map((spec) => [spec.key, spec.default])) as unknown as SettingValues;
}
