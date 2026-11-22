## ADDED Requirements

### Requirement: --progress prints a heartbeat on stderr while the child runs
With `--progress` (or `progress: true`, or `DOT_TEST_DIGEST_PROGRESS=1`), the tool SHALL print `dot-test-digest: running... <N> lines, <S>s` on stderr every 10 seconds (the interval is `DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS` when set, for tests), where `N` is the number of lines written to the log so far and `S` the elapsed seconds with one decimal. When stderr is a terminal, each heartbeat overwrites the previous one (carriage return) and the last is cleared before the digest is printed; otherwise each heartbeat is its own line. Nothing is written to stdout, the exit code and the digest are unchanged, and without the flag stderr carries nothing from this feature.

#### Scenario: Heartbeats while a slow child runs
- **GIVEN** the tool spawned with `DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS=300` as `node dist/index.js --no-jev --progress -- sh -c "echo a; sleep 1.2; echo b"` with stderr as a pipe
- **WHEN** it exits
- **THEN** stderr has at least 2 lines matching `^dot-test-digest: running\.\.\. \d+ lines, \d+\.\ds$`, each with a line count of at least 1
- **AND** stdout is exactly the normal pass line and the exit code is `0`

#### Scenario: Without the flag nothing is printed
- **GIVEN** the same spawn without `--progress`
- **WHEN** it exits
- **THEN** stderr is empty

#### Scenario: On a terminal the heartbeat overwrites itself
- **GIVEN** `main` is called with `deps.stderrIsTTY` `true`, a fake clock and `--progress`
- **WHEN** a child that runs for 25 fake seconds completes
- **THEN** stderr received two heartbeats each starting with `\r`, and a final clearing sequence `\r\u001b[K` before the digest

#### Scenario: A fast child prints no heartbeat
- **GIVEN** `--progress` and the default 10-second interval
- **WHEN** `-- node --test passing.test.js` runs (under a second)
- **THEN** stderr is empty

#### Scenario: Progress never goes to stdout
- **GIVEN** `--progress --format=json` and the 300 ms interval with a 1.2 s child
- **WHEN** it exits
- **THEN** stdout parses as one JSON document
