## MODIFIED Requirements

### Requirement: A file-level TAP failure carries the error its subprocess printed
When node reports a whole test file as failed (a `not ok` entry whose block has `error: 'test failed'` and an `exitCode:` key), the adapter SHALL use as that failure's message the error line printed by the file's subprocess, which node relays as `# `-prefixed comment lines between the previous top-level entry's closing `...` (or the start of the stream) and that file's own `# Subtest: <file>` line, so in a run with several crashing files each file takes the error from its own comment run, never from another file's: the first line matching `<Name>Error[ [CODE]]: <text>` (or `Error[ [CODE]]: <text>`) at or after the last line of that run that mentions the file's absolute path or `file://` URL, with the ` [CODE]` tag removed; when no line of the run mentions the file, the first such line of the run; when the run has no such line, the message stays `test failed`. An error-shaped line printed earlier in the run by something else (a setup module that logs `Error: config.json not found`) therefore does not take the place of the file's own error. In a node TAP stream (one containing `# Subtest:`), comment lines MUST NOT create a failure of their own, so the file contributes exactly one failure.

Fixtures in `tests/fixtures/node-cart/`:
- `missing-module.test.js`: `import { test } from "node:test";` / `import assert from "node:assert/strict";` / `import { subtotal } from "./missing.js";` / `test("subtotal", () => assert.equal(subtotal([]), 0));`
- `missing-export.test.js`: `import { test } from "node:test";` / `import assert from "node:assert/strict";` / `import { applyCoupon } from "./cart.js";` / `test("coupon", () => assert.equal(applyCoupon(100, "TEN"), 90));`
- `passing.test.js`: `import { test } from "node:test";` / `import assert from "node:assert/strict";` / `test("passes", () => assert.equal(1, 1));`

#### Scenario: A missing module is one SYNTAX_IMPORT_ERROR failure
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test missing-module.test.js` runs
- **THEN** the exit code is `1`, `summary.failed` is `1`, `total_clusters` is `1`, and the cluster has `error_kind` `SYNTAX_IMPORT_ERROR`, `affected_count` `1`, `sample_tests` `["missing-module.test.js"]` and a message that starts with `Error: Cannot find module '` and contains `missing.js' imported from `

#### Scenario: A missing export is a RUNTIME_EXCEPTION failure, not a syntax error
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test missing-export.test.js` runs
- **THEN** the exit code is `1`, `total_clusters` is `1`, and the cluster has `error_kind` `RUNTIME_EXCEPTION` and message `SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'`

#### Scenario: Two crashing files under TAP each carry their own subprocess error
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test missing-module.test.js missing-export.test.js` runs
- **THEN** the exit code is `1`, `summary` is `{ "passed": 0, "failed": 2, "skipped": 0, "total_clusters": 2 }` and the sum of `affected_count` is `2`
- **AND** the cluster with `sample_tests` `["missing-module.test.js"]` has `error_kind` `SYNTAX_IMPORT_ERROR` and a message that starts with `Error: Cannot find module '` and contains `missing.js' imported from ` and ends with `/missing-module.test.js`, and the cluster with `sample_tests` `["missing-export.test.js"]` has `error_kind` `RUNTIME_EXCEPTION` and message `SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'` (the order of the two clusters is not asserted: node reports files in completion order)
- **AND** `dot-test-digest --no-jev --tdd-phase=red -- node --test missing-module.test.js missing-export.test.js` exits `64` and its stdout contains `INVALID_RED` and `SYNTAX_IMPORT_ERROR` (v0.1.2 also exited `64`, but reported 3 clusters for 2 failures and attributed the `Cannot find module` error to `missing-export.test.js`)


#### Scenario: A log line above the crash is not mistaken for the file's error
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test --import 'data:text/javascript,console.log("Error: config.json not found, using defaults")' missing-module.test.js` runs
- **THEN** the exit code is `64`, `status` is `"INVALID_RED"`, and the cluster has `error_kind` `SYNTAX_IMPORT_ERROR`, `sample_tests` `["missing-module.test.js"]` and a message that starts with `Error: Cannot find module '` (before this change: `VALID_RED`, exit `0`, message `Error: config.json not found, using defaults`)

#### Scenario: A syntax error in a test file is attributed to that file under TAP
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test missing-module.test.js syntax-error.test.js` runs
- **THEN** the cluster with `sample_tests` `["syntax-error.test.js"]` has `error_kind` `SYNTAX_IMPORT_ERROR` and message `SyntaxError: Unexpected end of input`

## ADDED Requirements

### Requirement: A thrown error without a name reads as Error under TAP
A TAP block with `failureType: 'testCodeFailure'` or `failureType: 'hookFailed'` and no `name:` key is an error whose class node does not print (a plain `Error`); its message SHALL be `Error: <error text>`, or `Error` when the text is empty, so that the same failure has the same message and `cluster_id` as under the spec reporter. A block that has a `name:` key (`TypeError`, `AssertionError`), a timeout, a cancellation and a crashed file are unchanged. Limit: node prints a thrown string and a thrown `Error` the same way in TAP, so `throw 'text'` also reads `Error: text` under TAP while the spec reporter prints `text`.

The fixture `tests/fixtures/node-cart/plain.test.js` (new) is: `import test, { describe, before } from "node:test";` / `test("plain", () => { throw new Error("z"); });` / `test("empty", () => { throw new Error(""); });` / `test("typed", () => { throw new TypeError("t"); });` / `describe("suite", () => { before(() => { throw new Error("hb"); }); test("inner", () => {}); });`.

#### Scenario: Plain errors and hook errors read as Error under both reporters
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test plain.test.js` and the same command with `--test-reporter=spec` run
- **THEN** under each reporter the clusters with `sample_tests` `["plain"]`, `["empty"]`, `["typed"]` and `["suite"]` have messages `Error: z`, `Error`, `TypeError: t` and `Error: hb`
- **AND** the set of `cluster_id` values is the same under both reporters (before this change TAP gave `z`, `Unknown test failure` and `hb`)

### Requirement: A backslash in a TAP test name is unescaped
node writes a backslash of a test name as `\\` in a TAP `not ok` line and as `\` in the spec tree. The TAP reader SHALL turn `\\` back into `\` (as it already does for `\#`), so a test named `back\slash` has the same name, baseline id and `cluster_id` under both reporters.

#### Scenario: A test name with a backslash is the same under both reporters
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with a file `names.test.js`: `import test from "node:test";` / `import assert from "node:assert";` / `test("back\\slash", () => assert.equal(1, 2));`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test names.test.js` and the same command with `--test-reporter=spec` run
- **THEN** both report one cluster with `sample_tests` `["back\\slash"]` (the single-backslash name `back\slash`) and the same `cluster_id`

### Requirement: A test file node cannot read is INVALID_RED under TAP
When a whole test file failed (`error: 'test failed'` with an `exitCode:` key) and the error its subprocess printed is a read failure on a file (`Error: EACCES`, `Error: EPERM` or `Error: EISDIR`), the failure SHALL have `error_kind` `SYNTAX_IMPORT_ERROR`, because the runner never ran a test; with `--tdd-phase=red` the run is `INVALID_RED` and exits `64` (INV-5, a runner startup crash). The message is the error line.

#### Scenario: An unreadable test file is INVALID_RED with exit 64
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `noread.test.js` (`import test from "node:test";` / `test("x", () => {});`) set to mode `000`, run by a user who is not root
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test noread.test.js` runs
- **THEN** the exit code is `64`, `status` is `"INVALID_RED"`, and the cluster has `error_kind` `SYNTAX_IMPORT_ERROR` and a message that starts with `Error: EACCES: permission denied` (before this change: `VALID_RED`, exit `0`, `RUNTIME_EXCEPTION`)
