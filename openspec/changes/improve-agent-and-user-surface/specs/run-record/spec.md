## ADDED Requirements

### Requirement: Every run writes a record beside its log
Each run (a wrapped command, and later `digest`) SHALL write `logs/<run>.json` next to `logs/<run>.log`, atomically (a unique temporary file, then a rename), after the digest has been rendered. The record SHALL be a JSON object with these keys: `schema` (`1`), `run_id`, `version` (the tool version), `created_at` (ISO 8601 UTC), `source` (`"run"`), `cwd`, `command` (the argv after `--`), `exit_code` (what the tool returned), `child_exit_code`, `signal`, `duration_ms`, `phase`, `scope_id`, `status`, `execution_gear`, `format`, `options` (`{ max_clusters, context_lines, no_jev, retry_flakes }`), `summary` (`{ passed, failed, skipped, warnings, total_clusters }`), `raw_lines`, `raw_bytes`, `digest_bytes` and `clusters` (every cluster, kept and omitted, as `{ cluster_id, error_kind, affected_count, raw_log_lines }`). `raw_lines` and `raw_bytes` describe the log file; `digest_bytes` is the number of bytes written to stdout.

#### Scenario: A failing node run leaves a complete record
- **GIVEN** the cart and a fresh home
- **WHEN** `-- node --test cart.test.js` runs and exits `1`
- **THEN** `logs/` holds exactly one `<run>.log` and one `<run>.json` with the same run id and no `*.tmp` file
- **AND** the record has `schema` `1`, `source` `"run"`, `command` `["node","--test","cart.test.js"]`, `cwd` equal to the cart path, `exit_code` `1`, `child_exit_code` `1`, `signal` `null`, `phase` `"none"`, `status` `"FAIL"`, `summary.passed` `2`, `summary.failed` `4`
- **AND** `raw_lines` equals the number of lines of the log, `raw_bytes` equals its size in bytes, `digest_bytes` equals the bytes captured from stdout
- **AND** `clusters` has 4 entries whose ids are `c_9721831d`, `c_6edce10a`, `c_fdff652c` and `c_53a8182a` (in any order) and whose `raw_log_lines` match `^L\d+-L\d+$`

#### Scenario: The record keeps the phase, scope and options
- **GIVEN** the cart and a fresh home
- **WHEN** `--tdd-phase=red --scope-id=r1 --max-clusters=2 --context-lines=0 -- node --test cart.test.js` runs
- **THEN** the record has `phase` `"red"`, `scope_id` `"r1"`, `status` `"VALID_RED"`, `exit_code` `0`, `child_exit_code` `1` and `options` `{ "max_clusters": 2, "context_lines": 0, "no_jev": true, "retry_flakes": false }`

#### Scenario: A killed child is recorded with its signal
- **GIVEN** a fresh home
- **WHEN** `-- sh -c "kill -TERM $$"` runs
- **THEN** the record has `signal` `"SIGTERM"`, `exit_code` `143` and `child_exit_code` `143`

#### Scenario: A failure to write the record never changes the exit code
- **GIVEN** `main` is called with `deps.writeRecord` replaced by a function that throws `Error("disk full")`
- **WHEN** `-- node --test cart.test.js` runs
- **THEN** the exit code is `1` (the child's), stdout is the normal digest, and stderr is exactly `dot-test-digest: could not write the run record: disk full` followed by a newline

### Requirement: A run reference resolves to one run
Subcommands that take `<run>` SHALL accept `last`, a full run id, or a prefix of a run id of at least 6 characters. `last` is the record with the greatest `created_at` (ties broken by the greater run id) whose `cwd` equals the current working directory. A reference that matches no run SHALL exit `66` with `no such run: <ref>` (for `last`: `no run recorded for this directory`); a prefix that matches more than one run SHALL exit `64` with `ambiguous run reference "<ref>": <id1>, <id2>[, ...]` (ids sorted, at most 5 listed); a prefix shorter than 6 characters SHALL exit `64` with `run reference "<ref>" is too short (6 characters minimum)`.

#### Scenario: last is the newest run of this directory
- **GIVEN** a fresh home with three records: `run_aaaaaa1` (cwd `/p/a`, `created_at` `2026-11-01T10:00:00Z`), `run_bbbbbb2` (cwd `/p/b`, `2026-11-01T11:00:00Z`), `run_cccccc3` (cwd `/p/a`, `2026-11-01T09:00:00Z`), each with a log of one line, and the working directory is `/p/a`
- **WHEN** `show last` runs
- **THEN** the output is the one line of `run_aaaaaa1`'s log

#### Scenario: A unique prefix resolves
- **GIVEN** the same home, working directory `/p/a`
- **WHEN** `show run_aaaaaa` runs
- **THEN** the output is the one line of `run_aaaaaa1`'s log

#### Scenario: An ambiguous prefix is a usage error
- **GIVEN** the same home plus a record `run_aaaaaa9` in `/p/a`
- **WHEN** `show run_aaaaaa` runs
- **THEN** the exit code is `64` and stderr is `ambiguous run reference "run_aaaaaa": run_aaaaaa1, run_aaaaaa9`

#### Scenario: Unknown references exit 66
- **GIVEN** the same home, working directory `/p/c` (no run there)
- **WHEN** `show last` runs, and `show run_zzzzzz` runs
- **THEN** both exit `66`, with stderr `no run recorded for this directory` and `no such run: run_zzzzzz`

#### Scenario: A short prefix is a usage error
- **GIVEN** any home
- **WHEN** `show run_a` runs
- **THEN** the exit code is `64` and stderr is `run reference "run_a" is too short (6 characters minimum)`

### Requirement: A subcommand is a bare first word, and the wrapper grammar is unchanged
If the first argument is one of `show`, `replay`, `gc`, `stats`, `digest`, `doctor`, `init`, `mcp`, `config`, `schema`, that subcommand SHALL run. Any other first argument that does not start with `-` SHALL still fail with `missing -- delimiter before "<word>": dot-test-digest [flags] -- <command>` (exit `64`). A subcommand name after `--` SHALL be run as the wrapped program. `--help` SHALL list the subcommands.

#### Scenario: show dispatches
- **GIVEN** a fresh home with one run of `-- sh -c "echo hi"`
- **WHEN** `show last` runs
- **THEN** the exit code is `0` and stdout contains the line `hi`

#### Scenario: Other bare words keep the old error
- **GIVEN** any home
- **WHEN** `bogus -- true` runs, and `--no-jev show last` runs
- **THEN** both exit `64`, the first with `missing -- delimiter before "bogus": dot-test-digest [flags] -- <command>` and the second with `missing -- delimiter before "show": dot-test-digest [flags] -- <command>`

#### Scenario: A program called show is still a program
- **GIVEN** a fresh home
- **WHEN** `-- show` runs
- **THEN** the exit code is `127` and stderr is `dot-test-digest: spawn show ENOENT`

#### Scenario: The help lists the subcommands
- **GIVEN** any home
- **WHEN** `--help` runs
- **THEN** stdout contains the lines `  show <run> [range|cluster_id]`, `  replay <run>`, `  digest <file|->`, `  gc`, `  stats`, `  doctor`, `  init`, `  mcp`, `  config` and `  schema`

### Requirement: show prints the raw log lines of a run, a range or a cluster
`show <run> [<selector>]` SHALL print the lines of the run's log exactly as stored, each followed by `\n`. A selector is `L<a>-L<b>`, `<a>-<b>`, `L<a>` (one line), or a cluster id of the run (its `raw_log_lines` range, from the record). A range partly beyond the end SHALL be clamped; a range that starts beyond the last line SHALL exit `64` with `the log has <N> lines`; `a > b` SHALL exit `64` with `invalid range: <selector>`; an unknown cluster id SHALL exit `64` with `no cluster <id> in <run>`. `--numbers` prefixes each line with its number and a tab. `--record` prints the record file instead. A run whose log or record was deleted SHALL exit `66` with `log of <run> was removed`.

#### Scenario: A range of the cart log
- **GIVEN** the cart and a fresh home, after `-- node --test cart.test.js`
- **WHEN** `show last L15-L17` runs
- **THEN** stdout is exactly lines 15 to 17 of the log, the first being `not ok 3 - discount 10% leaves 90%`, and the exit code is `0`

#### Scenario: A cluster id selects its range
- **GIVEN** the same run
- **WHEN** `show last c_9721831d` runs
- **THEN** stdout is lines 15 to 39 of the log (the `raw:` range the digest printed for that cluster)

#### Scenario: Numbers are prefixed
- **GIVEN** the same run
- **WHEN** `show last L15-L16 --numbers` runs
- **THEN** stdout is `15\tnot ok 3 - discount 10% leaves 90%` and `16\t  ---`, each line ending in `\n`

#### Scenario: A range is clamped, a bad range is rejected
- **GIVEN** a log of 120 lines
- **WHEN** `show last L110-L500` runs, `show last L500-L600` runs, and `show last L9-L3` runs
- **THEN** the first prints lines 110 to 120 and exits `0`; the second exits `64` with `the log has 120 lines`; the third exits `64` with `invalid range: L9-L3`

#### Scenario: An unknown cluster id is rejected
- **GIVEN** the cart run above
- **WHEN** `show last c_00000000` runs
- **THEN** the exit code is `64` and stderr is `no cluster c_00000000 in <run>`

#### Scenario: The record can be printed
- **GIVEN** the cart run above
- **WHEN** `show last --record` runs
- **THEN** stdout is the content of `logs/<run>.json`

#### Scenario: A pruned run says so
- **GIVEN** a record whose log file was deleted
- **WHEN** `show <run>` runs
- **THEN** the exit code is `66` and stderr is `log of <run> was removed`
