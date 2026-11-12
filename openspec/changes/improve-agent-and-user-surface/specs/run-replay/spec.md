## ADDED Requirements

### Requirement: replay re-renders a stored run without running it again
`replay <run> [--format F] [--max-clusters N] [--context-lines N]` SHALL read the run's record and log, re-run the adapters on the stored lines, and print the digest with the stored `phase`, `command`, `child_exit_code`, `duration_ms` and (unless overridden by a flag) the stored options. It SHALL NOT start a process, call the network (Gear 1 is off), read or write a TDD state file, or write a new log or record. It SHALL exit with the record's `exit_code`. The status is computed from the stored phase and child exit code with no previous state, so no `delta` is printed. The same size rules apply (INV-1, INV-2, the size ladder); `--format=json` is how to see more than the compact budget allows.

#### Scenario: Replaying with the stored options reproduces the digest
- **GIVEN** the cart and a fresh home, after `-- node --test cart.test.js` whose stdout was captured
- **WHEN** `replay last` runs
- **THEN** stdout is byte-identical to the captured stdout of the original run and the exit code is `1`

#### Scenario: Replay can show every cluster as JSON
- **GIVEN** the same run
- **WHEN** `replay last --format=json --max-clusters=15` runs
- **THEN** stdout parses as JSON with `summary.total_clusters` `4` and the four cluster ids `c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a`, and the exit code is `1`

#### Scenario: Replay changes the source window
- **GIVEN** the same run
- **WHEN** `replay last --context-lines=0` runs
- **THEN** the first block shows only the line `  7 > test("discount 10% leaves 90%", ...` as its source window (no line above or below)

#### Scenario: Replay writes and starts nothing
- **GIVEN** the same run, with a snapshot of the home (file names and mtimes) and `deps.client` that fails the test if called
- **WHEN** `replay last` runs three times
- **THEN** the home is identical to the snapshot, no child process was spawned, and the stub was never called

#### Scenario: Replay of a red run keeps its verdict and exit code
- **GIVEN** the cart and a fresh home, after `--tdd-phase=red --scope-id=p1 -- node --test passing.test.js` (status `INVALID_RED`, exit `64`)
- **WHEN** `replay last` runs
- **THEN** the exit code is `64`, the header starts `[INVALID_RED | RED]`, and stderr is the INV-5 message `New test passed before implementation; expected a failing behavioral assertion.`

#### Scenario: Replay of a green run prints no delta
- **GIVEN** a red then a green run in the same scope that printed `(delta: +1 newly passing, 0 regressions)`
- **WHEN** `replay last` runs
- **THEN** the header is `[PASS | GREEN] 1 passed, 0 failed in <t>ms | log: <path>` (no delta)

#### Scenario: A run without a record cannot be replayed
- **GIVEN** a home with `logs/run_legacy1.log` and no `run_legacy1.json`
- **WHEN** `replay run_legacy1` runs
- **THEN** the exit code is `66` and stderr is `run_legacy1 has no record (written by an older version); replay needs one`

#### Scenario: A removed log cannot be replayed
- **GIVEN** a record whose log file was deleted
- **WHEN** `replay <run>` runs
- **THEN** the exit code is `66` and stderr is `log of <run> was removed`
