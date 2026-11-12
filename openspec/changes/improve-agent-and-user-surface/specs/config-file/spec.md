## ADDED Requirements

### Requirement: Settings come from flags, the environment, a project file and a user file
Each setting SHALL take the first value found in this order: command-line flag, environment variable, project file, user file, built-in default. The settings are `maxClusters` (integer 1 to 15, default 5), `contextLines` (0 to 5, default 2), `format` (`compact-md`, `json` or `ndjson`, default `compact-md`), `noJev` (boolean, default `false`), `retryFlakes` (boolean, default `false`), `color` (`auto`, `always` or `never`, default `auto`), `progress` (boolean, default `false`), `retention.auto` (boolean, default `true`), `retention.keepRuns` (integer at least 0, default 50), `retention.maxAgeDays` (integer at least 0, default 14), `retention.stateMaxAgeDays` (integer at least 0, default 90) and `mcp.allow` (list of argv prefixes, user file only). `retention.keepRuns`, `retention.maxAgeDays` and `retention.stateMaxAgeDays` decide what is deleted across the whole cache, so, like `mcp`, they are read from the user file only (and from `gc` flags): a project file that sets one of them is ignored for that key with a stderr warning `ignoring retention.<key> in <file>: retention limits are read from the user config only`. A project file may still set `retention.auto: false`, which only deletes less. The project file is `.dot-test-digest.json`, found by walking up from the working directory to the first directory that contains `.git` (inclusive) and never above the user's home directory (compared by real path, so a symlinked home still stops the walk); when the working directory is outside the home directory and no `.git` bounds the walk, no project file is used (a shared directory such as `/tmp` must not configure someone else's run); only the nearest file is used. The user file is `$XDG_CONFIG_HOME/dot-test-digest/config.json` (default `~/.config/dot-test-digest/config.json`). Environment variables are `DOT_TEST_DIGEST_` plus the setting in upper snake case (`MAX_CLUSTERS`, `CONTEXT_LINES`, `FORMAT`, `NO_JEV`, `RETRY_FLAKES`, `COLOR`, `PROGRESS`); `DOT_TEST_DIGEST_PRUNE=0` is the spelling of `retention.auto: false`. Booleans accept `true`, `false`, `1` and `0`. `tddPhase` and `scopeId` are not settings: they stay flags.

#### Scenario: A project file sets a default
- **GIVEN** the cart with `.dot-test-digest.json` = `{ "maxClusters": 1 }` and a fresh home
- **WHEN** `-- node --test cart.test.js` runs
- **THEN** the header matches `\| 1 cluster \|` and the digest contains `+3 more clusters (see log)`

#### Scenario: A flag beats the environment, the environment beats the file
- **GIVEN** the same project file, `DOT_TEST_DIGEST_MAX_CLUSTERS=2` in the environment
- **WHEN** `-- node --test cart.test.js` runs, then `--max-clusters=3 -- node --test cart.test.js` runs
- **THEN** the first header says `2 clusters` and the second says `3 clusters`

#### Scenario: The user file is the lowest layer
- **GIVEN** a user file `{ "maxClusters": 4, "contextLines": 0 }` and the project file `{ "maxClusters": 1 }`
- **WHEN** `config` runs
- **THEN** `maxClusters = 1 (project <path>)` and `contextLines = 0 (user <path>)` are printed

#### Scenario: The nearest project file wins and the walk stops at .git
- **GIVEN** `/w/.dot-test-digest.json` = `{ "maxClusters": 9 }`, `/w/pkg/.git/` (a directory) and `/w/pkg/sub/` as the working directory with no file of its own
- **WHEN** `config` runs
- **THEN** `maxClusters` is `5 (default)`: the walk stopped at `/w/pkg`, which has no file, and never reached `/w`

#### Scenario: An unknown key is a usage error naming file and key
- **GIVEN** a project file `{ "maxCluster": 3 }`
- **WHEN** `-- true` runs
- **THEN** the exit code is `64` and stderr is `<path>: unknown key "maxCluster"`

#### Scenario: A bad config value is a usage error
- **GIVEN** a project file `{ "maxClusters": 99 }`, and separately `DOT_TEST_DIGEST_MAX_CLUSTERS=abc`
- **WHEN** `-- true` runs under each
- **THEN** both exit `64`, with `<path>: maxClusters must be between 1 and 15, got 99` and `DOT_TEST_DIGEST_MAX_CLUSTERS must be an integer between 1 and 15, got abc`

#### Scenario: Malformed JSON is a usage error
- **GIVEN** a project file containing `{ "maxClusters": `
- **WHEN** `-- true` runs
- **THEN** the exit code is `64` and stderr starts `<path>: invalid JSON:`

#### Scenario: The retention settings reach the prune
- **GIVEN** a user file `{ "retention": { "keepRuns": 2, "maxAgeDays": 0 } }` and a home with 5 run pairs older than one hour
- **WHEN** a run completes
- **THEN** the home holds 2 runs: the new one and the newest of the 5 old ones (the newest `keepRuns` runs include the current run)

#### Scenario: A project file cannot tighten retention
- **GIVEN** a project file `{ "retention": { "keepRuns": 0, "maxAgeDays": 0 } }` and the 60-old-runs home
- **WHEN** a run completes
- **THEN** the home holds 51 runs (the defaults applied) and stderr contains `ignoring retention.keepRuns in ` and `ignoring retention.maxAgeDays in `

#### Scenario: The prune switch has its legacy spelling
- **GIVEN** a project file `{ "retention": { "auto": false } }` and the 60-old-runs home
- **WHEN** a run completes
- **THEN** the home holds 61 runs

### Requirement: config prints the effective settings and where each came from
`config` SHALL print one line per setting, in the order of the list above, as `<key> = <value> (<source>)` where `<source>` is `default`, `user <path>`, `project <path>` or `env <NAME>`; `mcp.allow` is printed only when set. Flags are not part of `config`. The exit code is `0`, or `64` for an invalid file or variable as above.

#### Scenario: Defaults are printed with their source
- **GIVEN** no project or user file and no `DOT_TEST_DIGEST_*` variable
- **WHEN** `config` runs
- **THEN** stdout is exactly 11 lines: `maxClusters = 5 (default)`, `contextLines = 2 (default)`, `format = compact-md (default)`, `noJev = false (default)`, `retryFlakes = false (default)`, `color = auto (default)`, `progress = false (default)`, `retention.auto = true (default)`, `retention.keepRuns = 50 (default)`, `retention.maxAgeDays = 14 (default)`, `retention.stateMaxAgeDays = 90 (default)`

#### Scenario: Environment is reported by name
- **GIVEN** `DOT_TEST_DIGEST_FORMAT=json` and `DOT_TEST_DIGEST_PRUNE=0`
- **WHEN** `config` runs
- **THEN** the lines `format = json (env DOT_TEST_DIGEST_FORMAT)` and `retention.auto = false (env DOT_TEST_DIGEST_PRUNE)` are printed

### Requirement: A project file cannot set the MCP allowlist
`mcp.allow` SHALL be read from the user file only. A project file that contains an `mcp` key SHALL still be valid; that key is ignored and `dot-test-digest: ignoring "mcp" in <path>: the command allowlist is read from the user config only` is printed on stderr once per process that loads configuration (exit code unchanged).

#### Scenario: The project allowlist is ignored with a warning
- **GIVEN** a project file `{ "mcp": { "allow": [["rm"]] } }` and a user file `{ "mcp": { "allow": [["pnpm", "test"]] } }`
- **WHEN** `config` runs
- **THEN** `mcp.allow = [["pnpm","test"]] (user <path>)` is printed, the exit code is `0`, and stderr is the warning above followed by a newline
