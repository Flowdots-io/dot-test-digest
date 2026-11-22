## ADDED Requirements

### Requirement: digest turns an existing log into a digest
`digest <file|-> [--exit-code N] [--format F] [--max-clusters N] [--context-lines N] [--no-jev]` SHALL read the lines of the file (or of stdin for `-`), copy them verbatim to a new log under the cache (so line numbers in `raw:` pointers are the input's line numbers), run the same pipeline as a live run (adapters, clustering, size rule, Gear 1 triage when allowed), write a run record with `source` `"digest"`, `command` `[]` and `input` set to the file path or `"-"`, print the digest, and exit with the code given by `--exit-code N` (0 to 255) or, when absent, `1` if the pipeline found at least one failure and `0` otherwise. The header SHALL omit the `in <t>ms` segment (no process was timed). `--tdd-phase` is not accepted. An empty input SHALL exit `64` with `input is empty`; a missing or unreadable file SHALL exit `66` with `cannot read <path>: <reason>`; `-` with a terminal as stdin SHALL exit `64` with `no input: pipe a log into "digest -"`; `--exit-code` outside 0 to 255 or not an integer SHALL exit `64` with `--exit-code must be an integer between 0 and 255, got <value>`; `--tdd-phase` SHALL exit `64` with `--tdd-phase is not supported by digest`. Source windows are read from the working directory and are omitted when the file does not exist there.

#### Scenario: A compiler log with an explicit exit code
- **GIVEN** a fresh home and the file `tests/fixtures/tsc-small/tsc.log` (5 lines, 419 bytes)
- **WHEN** `digest tests/fixtures/tsc-small/tsc.log --exit-code 2` runs
- **THEN** the exit code is `2`
- **AND** the header matches `^\[FAIL\] 5 failed, 0 passed \| 5 clusters \| log: \S+\.log$` (no `in <t>ms`)
- **AND** the rest of stdout is the 5 raw lines unchanged (size level 5, as for a live run)

#### Scenario: The exit code is inferred when absent
- **GIVEN** the same file, and a file `ok.log` containing the single line `all good`
- **WHEN** `digest tests/fixtures/tsc-small/tsc.log` runs, and `digest ok.log` runs
- **THEN** the first exits `1` and the second exits `0` with a header matching `^\[PASS\] exit 0 \| log: \S+\.log$`

#### Scenario: A TAP log from another machine
- **GIVEN** a fresh home, the cart not present, and `tests/fixtures/logs/node-tap-cart.log` (120 lines, paths under `__ROOT__`)
- **WHEN** `digest tests/fixtures/logs/node-tap-cart.log` runs
- **THEN** the exit code is `1`, the header matches `^\[FAIL\] 4 failed, 2 passed \| \d clusters \| log: \S+\.log$`, all four failures appear (as blocks or listed lines), and no block has a source window (the files do not exist here)

#### Scenario: digest reads stdin
- **GIVEN** a fresh home, and a spawned process whose stdin is the content of `tests/fixtures/logs/node-tap-cart.log`
- **WHEN** `digest -` runs
- **THEN** the exit code and stdout equal those of `digest tests/fixtures/logs/node-tap-cart.log` except for the log path and run id

#### Scenario: The log keeps the input's line numbers and can be read back
- **GIVEN** a fresh home, after `digest tests/fixtures/logs/node-tap-cart.log`
- **WHEN** `show last L15-L17` runs
- **THEN** stdout is lines 15 to 17 of `tests/fixtures/logs/node-tap-cart.log`
- **AND** the record has `source` `"digest"`, `command` `[]` and `input` `"tests/fixtures/logs/node-tap-cart.log"`

#### Scenario: digest as JSON
- **GIVEN** the same
- **WHEN** `digest tests/fixtures/logs/node-tap-cart.log --format=json` runs
- **THEN** stdout parses as JSON with `status` `"FAIL"`, `exit_code` `1` and `duration_ms` `0`

#### Scenario: Bad input is rejected
- **GIVEN** a fresh home and an empty file `empty.log`
- **WHEN** `digest empty.log` runs, `digest missing.log` runs, `digest ok.log --exit-code 300` runs, and `digest ok.log --tdd-phase=red` runs
- **THEN** the exits are `64` (`input is empty`), `66` (`cannot read missing.log: ENOENT`), `64` (`--exit-code must be an integer between 0 and 255, got 300`) and `64` (`--tdd-phase is not supported by digest`)

#### Scenario: A terminal on stdin is rejected
- **GIVEN** `main` is called with `deps.stdinIsTTY` `true`
- **WHEN** `digest -` runs
- **THEN** the exit code is `64` and stderr is `no input: pipe a log into "digest -"`
