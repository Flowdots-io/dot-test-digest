## ADDED Requirements

### Requirement: doctor checks the setup and names the command for the detected runner
`doctor [--json]` SHALL print one line per check, `ok`, `warn` or `fail` followed by the check name and detail, and exit `0` unless a check failed (`1`). It never calls the network and never writes. Checks, in order: `node` (the version; `fail` below 20), `version` (the tool version), `cache` (the resolved directory; `ok` with `writable`, the run count and size in KiB when it exists or can be created; `fail` otherwise), `config` (`ok` with the paths of the project and user files found or `none found`; `fail` with the usage-error text when one is invalid), `gear1` (`ok` when `TYPESAFE_API_KEY` is set, without printing it; `warn` `TYPESAFE_API_KEY not set (Jev disabled; heuristic fallback)` otherwise) and `runner`, one line per runner detected in the working directory: `vitest` or `jest` (a dependency in `package.json`), `node --test` (a `scripts.test` containing `node --test`), `pytest` (`pytest.ini`, or `pyproject.toml`/`setup.cfg` mentioning pytest), `cargo` (`Cargo.toml`), `go` (`go.mod`), `tsc` (`tsconfig.json`), `eslint` (a dependency), each with the suggested wrapped command, and `warn` for `mocha` (a dependency; no grammar, heuristic fallback) and for a runner whose grammar is checked against fixtures only (`jest`, `pytest`, `cargo`, `go`, `eslint`).

#### Scenario: doctor on a vitest project
- **GIVEN** the vitest cart fixture as the working directory, a fresh home, `TYPESAFE_API_KEY` unset, Node 22
- **WHEN** `doctor` runs
- **THEN** the exit code is `0` and stdout is the lines `ok    node: v22.<minor>.<patch> (>= 20)`, `ok    version: <the version in package.json>`, `ok    cache: <home> (writable, 0 runs, 0 KiB)`, `ok    config: none found`, `warn  gear1: TYPESAFE_API_KEY not set (Jev disabled; heuristic fallback)`, `ok    runner: vitest (package.json) -> dot-test-digest -- npx vitest run`

#### Scenario: doctor on a project with several runners
- **GIVEN** a directory with `package.json` `{ "devDependencies": { "jest": "29", "mocha": "10" }, "scripts": { "test": "node --test" } }`, `Cargo.toml` and `tsconfig.json`
- **WHEN** `doctor --json` runs
- **THEN** the JSON `runners` list contains `jest` (warn, fixtures only), `mocha` (warn, no grammar), `node --test` (ok), `cargo` (warn, fixtures only) and `tsc` (ok), each with its `command`

#### Scenario: An invalid config fails the check
- **GIVEN** a project file `{ "maxCluster": 3 }`
- **WHEN** `doctor` runs
- **THEN** the exit code is `1` and stdout contains `fail  config: <path>: unknown key "maxCluster"`

#### Scenario: An unusable cache fails the check
- **GIVEN** `DOT_TEST_DIGEST_HOME` is a path under a regular file (`<file>/cache`)
- **WHEN** `doctor` runs
- **THEN** the exit code is `1` and stdout contains a line starting `fail  cache: <file>/cache`

#### Scenario: The API key is never printed
- **GIVEN** `TYPESAFE_API_KEY=sk-secret-123`
- **WHEN** `doctor` and `doctor --json` run
- **THEN** neither output contains `sk-secret-123`, and the gear1 line is `ok    gear1: TYPESAFE_API_KEY is set`

#### Scenario: doctor writes nothing
- **GIVEN** a fresh home that does not exist yet
- **WHEN** `doctor` runs
- **THEN** the directory still does not exist

### Requirement: init writes a starter config and refuses to overwrite
`init` SHALL write `.dot-test-digest.json` in the working directory with the keys `maxClusters` 5, `contextLines` 2, `format` `"compact-md"`, `noJev` false, formatted with two-space indentation and a final newline, print `wrote <path>` and exit `0`. If the file exists it SHALL exit `64` with `<path> already exists (use --force to overwrite)` and change nothing; `--force` overwrites. `init` writes no other file.

#### Scenario: init writes a new file
- **GIVEN** a directory without `.dot-test-digest.json`
- **WHEN** `init` runs
- **THEN** the file content is `{\n  "maxClusters": 5,\n  "contextLines": 2,\n  "format": "compact-md",\n  "noJev": false\n}\n`, stdout is `wrote <dir>/.dot-test-digest.json`, and `config` run afterwards reports those four keys as `project`

#### Scenario: init keeps an existing file
- **GIVEN** an existing `.dot-test-digest.json` containing `{ "maxClusters": 9 }`
- **WHEN** `init` runs, then `init --force` runs
- **THEN** the first exits `64` and leaves the file untouched; the second exits `0` and the file has `maxClusters` `5`
