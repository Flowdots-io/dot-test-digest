## ADDED Requirements

### Requirement: Each run prunes old runs and state files
After a run has printed its digest, the tool SHALL prune the cache directory: it keeps the newest 50 runs (a run is a `.log` with its `.json`), deletes among the others those whose `created_at` is more than 14 days old, and deletes `state-*.json` files not modified for more than 90 days. It SHALL NOT delete the current run, any file modified in the last hour, or the state file of the current scope. A log without a record counts as a run whose `created_at` is the log's mtime; a record without a log is deleted. At most 200 files are deleted per run. A failure while pruning SHALL NOT change the exit code and SHALL print `dot-test-digest: could not prune the cache: <message>` on stderr. `DOT_TEST_DIGEST_PRUNE=0` disables the automatic prune.

#### Scenario: Old runs beyond the newest 50 are removed
- **GIVEN** a home with 60 run pairs whose `created_at` and file mtimes are 20 days ago (run `run_old001` to `run_old060`, oldest first, one day apart in the last minute digit order so they sort by number)
- **WHEN** `-- node --test passing.test.js` runs
- **THEN** the home holds 50 runs: the new one and the 49 newest of the old ones (`run_old012` to `run_old060`)
- **AND** the exit code is `0` and stderr is empty

#### Scenario: Recent runs are kept even beyond 50
- **GIVEN** a home with 60 run pairs created 1 day ago
- **WHEN** a run completes
- **THEN** the home holds 61 runs

#### Scenario: Fewer than 50 runs are never pruned
- **GIVEN** a home with 30 run pairs created 100 days ago
- **WHEN** a run completes
- **THEN** the home holds 31 runs

#### Scenario: A log without a record is pruned by its mtime
- **GIVEN** a home with 55 recent run pairs and 3 `.log` files without a record, whose mtimes are 30 days ago
- **WHEN** a run completes
- **THEN** the 3 legacy logs are gone and the 55 recent pairs remain

#### Scenario: Files modified in the last hour are never deleted
- **GIVEN** a home with 60 run pairs whose `created_at` is 20 days ago but whose mtimes are 10 minutes ago
- **WHEN** a run completes
- **THEN** all 60 pairs remain

#### Scenario: Old state files go, the current one stays
- **GIVEN** a home with `state-aaa.json` (mtime 100 days ago), `state-bbb.json` (mtime 10 days ago) and `state-cur.json` (mtime 100 days ago)
- **WHEN** `--tdd-phase=red --scope-id=cur -- node --test cart.test.js` runs
- **THEN** `state-aaa.json` is gone and `state-bbb.json` remains; `state-cur.json` exists and was rewritten by the run

#### Scenario: The automatic prune can be switched off
- **GIVEN** the 60-old-runs home of the first scenario and `DOT_TEST_DIGEST_PRUNE=0`
- **WHEN** a run completes
- **THEN** the home holds 61 runs

#### Scenario: A prune failure keeps the exit code
- **GIVEN** `main` is called with `deps.prune` replaced by a function that throws `Error("locked")`
- **WHEN** `-- node --test cart.test.js` runs
- **THEN** the exit code is `1` and stderr is `dot-test-digest: could not prune the cache: locked`

### Requirement: gc prunes on demand and reports what it did
`gc [--keep N] [--max-age-days D] [--state-max-age-days D] [--dry-run]` SHALL apply the pruning rule with the given values (defaults 50, 14, 90), print `removed <R> runs (<S> state files), kept <K> runs` and exit `0`. With `--dry-run` it SHALL delete nothing and print `would remove <R> runs (<S> state files), keeping <K> runs`. A non-integer or negative value SHALL exit `64` with `<flag> must be a non-negative integer, got <value>`. `gc` on a cache that does not exist SHALL print `removed 0 runs (0 state files), kept 0 runs` and exit `0`. The one-hour protection applies to `gc` as well.

#### Scenario: gc with defaults on the 60-old-runs home
- **GIVEN** the home of the first scenario above (without running a digest)
- **WHEN** `gc` runs
- **THEN** stdout is `removed 10 runs (0 state files), kept 50 runs` and the home holds 50 runs

#### Scenario: gc with stricter numbers
- **GIVEN** a home with 60 run pairs created 5 days ago (mtimes 5 days ago)
- **WHEN** `gc --keep 10 --max-age-days 2` runs
- **THEN** stdout is `removed 50 runs (0 state files), kept 10 runs`

#### Scenario: dry-run deletes nothing
- **GIVEN** the 60-old-runs home
- **WHEN** `gc --dry-run` runs
- **THEN** stdout is `would remove 10 runs (0 state files), keeping 50 runs` and the home still holds 60 runs

#### Scenario: Bad values are usage errors
- **GIVEN** any home
- **WHEN** `gc --keep -1` runs, and `gc --max-age-days abc` runs
- **THEN** both exit `64`, with `--keep must be a non-negative integer, got -1` and `--max-age-days must be a non-negative integer, got abc`

#### Scenario: gc on a missing cache
- **GIVEN** `DOT_TEST_DIGEST_HOME` points to a directory that does not exist
- **WHEN** `gc` runs
- **THEN** stdout is `removed 0 runs (0 state files), kept 0 runs`, the exit code is `0`, and the directory was not created
