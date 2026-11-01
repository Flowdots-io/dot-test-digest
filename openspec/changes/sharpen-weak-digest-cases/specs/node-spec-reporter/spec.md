## ADDED Requirements

### Requirement: The js-test adapter recognises node's spec reporter
A stream that contains node's spec-reporter summary (`ℹ tests N`, `ℹ pass N`, `ℹ fail N`) SHALL be selected by the js-test adapter (Gear 0 grammar, so a failing run is `FAIL`, not `BUILD_ERROR`). Counts SHALL be read as in node TAP: `ℹ pass N` is passed, `ℹ fail N` plus `ℹ cancelled N` is failed, `ℹ skipped N` plus `ℹ todo N` is skipped. Failures SHALL come only from the `✖ failing tests:` section, one per entry, where an entry is a `test at <file>:<line>:<col>` line, a `✖ <name> (<duration>)` line, and the indented lines up to the next blank line that precedes another `test at` line or the end of the stream:
- the test name is `<name>` with the parenthesised duration removed;
- the test file is `<file>`, made relative to the working directory;
- the message is the indented lines before the first `at ` frame, non-blank, trimmed and joined with one space, with a ` [CODE]` tag after the error name removed (`AssertionError [ERR_ASSERTION]: ...` becomes `AssertionError: ...`), and a quoted single-line message unquoted;
- the frames are the `at ` lines, with `file://` URLs replaced by filesystem paths;
- the diff is `{ expected: <expected: value>, received: <actual: value> }` from the trailing `{ ... }` property block, without the trailing comma;
- the raw-log range runs from the `test at` line to the entry's last non-blank line.

Tree rows (`✔`/`✖`/`▶` before the summary), including a failed suite row such as `✖ cart (31.4ms)`, MUST NOT create failures.

#### Scenario: The cart run with the spec reporter is parsed, not reported as BUILD_ERROR
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=spec cart.test.js` runs
- **THEN** the exit code is `1`, `status` is `"FAIL"`, `execution_gear` is `"GEAR_0_GRAMMAR"`, `summary` is `{ "passed": 2, "failed": 4, "skipped": 0, "total_clusters": 4 }`, and no cluster has `error_kind` `UNSTRUCTURED_BUILD_ERROR`

#### Scenario: The spec reporter yields the same clusters as the TAP reporter
- **GIVEN** the same working directory
- **WHEN** the cart run is made once with `--test-reporter=spec` and once with `--test-reporter=tap`, both with `--format=json`
- **THEN** both envelopes list the cluster ids `c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a` in that order, with equal `error_kind`, `top_frame`, `message` and `sample_tests` per id
- **AND** in the spec run the diffs are `{ "expected": "900", "received": "0" }`, `{ "expected": "1634", "received": "0" }`, `{ "expected": "0", "received": "-16335" }` and none for `c_53a8182a`

#### Scenario: The compact-md digest of the spec run names the failures
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev -- node --test --test-reporter=spec cart.test.js` runs
- **THEN** the first stdout line starts with `[FAIL] 4 failed, 2 passed in `, stdout contains `ASSERTION_FAILURE x1 cart.test.js:7:46` and is at most 2,400 bytes, and stdout contains neither `BUILD_ERROR`, `UNSTRUCTURED_BUILD_ERROR` nor `file://`

#### Scenario: A recorded spec log parses at the adapter seam
- **GIVEN** `tests/fixtures/logs/node-spec-cart.log`, the README run's spec output (`/tmp/dtd-work/nodetest/raw-spec.txt`, 3,396 bytes, 91 lines) with every `/tmp/dtd-work/nodetest` replaced by `__ROOT__`, and the test replaces `__ROOT__` with `<cwd>/tests/fixtures/node-cart`
- **WHEN** `runGear0` parses its lines
- **THEN** the adapter is `js-test`, counts are `{ passed: 2, failed: 4, skipped: 0 }`, and there are 4 failures named `discount 10% leaves 90%`, `total with 10% off`, `total with 100% off is free`, `first of an empty cart is undefined`, with test file `cart.test.js` and raw ranges `18-37`, `39-58`, `60-79`, `81-91`

#### Scenario: A passing spec run is one line with the real count
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev -- node --test --test-reporter=spec passing.test.js` runs
- **THEN** the exit code is `0` and stdout is one line of at most 160 bytes starting with `[PASS] 1 passed, 0 failed in `

#### Scenario: Nested suite and timeout under the spec reporter
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=spec suite.test.js` runs
- **THEN** `summary` has `passed: 1`, `failed: 3`, `skipped: 0`, the union of `sample_tests` is exactly `discount 10% leaves 90%`, `names match`, `slow`, and the `slow` cluster is `TIMEOUT_OR_CONN_REFUSED` with message `test timed out after 20ms`

### Requirement: A file-level spec-reporter failure carries the error its subprocess printed
When the failing-tests section reports a whole test file (`✖ <file> (<duration>)` whose message is `'test failed'`), the adapter SHALL use as that failure's message the subprocess error line that node printed outside the failing-tests section (on stderr, which the wrapper captures into the same stream): the first line matching `<Name>Error[ [CODE]]: <text>` or `Error[ [CODE]]: <text>` in a contiguous non-blank block that mentions the failing file's absolute path or `file://` URL, else, when the run has exactly one file-level failure, the first such line in the stream; the ` [CODE]` tag is removed. Those subprocess lines MUST NOT create failures of their own.

#### Scenario: A missing module under the spec reporter is one SYNTAX_IMPORT_ERROR failure
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=spec missing-module.test.js` runs
- **THEN** `status` is `"FAIL"`, `summary.failed` is `1`, `total_clusters` is `1`, and the cluster has `error_kind` `SYNTAX_IMPORT_ERROR`, `sample_tests` `["missing-module.test.js"]` and a message that starts with `Error: Cannot find module '`

#### Scenario: A missing export under the spec reporter is a RUNTIME_EXCEPTION failure
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=spec missing-export.test.js` runs
- **THEN** `total_clusters` is `1` and the cluster has `error_kind` `RUNTIME_EXCEPTION` and message `SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'`

### Requirement: Red-phase verdicts and exit codes for node --test with the spec reporter
With `node --test --test-reporter=spec`, the TDD gate SHALL give the INV-5 verdicts of SPEC-002 §4.3 and keep exit codes transparent outside an `INVALID_RED` block (INV-3). Each scenario runs in a fresh copy of `tests/fixtures/node-cart/` with `DOT_TEST_DIGEST_HOME` set to a temporary directory.

#### Scenario: Assertion failures are VALID_RED with the real counts
- **WHEN** `dot-test-digest --no-jev --tdd-phase=red --scope-id=spec-red -- node --test --test-reporter=spec cart.test.js` runs
- **THEN** the exit code is `0`, stdout is one line of at most 160 bytes starting with `[VALID_RED | RED] 2 passed, 4 failed in ` (v0.1.2 printed `0 passed, 0 failed`), and `state-spec-red.json` has the same four `cart.test.js::<name>` baseline ids as the TAP run

#### Scenario: A missing module is INVALID_RED with exit 64 and the syntax message
- **WHEN** `dot-test-digest --no-jev --tdd-phase=red -- node --test --test-reporter=spec missing-module.test.js` runs
- **THEN** the exit code is `64`, stdout contains `INVALID_RED` and `SYNTAX_IMPORT_ERROR`, and stderr contains `Test failed due to syntax or unresolved module import rather than a behavioral assertion.`

#### Scenario: A missing export is VALID_RED with exit 0 under the spec reporter
- **WHEN** `dot-test-digest --no-jev --tdd-phase=red -- node --test --test-reporter=spec missing-export.test.js` runs
- **THEN** the exit code is `0` and stdout starts with `[VALID_RED | RED]` (v0.1.2 returned `INVALID_RED` and exit `64` here, contradicting INV-5)

#### Scenario: A test that already passes is INVALID_RED with exit 64 under the spec reporter
- **WHEN** `dot-test-digest --no-jev --tdd-phase=red -- node --test --test-reporter=spec passing.test.js` runs
- **THEN** the exit code is `64`, stdout contains `INVALID_RED`, and stderr contains `New test passed before implementation; expected a failing behavioral assertion.`

#### Scenario: Without a TDD phase the child's exit code passes through under the spec reporter
- **WHEN** `dot-test-digest --no-jev -- node --test --test-reporter=spec cart.test.js` runs
- **THEN** the exit code is `1`, equal to that of `node --test --test-reporter=spec cart.test.js` run directly
