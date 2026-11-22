## 0. Ordering and slices

Ten slices, each self-contained: its own capability specs, tests and docs task. Every task is test first: write the scenario's test, watch it fail for the predicted reason, then change the code. A slice is mergeable when its tasks are ticked and `pnpm run verify` passes.

- Slice S1 (1.x): run-hardening. S2 (2.x): run record. S6 (3.x): config and color. S3 (4.x): retention. S4 (5.x): replay and stats. S5 (6.x): digest input. S7 (7.x): agent output contract. S8 (8.x): bounded memory and progress. S9 (9.x): doctor and init. S10 (10.x): MCP. 11.x: release.
- First frontier: 1.1, 1.2 and 2.1 (no prerequisite).
- Parallel lanes after the first frontier: {1.x}, {2.1, 2.2}; after 2.2: {3.x then 4.x}, {5.x then 6.x}, {7.1, 7.2, 7.3}. Task 8.1 changes the input type of every adapter, so it waits for 7.3 (which also edits the adapters) and runs alone.
- Shared files and who goes first: `src/index.ts` (1.1, 2.1, 2.2, 4.1, 5.1), `src/formatters/envelope.ts` (1.2, 3.2, 7.1, 7.2, 7.3), `src/types/schema.ts` (1.2, 1.3, 7.1, 7.3). Within a file, tasks are serial in the order of their number.

## 1. S1 Hardening

- [ ] 1.1 A closed stdout keeps the exit code
  - scenarios: "A reader that closes stdout early does not change a failing child's code", "A reader that closes stdout early does not change a passing run"
  - blocked-by: none
  - Handle `EPIPE` on `process.stdout` (swallow it, keep the decided exit code), in `main()`'s write and in the entrypoint. Spawned-process tests; red first against the 0.1.x trace.

- [ ] 1.2 Skipped and warning counts, and the count-free pass line
  - scenarios: "Skipped and todo tests are shown on a pass", "Skipped tests are shown on a failure", "A run with no skipped test is unchanged", "eslint warnings are warnings, not skipped tests", "A long pass line still fits the ceiling", "A command with no test output", "A grammar that found zero tests keeps its counts", "The JSON of an unrecognized run is unchanged"
  - blocked-by: none
  - `summary.warnings` (optional, nonzero only) in `schema.ts`; `tsc-eslint` moves warnings out of `skipped`; header segments in `envelope.ts` (pass line and failure header share one counts function); `runGear0 === null` decides the `exit 0` form. Update the tests that assert `0 passed, 0 failed` for unrecognized output.

- [ ] 1.3 INVALID_GREEN and --allow-no-tests
  - scenarios: "A command that runs nothing is not a green", "Refactor needs a passing test too", "A run that only skips tests is not a green", "A real green is unchanged", "--allow-no-tests accepts an empty green", "The JSON envelope carries the new status", "Red and none are unchanged"
  - blocked-by: 1.2
  - `INVALID_GREEN` in the status enum, `evaluatePhase` green and refactor branches, `--allow-no-tests` in `args.ts` and `CliOptionsSchema`, the stderr message. Its `--allow-no-tests` scenario needs the pass line of 1.2.

- [ ] 1.4 Docs for S1
  - scenarios: none
  - blocked-by: 1.3
  - README (status table, exit-code table, the green row of the TDD gate), SPEC-002 §4.3 table rows and a new `INV-7` text, `.dotstack/features/` (`tdd-gate.md`, `pass-digest.md`, `exit-codes.md`). scenarios: none (documentation).

## 2. S2 Run record and show

- [ ] 2.1 The run record
  - scenarios: "A failing node run leaves a complete record", "The record keeps the phase, scope and options", "A killed child is recorded with its signal", "A failure to write the record never changes the exit code"
  - blocked-by: none
  - `src/runner/run-record.ts`: schema (zod), atomic write after rendering, `MainDeps.writeRecord`, the `clusters` list (kept and omitted), `digest_bytes` from the string written to stdout.

- [ ] 2.2 Subcommand dispatch, run references and show
  - scenarios: "last is the newest run of this directory", "A unique prefix resolves", "An ambiguous prefix is a usage error", "Unknown references exit 66", "A short prefix is a usage error", "show dispatches", "Other bare words keep the old error", "A program called show is still a program", "The help lists the subcommands", "A range of the cart log", "A cluster id selects its range", "Numbers are prefixed", "A range is clamped, a bad range is rejected", "An unknown cluster id is rejected", "The record can be printed", "A pruned run says so"
  - blocked-by: 2.1
  - `src/cli/dispatch.ts` (first-word table), `src/cli/run-ref.ts`, `src/cli/show.ts`; `--help` lists the subcommands. A synthetic-home helper in `tests/helpers/` writes records and logs for the reference scenarios.

- [ ] 2.3 Docs for S2
  - scenarios: none
  - blocked-by: 2.2
  - README (`show`, the run record), SPEC-002 §4.1 (subcommands, exit `66`), feature map `cli-surface.md`. scenarios: none (documentation).

## 3. S6 Config and color

- [ ] 3.1 Configuration layers and the config subcommand
  - scenarios: "A project file sets a default", "A flag beats the environment, the environment beats the file", "The user file is the lowest layer", "The nearest project file wins and the walk stops at .git", "An unknown key is a usage error naming file and key", "A bad config value is a usage error", "Malformed JSON is a usage error", "Defaults are printed with their source", "Environment is reported by name", "The project allowlist is ignored with a warning"
  - blocked-by: 2.2
  - `src/config/` (loader, zod schema, env mapping, project discovery); the settings feed `args.ts` as defaults; `config` subcommand; the `mcp` key warning. The two retention scenarios of the first requirement belong to task 4.1.

- [ ] 3.2 Terminal color
  - scenarios: "always colors a pass line", "always colors a failure red", "Stripping the color gives the plain output", "Auto is plain when stdout is not a terminal", "Auto colors on a terminal unless NO_COLOR is set", "JSON is never colored", "A bad color value is a usage error"
  - blocked-by: 3.1
  - `--color` flag, `deps.stdoutIsTTY`, SGR wrapping of the status word as a post-process of the rendered text (the size decision uses the uncolored text).

- [ ] 3.3 Docs for S6
  - scenarios: none
  - blocked-by: 3.2
  - README (configuration section with the table of keys and env names), SPEC-002 §4.1, feature map `config.md` (new). scenarios: none (documentation).

## 4. S3 Retention

- [ ] 4.1 Automatic pruning
  - scenarios: "Old runs beyond the newest 50 are removed", "Recent runs are kept even beyond 50", "Fewer than 50 runs are never pruned", "A log without a record is pruned by its mtime", "Files modified in the last hour are never deleted", "Old state files go, the current one stays", "The automatic prune can be switched off", "A prune failure keeps the exit code", "The retention settings reach the prune", "The prune switch has its legacy spelling", "A project file cannot tighten retention"
  - blocked-by: 3.1
  - `src/cache/prune.ts` `pruneCache(dir, options, now)` called after the digest is printed; `deps.prune`; `DOT_TEST_DIGEST_PRUNE`. Includes the two retention scenarios of the config requirement.

- [ ] 4.2 gc
  - scenarios: "gc with defaults on the 60-old-runs home", "gc with stricter numbers", "dry-run deletes nothing", "Bad values are usage errors", "gc on a missing cache"
  - blocked-by: 4.1
  - `src/cli/gc.ts` over `pruneCache` with `dryRun`.

- [ ] 4.3 Docs for S3
  - scenarios: none
  - blocked-by: 4.2
  - README (cache section: what is deleted and when), feature map `cache.md` (new). scenarios: none (documentation).

## 5. S4 Replay and stats

- [ ] 5.1 Extract the run pipeline
  - scenarios: none
  - blocked-by: 2.1
  - Refactor with no behavior change: `digestRun(input)` in `src/pipeline.ts`, used by `main()`. Done when `pnpm run verify` passes unmodified. scenarios: none (refactor, covered by the existing 296 tests).

- [ ] 5.2 replay
  - scenarios: "Replaying with the stored options reproduces the digest", "Replay can show every cluster as JSON", "Replay changes the source window", "Replay writes and starts nothing", "Replay of a red run keeps its verdict and exit code", "Replay of a green run prints no delta", "A run without a record cannot be replayed", "A removed log cannot be replayed"
  - blocked-by: 5.1, 2.2
  - `src/cli/replay.ts`: loads record and log, forces `noJev`, no state, no record, exit with the record's `exit_code`.

- [ ] 5.3 stats
  - scenarios: "Three recorded runs", "stats as JSON", "Only the newest runs", "A digest larger than its raw output does not count as negative tokens", "No records", "A real run is counted"
  - blocked-by: 2.2
  - `src/cli/stats.ts`; the arithmetic is a pure function `summarize(records, last)`.

- [ ] 5.4 Docs for S4
  - scenarios: none
  - blocked-by: 5.3, 5.2
  - README (`replay`, `stats`), feature map `replay-stats.md` (new). scenarios: none (documentation).

## 6. S5 Digest input

- [ ] 6.1 digest
  - scenarios: "A compiler log with an explicit exit code", "The exit code is inferred when absent", "A TAP log from another machine", "digest reads stdin", "The log keeps the input's line numbers and can be read back", "digest as JSON", "Bad input is rejected", "A terminal on stdin is rejected"
  - blocked-by: 5.1, 2.2
  - `src/cli/digest.ts`: reader for file or stdin (`deps.stdinIsTTY`), copy to a new log, record with `source: digest`, header without `in <t>ms`, exit code rule.

- [ ] 6.2 Docs for S5
  - scenarios: none
  - blocked-by: 6.1
  - README (CI usage with `digest`), feature map `digest-input.md` (new). scenarios: none (documentation).

## 7. S7 Agent output contract

- [ ] 7.1 JSON contract, JSON Schema and ndjson
  - scenarios: "JSON of a failing run", "JSON of a passing run has no omitted count", "The committed file matches the generator", "Real envelopes validate", "The schema subcommand prints the file", "The cart as ndjson", "A pass is one line", "The format is accepted wherever json is"
  - blocked-by: 2.1
  - `schema_version`, `run_id`, `summary.omitted_clusters` in `schema.ts` and `buildEnvelope`; dev dependencies `zod-to-json-schema` and `ajv`; `pnpm run schema`; `schema/` in `package.json` `files`; `schema` subcommand; ndjson in `formatEnvelope`. Update the tests that compare a whole envelope.

- [ ] 7.2 The next line
  - scenarios: "Omitted clusters are the target", "With nothing omitted the target is the first cluster", "The printed command works", "No next line where the ladder shows raw text", "No next line on a pass or a hand-built envelope", "The ceiling holds with the line"
  - blocked-by: 7.1, 2.2
  - `run_id` in `RenderContext`/envelope, reserved by the budget in `envelope.ts` before the blocks; the README `tsc` numbers are re-measured in 7.4.

- [ ] 7.3 Rerun hints
  - scenarios: "rerun for node --test", "The rerun command really reruns that one test", "vitest, with a prefix from the command", "vitest, executed", "Regular-expression characters in a name are escaped and quoted", "A single quote in a name is escaped for the shell", "A wrapped script has no runner token", "pytest, cargo, go and eslint from fixtures", "tsc has no rerun", "The row appears on the first block only"
  - blocked-by: 7.1
  - `FailureCluster.rerun`; a `rerunFor(command, runner, failure)` function per grammar in `src/adapters/rerun.ts`; the first-block row in `envelope.ts`. Fixtures for pytest, cargo, go and eslint are the existing adapter fixtures.

- [ ] 7.4 Docs for S7 and re-measured numbers
  - scenarios: none
  - blocked-by: 7.2, 7.3
  - Re-measure the README figures that the two new lines move (the 4-failure `node --test` example, the 30-error `tsc` example, the vitest example) from a throwaway build; README (JSON contract, ndjson, `rerun`), SPEC-002 §4.1.1 (`next:` and `rerun:` in the size rule), feature map `json-envelope.md`, `failure-digest.md` (key lists and block counts). scenarios: none (documentation).

## 8. S8 Bounded memory and progress

- [ ] 8.1 LineSource and the adapters' input type
  - scenarios: "Four hundred thousand lines under a small heap", "A failure in the middle of a huge output is still found", "Small outputs are not read from disk", "Every existing digest is unchanged", "A file-backed source gives the same digest as the in-memory one", "The raw text is built only for tiny outputs", "The time cost stays bounded", "A large run"
  - blocked-by: 5.1, 7.3
  - `src/runner/line-source.ts` (memory mode up to 4 MiB, file-backed with an 8 MiB chunk cache), `capture.ts` returns the source, adapters take `LineSource`. Gate first: `pnpm run verify` passes with only type changes in the tests, then the new scenarios.

- [ ] 8.2 --progress
  - scenarios: "Heartbeats while a slow child runs", "Without the flag nothing is printed", "On a terminal the heartbeat overwrites itself", "A fast child prints no heartbeat", "Progress never goes to stdout"
  - blocked-by: 8.1, 3.1
  - `capture.ts` timer, `deps.stderrIsTTY`, `deps.now`, `DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS`.

- [ ] 8.3 Docs for S8
  - scenarios: none
  - blocked-by: 8.2
  - README (memory behavior, `--progress`), feature map `progress.md` (new). scenarios: none (documentation).

## 9. S9 Doctor and init

- [ ] 9.1 doctor and init
  - scenarios: "doctor on a vitest project", "doctor on a project with several runners", "An invalid config fails the check", "An unusable cache fails the check", "The API key is never printed", "doctor writes nothing", "init writes a new file", "init keeps an existing file"
  - blocked-by: 3.1
  - `src/cli/doctor.ts` (pure detection functions over a directory listing plus the checks), `src/cli/init.ts`.

- [ ] 9.2 Docs for S9
  - scenarios: none
  - blocked-by: 9.1
  - README (getting started with `doctor` and `init`), feature map `doctor-init.md` (new). scenarios: none (documentation).

## 10. S10 MCP server

- [ ] 10.1 SDK dependency and the server skeleton
  - scenarios: "The tool list", "Stdout carries only protocol messages", "A normal run does not load the SDK"
  - blocked-by: 2.2, 3.1
  - Install `@modelcontextprotocol/sdk`; stop and report if it needs a zod major other than 3. `src/mcp/server.ts`, lazy import in the `mcp` subcommand; the SDK client is a dev-time test dependency.

- [ ] 10.2 run_tests with the allowlist
  - scenarios: "The default allowlist is empty", "An allowed command runs and returns the digest", "A failing test run is a result, not an error", "Prefix matching is element-wise", "No shell is involved", "A working directory outside the project is refused", "The user config extends the allowlist", "A project file cannot extend the allowlist", "The timeout stops the child"
  - blocked-by: 10.1, 7.2, 4.1
  - `src/mcp/allowlist.ts` (prefix match, `cwd` realpath guard), `timeoutMs` option in `runChild` (SIGTERM, then SIGKILL after 5 s), user-config-only `mcp.allow`.

- [ ] 10.3 show_log, replay, list_runs and the client snippet
  - scenarios: "show_log returns a range", "replay returns JSON", "list_runs is newest first", "A bad reference is an error result", "The MCP client snippet"
  - blocked-by: 10.1, 5.2, 2.2
  - Thin wrappers over the CLI functions; `init --print-mcp-config`.

- [ ] 10.4 Docs for S10
  - scenarios: none
  - blocked-by: 10.3, 10.2
  - README (MCP section, the allowlist and why it is not read from a project file), feature map `mcp.md` (new). scenarios: none (documentation).

## 11. Release

- [ ] 11.1 Release 0.2.0
  - scenarios: none
  - blocked-by: 1.4, 2.3, 3.3, 4.3, 5.4, 6.2, 7.4, 8.3, 9.2, 10.4
  - `package.json` and `src/version.ts` to `0.2.0`; SPEC-002 revision row `0.2.0`, §2 scope and §5 module table; consolidate the README; update `.dotstack/features/README.md` and the `verify` skill (`verify.sh` gains no new commands; its journeys list does); run `pnpm run verify`, the acceptance script and the verify skill once. scenarios: none (release).

