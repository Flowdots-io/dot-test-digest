## ADDED Requirements

### Requirement: A closed stdout never changes the exit code or prints a stack trace
When the process reading `dot-test-digest`'s stdout has closed it before the digest is written, the tool SHALL still finish, exit with the code it would have exited with (INV-3: the child's code, or `64` for an invalid TDD verdict), write the raw log, and print nothing on stderr about the closed pipe.

#### Scenario: A reader that closes stdout early does not change a failing child's code
- **GIVEN** the tool is spawned as `node dist/index.js --no-jev -- sh -c "sleep 1; exit 7"` with `stdio: pipe`
- **WHEN** the parent destroys the read end of the child's stdout immediately after the spawn and waits for the exit
- **THEN** the exit code is `7`
- **AND** stderr is empty (no `EPIPE`, no `Error:` line, no stack frame)
- **AND** the fresh home contains one `logs/run_*.log`

#### Scenario: A reader that closes stdout early does not change a passing run
- **GIVEN** the same spawn with the command `sh -c "sleep 1; exit 0"`
- **WHEN** the parent destroys the read end of stdout immediately and waits for the exit
- **THEN** the exit code is `0` and stderr is empty

### Requirement: A green or refactor run that recognized no passing test is INVALID_GREEN
With `--tdd-phase=green` or `--tdd-phase=refactor`, when the child exits `0` and the grammar counted `passed = 0` and `failed = 0` (skipped tests do not count), the tool SHALL report status `INVALID_GREEN`, exit `64`, write the message `Command exited 0 but no passing test was recognized; a green run must run at least one test (pass --allow-no-tests to accept it).` on stderr, and leave the TDD state file unchanged. `--allow-no-tests` SHALL restore the previous behavior (status `PASS`, exit `0`). The header SHALL read `[INVALID_GREEN | GREEN]` or `[INVALID_GREEN | REFACTOR]`. A child that fails keeps its existing verdicts (`FAIL`, `REGRESSION_DETECTED`) and exit code. The `red` and `none` phases are unchanged.

#### Scenario: A command that runs nothing is not a green
- **GIVEN** the cart and a fresh home
- **WHEN** `--tdd-phase=green --scope-id=g1 -- node -e "process.exit(0)"` runs
- **THEN** the exit code is `64`
- **AND** the header matches `^\[INVALID_GREEN \| GREEN\] 0 passed, 0 failed in <t>ms \| log: \S+\.log$`
- **AND** stderr is exactly the message above followed by a newline
- **AND** `state-g1.json` does not exist

#### Scenario: Refactor needs a passing test too
- **GIVEN** the cart and a fresh home
- **WHEN** `--tdd-phase=refactor --scope-id=g2 -- node -e "process.exit(0)"` runs
- **THEN** the exit code is `64` and the header starts `[INVALID_GREEN | REFACTOR]`

#### Scenario: A run that only skips tests is not a green
- **GIVEN** the cart with a file `skip.test.js` containing `import test from "node:test"; test("s", { skip: true }, () => {});`
- **WHEN** `--tdd-phase=green --scope-id=g3 -- node --test skip.test.js` runs
- **THEN** the exit code is `64` and the status is `INVALID_GREEN`

#### Scenario: A real green is unchanged
- **GIVEN** the cart and a fresh home
- **WHEN** `--tdd-phase=green --scope-id=g4 -- node --test passing.test.js` runs
- **THEN** the exit code is `0` and the header matches `^\[PASS \| GREEN\] 1 passed, 0 failed in <t>ms \| log: \S+\.log$`

#### Scenario: --allow-no-tests accepts an empty green
- **GIVEN** the cart and a fresh home
- **WHEN** `--tdd-phase=green --allow-no-tests --scope-id=g5 -- node -e "process.exit(0)"` runs
- **THEN** the exit code is `0` and the header matches `^\[PASS \| GREEN\] exit 0 in <t>ms \| log: \S+\.log$` (see the no-grammar pass line below)

#### Scenario: The JSON envelope carries the new status
- **GIVEN** the cart and a fresh home
- **WHEN** `--format=json --tdd-phase=green --scope-id=g6 -- node -e "process.exit(0)"` runs
- **THEN** stdout parses as JSON with `status` `"INVALID_GREEN"`, `tdd_phase` `"green"` and `exit_code` `64`

#### Scenario: Red and none are unchanged
- **GIVEN** the cart and a fresh home
- **WHEN** `--tdd-phase=red -- node --test passing.test.js` runs, and `--tdd-phase=none -- node -e "process.exit(0)"` runs
- **THEN** the first exits `64` with status `INVALID_RED`, and the second exits `0` with a header starting `[PASS]`

### Requirement: Skipped and warning counts appear in the header when nonzero
The `compact-md` header of every status SHALL show `, <N> skipped` after the last pass or fail count when `summary.skipped > 0`, and `, <N> warnings` after that when `summary.warnings > 0`. Neither segment is printed when its count is `0`. `summary.skipped` counts skipped and todo tests. `summary.warnings` is a new field, present in the JSON only when greater than `0`, and is where the `tsc-eslint` grammar reports warnings (it no longer writes them to `skipped`). The 160-byte pass-line ceiling (INV-1) still applies and is applied with these segments included.

#### Scenario: Skipped and todo tests are shown on a pass
- **GIVEN** the cart with `sk.test.js` = `import test from "node:test"; test("a", () => {}); test("b", { skip: true }, () => {}); test("c", { todo: true }, () => {});`
- **WHEN** `-- node --test sk.test.js` runs
- **THEN** the exit code is `0` and the header matches `^\[PASS\] 1 passed, 0 failed, 2 skipped in <t>ms \| log: \S+\.log$`

#### Scenario: Skipped tests are shown on a failure
- **GIVEN** the cart with `f.test.js` = a passing test `a`, a skipped test `b` and a test `c` that throws `new Error("x")`
- **WHEN** `-- node --test f.test.js` runs
- **THEN** the header matches `^\[FAIL\] 1 failed, 1 passed, 1 skipped in <t>ms \| 1 cluster \| log: \S+\.log$`

#### Scenario: A run with no skipped test is unchanged
- **GIVEN** the cart
- **WHEN** `-- node --test passing.test.js` runs
- **THEN** the header matches `^\[PASS\] 1 passed, 0 failed in <t>ms \| log: \S+\.log$`

#### Scenario: eslint warnings are warnings, not skipped tests
- **GIVEN** a file `lint.txt` of three lines `  3:5  warning  'x' is assigned a value but never used  no-unused-vars` after a first line `/abs/src/a.ts` (three diagnostics, so the grammar's detection score is 3)
- **WHEN** `-- sh -c "cat lint.txt; exit 0"` runs, and again with `--format=json`
- **THEN** the exit code is `0`, the header matches `^\[PASS\] 0 passed, 0 failed, 3 warnings in <t>ms \| log: \S+\.log$`, and the JSON `summary` is `{ "passed": 0, "failed": 0, "skipped": 0, "warnings": 3, "total_clusters": 0 }`

#### Scenario: A long pass line still fits the ceiling
- **GIVEN** a fresh home whose path is 120 characters long and a run with `1 passed`, `2 skipped` and `3 warnings`
- **WHEN** the pass line is rendered
- **THEN** it is at most 160 bytes including its newline (the log path is cut with `...` first)

### Requirement: An exit-0 run no grammar recognized prints a count-free pass line
When the child exits `0`, no Gear 0 grammar matched its output, and the phase is `none` or `refactor` or `green` with `--allow-no-tests`, the pass line SHALL read `[PASS] exit 0 in <t>ms | log: <path>` (with ` | <PHASE>` after `PASS` when a phase is set), not `0 passed, 0 failed`. A run that a grammar matched keeps its counts even when they are zero. `--format=json` is unchanged.

#### Scenario: A command with no test output
- **GIVEN** the cart
- **WHEN** `-- sh -c "echo hi"` runs
- **THEN** the exit code is `0` and the header matches `^\[PASS\] exit 0 in <t>ms \| log: \S+\.log$`

#### Scenario: A grammar that found zero tests keeps its counts
- **GIVEN** the cart with an empty file `empty.test.js`
- **WHEN** `-- node --test empty.test.js` runs
- **THEN** the header matches `^\[PASS\] 0 passed, 0 failed in <t>ms \| log: \S+\.log$`

#### Scenario: The JSON of an unrecognized run is unchanged
- **GIVEN** the cart
- **WHEN** `--format=json -- sh -c "echo hi"` runs
- **THEN** `summary` is `{ "passed": 0, "failed": 0, "skipped": 0, "total_clusters": 0 }` and `execution_gear` is `"GEAR_0_HEURISTIC_FALLBACK"`
