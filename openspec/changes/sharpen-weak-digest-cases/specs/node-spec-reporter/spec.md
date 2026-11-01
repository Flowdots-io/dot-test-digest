## ADDED Requirements

### Requirement: The js-test adapter recognises node's spec reporter
A stream that contains node's spec-reporter summary (at least two of the lines `ℹ tests N`, `ℹ pass N`, `ℹ fail N`) SHALL be selected by the js-test adapter (Gear 0 grammar, so a failing run is `FAIL`, not `BUILD_ERROR`). Counts SHALL be read as in node TAP: `ℹ pass N` is passed, `ℹ fail N` plus `ℹ cancelled N` is failed, `ℹ skipped N` plus `ℹ todo N` is skipped. When the stream has a `✖ failing tests:` section, failures SHALL come only from that section, one per entry, where an entry is a `test at <file>:<line>:<col>` line, a `✖ <name> (<duration>)` line, and the indented lines up to the next blank line that precedes another `test at` line or the end of the stream:
- the test name is `<name>` with the parenthesised duration removed, with the ` @<line>` suffix of the requirement "Same-named failing node tests in one file stay distinct under the spec reporter" when it applies;
- the test file is `<file>`, made relative to the working directory;
- the message is the indented lines before the first `at ` frame, non-blank, each trimmed and joined with one space, with every remaining run of whitespace collapsed to one space and a ` [CODE]` tag after the error name removed (`AssertionError [ERR_ASSERTION]: ...` becomes `AssertionError: ...`); a message that is a single quoted string literal (one line that starts and ends with the same quote character and contains no other instance of it, such as `'test timed out after 20ms'`) is unquoted;
- the frames are the `at ` lines, with `file://` URLs replaced by filesystem paths (a trailing ` {` that opens the property block is not part of the frame);
- the diff is `{ expected: <expected: value>, received: <actual: value> }` from the trailing `{ ... }` property block, each value without its trailing comma and, for a string, without its surrounding quotes (`'pen',` gives `pen`); an object value stays as printed (`{ a: 2 }`);
- the raw-log range runs from the `test at` line to the entry's last non-blank line.

Tree rows (`✔`/`✖`/`▶` before the summary), including a failed suite row such as `✖ cart (31.4ms)`, MUST NOT create failures when the stream has a `✖ failing tests:` section (see "A spec-reporter stream cut before its failing-tests section still yields failures" for a stream without one).

#### Scenario: The cart run with the spec reporter is parsed, not reported as BUILD_ERROR
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=spec cart.test.js` runs
- **THEN** the exit code is `1`, `status` is `"FAIL"`, `execution_gear` is `"GEAR_0_GRAMMAR"`, `summary` is `{ "passed": 2, "failed": 4, "skipped": 0, "total_clusters": 4 }`, and no cluster has `error_kind` `UNSTRUCTURED_BUILD_ERROR`

#### Scenario: The spec reporter yields the same clusters as the TAP reporter
- **GIVEN** the same working directory
- **WHEN** the cart run is made once with `--test-reporter=spec` and once with `--test-reporter=tap`, both with `--format=json`
- **THEN** both envelopes list the cluster ids `c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a` in that order, with equal `error_kind`, `top_frame`, `message` and `sample_tests` per id
- **AND** in the spec run the diffs are `{ "expected": "900", "received": "0" }`, `{ "expected": "1634", "received": "0" }`, `{ "expected": "0", "received": "-16335" }` and none for `c_53a8182a`

#### Scenario: String values in diffs are unquoted under both reporters
- **GIVEN** the same working directory, whose `string-diff.test.js` is exactly `import { test } from "node:test";` / `import assert from "node:assert/strict";` / `test("label is pen", () => assert.equal("pan", "pen"));` (131 bytes)
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=<r> string-diff.test.js` runs once with `<r>` = `tap` and once with `<r>` = `spec`
- **THEN** both runs exit `1` and each envelope has exactly one cluster: `c_42febbe1`, `ASSERTION_FAILURE`, `top_frame` `string-diff.test.js:3:35`, message `AssertionError: Expected values to be strictly equal: 'pan' !== 'pen'`, diff `{ "expected": "pen", "received": "pan" }` and `sample_tests` `["label is pen"]`

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
- **AND** the `names match` cluster has message `AssertionError: Expected values to be strictly deep-equal: + actual - expected { + a: 1 - a: 2 }`, the same as under TAP

### Requirement: Same-named failing node tests in one file stay distinct under the spec reporter
When two or more failures from the `✖ failing tests:` section have the same test file and the same name, the adapter SHALL name each of them `<name> @<line>`, where `<line>` is the 1-based line part of its `test at <file>:<line>:<col>` line; a name that no other failure of that file shares MUST stay unchanged. The resulting names, identities and baseline entries are the same as under TAP.

#### Scenario: Two same-named failing tests in one file stay two failures under the spec reporter
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/` (with `same-name.test.js` from `node-tap-diagnostics`)
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=spec same-name.test.js` runs
- **THEN** the exit code is `1`, `summary` is `{ "passed": 0, "failed": 2, "skipped": 0, "total_clusters": 2 }`, the sum of `affected_count` is `2`, and `clusters` lists, in this order, `c_20e326b9` (`top_frame` `same-name.test.js:4:36`, `sample_tests` `["handles empty @4"]`) and `c_0044f190` (`top_frame` `same-name.test.js:7:36`, `sample_tests` `["handles empty @7"]`), both `ASSERTION_FAILURE` with message `AssertionError: Expected values to be strictly equal: 0 !== 1`
- **AND** `dot-test-digest --no-jev --tdd-phase=red --scope-id=same-spec -- node --test --test-reporter=spec same-name.test.js` exits `0` and `state-same-spec.json` has `baseline` equal to `same-name.test.js::handles empty @4` and `same-name.test.js::handles empty @7` (in any order)

### Requirement: A spec-reporter stream cut before its failing-tests section still yields failures
When a stream is selected as spec-reporter output (it has the `ℹ` summary) but contains no `✖ failing tests:` line, because the output was cut after the summary, the adapter SHALL create one failure per failing leaf tree row `✖ <name> (<duration>)` printed before the summary, with test name `<name>`, no test file, message `Unknown test failure`, no frames (so `top_frame` is `unknown:0:0` and the existing classifier gives `RUNTIME_EXCEPTION`), no diff, and the row's own line as its raw-log range. A `✖` row is a suite row, and creates no failure, when an earlier `▶ <name>` row with the same name at the same indentation opened it. Counts SHALL still come from the `ℹ` summary, and the sum of `affected_count` MUST NOT exceed `summary.failed`. A stream with tree rows and no `ℹ` summary (what Node 22.23.4 prints when the runner is stopped by SIGINT or SIGTERM) is not spec-reporter output and keeps the v0.1.2 behavior.

#### Scenario: A spec run cut before the failing-tests section still yields its failures
- **GIVEN** `tests/fixtures/logs/node-spec-truncated.log`, the first 14 lines (348 bytes) of `tests/fixtures/logs/node-spec-cart.log`: the six tree rows (two `✔`, then `✖ discount 10% leaves 90% (2.347807ms)`, `✖ total with 10% off (0.702625ms)`, `✖ total with 100% off is free (2.99843ms)`, `✖ first of an empty cart is undefined (0.50291ms)`) and the eight `ℹ` lines (`tests 6`, `suites 0`, `pass 2`, `fail 4`, `cancelled 0`, `skipped 0`, `todo 0`, `duration_ms 211.481803`), with no `✖ failing tests:` section
- **WHEN** `dot-test-digest --no-jev --format=json -- node -e "process.stdout.write(require('node:fs').readFileSync('<abs path to node-spec-truncated.log>','utf8')); process.exit(1)"` runs
- **THEN** the exit code is `1`, `status` is `"FAIL"`, `execution_gear` is `"GEAR_0_GRAMMAR"` and `summary` is `{ "passed": 2, "failed": 4, "skipped": 0, "total_clusters": 1 }`
- **AND** the one cluster is `c_11eac407`, `RUNTIME_EXCEPTION`, `affected_count` `4`, `top_frame` `unknown:0:0`, message `Unknown test failure`, `sample_tests` `["discount 10% leaves 90%", "total with 10% off", "total with 100% off is free"]` and `raw_log_lines` `L3-L6` (v0.1.2 reported `BUILD_ERROR`, `0 failed, 0 passed`)

### Requirement: A file-level spec-reporter failure carries the error its subprocess printed
When the failing-tests section reports a whole test file (`✖ <file> (<duration>)` whose message is `'test failed'`), the adapter SHALL use as that failure's message the subprocess error line that node printed outside the failing-tests section (node relays the subprocess's stderr through its reporter; on Node 22.23.4 it arrives on node's stdout, before the file's `✖ <file>` tree row, and the rule below does not depend on which stream the wrapper captured it from): the first line matching `<Name>Error[ [CODE]]: <text>` or `Error[ [CODE]]: <text>` in a contiguous non-blank block that mentions the failing file's absolute path or `file://` URL, else, when the run has exactly one file-level failure, the first such line in the stream; the ` [CODE]` tag is removed. When neither rule finds a line, the message stays `test failed`. Those subprocess lines MUST NOT create failures of their own.

#### Scenario: A missing module under the spec reporter is one SYNTAX_IMPORT_ERROR failure
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=spec missing-module.test.js` runs
- **THEN** `status` is `"FAIL"`, `summary.failed` is `1`, `total_clusters` is `1`, and the cluster has `error_kind` `SYNTAX_IMPORT_ERROR`, `sample_tests` `["missing-module.test.js"]` and a message that starts with `Error: Cannot find module '`

#### Scenario: A missing export under the spec reporter is a RUNTIME_EXCEPTION failure
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=spec missing-export.test.js` runs
- **THEN** `total_clusters` is `1` and the cluster has `error_kind` `RUNTIME_EXCEPTION` and message `SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'`

#### Scenario: Two crashing files under the spec reporter each carry their own subprocess error
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=spec missing-module.test.js missing-export.test.js` runs
- **THEN** the exit code is `1`, `status` is `"FAIL"`, `summary` is `{ "passed": 0, "failed": 2, "skipped": 0, "total_clusters": 2 }` and the sum of `affected_count` is `2`
- **AND** the cluster with `sample_tests` `["missing-module.test.js"]` has `error_kind` `SYNTAX_IMPORT_ERROR` and a message that starts with `Error: Cannot find module '`, contains `missing.js' imported from ` and ends with `/missing-module.test.js`, and the cluster with `sample_tests` `["missing-export.test.js"]` has `error_kind` `RUNTIME_EXCEPTION` and message `SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'` (the order of the two clusters is not asserted: node reports files in completion order)
- **AND** `dot-test-digest --no-jev --tdd-phase=red -- node --test --test-reporter=spec missing-module.test.js missing-export.test.js` exits `64` and its stdout contains `INVALID_RED` and `SYNTAX_IMPORT_ERROR` (v0.1.2 exited `64` with `[INVALID_RED | RED] 0 failed, 0 passed` and one `UNSTRUCTURED_BUILD_ERROR` cluster)

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
