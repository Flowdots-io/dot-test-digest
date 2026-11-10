## MODIFIED Requirements

### Requirement: A file-level TAP failure carries the error its subprocess printed
When node reports a whole test file as failed (a `not ok` entry whose block has `error: 'test failed'` and an `exitCode:` key), the adapter SHALL use as that failure's message the error of that file's crash block. node prints what a crashed test file's subprocess wrote to stderr as one *crash block*, directly above that file's own entry: a location-only line (`file:///<path>:<N>`, `node:<module>:<N>` or `/<path>:<N>`), the source line and caret when there are any, the error, its stack, and the trailer `Node.js v<version>` (measured on Node 22.23.4 for a missing module, a transitive missing module, a missing export, a syntax error, a `ReferenceError`, a `throw 42`, an `EACCES`, a CJS `require`; a file that calls `process.exit(1)` prints no block). The adapter SHALL take the failure's message from the crash block of its own entry and from nothing else: among the lines above the entry (see below) take the last `Node.js v<version>` trailer line and the last location-only line before it; the message is the first line matching `<Name>Error[ [CODE]]: <text>` or `Error[ [CODE]]: <text>` from that location-only line to the trailer, with the ` [CODE]` tag removed. When there is no such block, or the block has no such line (`throw 42`, `process.exit(1)`), the message stays `test failed`. Lines printed outside the block (a setup module's `Error: config.json not found`, the log of another file, a stack frame that names another file) never take part, whatever they contain and whether or not they name the file. A path, a position or a count of crashed files is never used to pick a line. Under TAP the lines above the entry are the `# `-prefixed comment lines between the previous top-level entry's closing `...` (or the start of the stream) and that file's own `# Subtest: <file>` line, so in a run with several crashing files each file takes the block directly above its own `# Subtest:` line, never another file's. In a node TAP stream (one containing `# Subtest:`), comment lines MUST NOT create a failure of their own, so the file contributes exactly one failure.

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

#### Scenario: A runtime error at load is not displaced by an earlier log line
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `refload.test.js`: `import test from "node:test";` / `console.log("SyntaxError: Unexpected token } in JSON (from setup)");` / `notDefinedYet();` / `test("x", () => {});`
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test refload.test.js` runs, and the same with `--test-reporter=spec`
- **THEN** under each reporter the exit code is `0`, `status` is `"VALID_RED"` and the cluster has message `ReferenceError: notDefinedYet is not defined` (the log line precedes the error and the frame naming the file follows it)

#### Scenario: A syntax error in a test file is attributed to that file under TAP
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test missing-module.test.js syntax-error.test.js` runs
- **THEN** the cluster with `sample_tests` `["syntax-error.test.js"]` has `error_kind` `SYNTAX_IMPORT_ERROR` and message `SyntaxError: Unexpected end of input`

## ADDED Requirements

#### Scenario: A crash that does not name the test file keeps its own block
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `helper.js` (`import "./missing-dep.js";` / `export const h = 1;`) and `deep.test.js` (`import test from "node:test";` / `import "./helper.js";` / `test("x", () => {});`)
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test --import 'data:text/javascript,console.log("Error: config.json not found, using defaults")' deep.test.js` runs, and the same with `--test-reporter=spec`
- **THEN** under each reporter the exit code is `64`, `status` is `"INVALID_RED"` and the cluster has `error_kind` `SYNTAX_IMPORT_ERROR` and a message that starts with `Error: Cannot find module '` and contains `missing-dep.js' imported from ` (node's error names `helper.js`, not `deep.test.js`; the setup line never takes its place)

#### Scenario: A load-time throw of a non-error is an unattributed startup crash
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `throw42.test.js` (`throw 42;`)
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test --import 'data:text/javascript,console.log("Error: config.json not found, using defaults")' throw42.test.js` runs, and the same with `--test-reporter=spec`
- **THEN** under each reporter the exit code is `64`, `status` is `"INVALID_RED"`, and the cluster has `error_kind` `SYNTAX_IMPORT_ERROR` and message `test failed` (the crash block holds `42`, which is not an error line, and the setup line is outside it)

#### Scenario: A startup crash is not blamed on another file's log under TAP
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `exitload.test.js` (`process.exit(1);`) and `logc.test.js` (`import test from "node:test";` / `console.log("TypeError: cfg.get is not a function (handled)");` / `test("x", () => {});`)
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test logc.test.js exitload.test.js` runs, and the same with the file order reversed, and each of the two with `--test-reporter=spec`
- **THEN** in all four runs the exit code is `64`, `status` is `"INVALID_RED"` and the cluster with `sample_tests` `["exitload.test.js"]` has `error_kind` `SYNTAX_IMPORT_ERROR` and message `test failed`

### Requirement: A thrown error without a name reads as Error under TAP
A TAP block with `failureType: 'testCodeFailure'` or `failureType: 'hookFailed'`, a `stack:` key and no `name:` key is an error whose class node does not print (a plain `Error`); its message SHALL be `Error: <error text>`, or `Error` when the text is empty, so that the same failure has the same message and `cluster_id` as under the spec reporter. A block that has a `name:` key (`TypeError`, `AssertionError`), a timeout, a cancellation and a crashed file are unchanged. A block without a `stack:` key (a thrown string or number, a failed `t.plan`) keeps its text as is, as the spec reporter prints it.

The fixture `tests/fixtures/node-cart/plain.test.js` (new) is: `import test, { describe, before } from "node:test";` / `test("plain", () => { throw new Error("z"); });` / `test("empty", () => { throw new Error(""); });` / `test("typed", () => { throw new TypeError("t"); });` / `describe("suite", () => { before(() => { throw new Error("hb"); }); test("inner", () => {}); });`.

#### Scenario: Plain errors and hook errors read as Error under both reporters
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test plain.test.js` and the same command with `--test-reporter=spec` run
- **THEN** under each reporter the clusters with `sample_tests` `["plain"]`, `["empty"]`, `["typed"]` and `["suite"]` have messages `Error: z`, `Error`, `TypeError: t` and `Error: hb`
- **AND** the set of `cluster_id` values is the same under both reporters (before this change TAP gave `z`, `Unknown test failure` and `hb`)

#### Scenario: A thrown number keeps its text under both reporters
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `thrown.test.js`: `import test from "node:test";` / `test("num", () => { throw 42; });` / `test("obj", () => { throw { a: 1 }; });`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test thrown.test.js` and the same command with `--test-reporter=spec` run
- **THEN** under each reporter the clusters with `sample_tests` `["num"]` and `["obj"]` have the messages the spec reporter prints (`42` and `{ a: 1 }`, no `Error: ` prefix), and the `cluster_id` values are the same under both reporters

### Requirement: A backslash in a TAP test name is unescaped
node writes a backslash of a test name as `\\` in a TAP `not ok` line and as `\` in the spec tree. The TAP reader SHALL turn `\\` back into `\` (as it already does for `\#`), so a test named `back\slash` has the same name, baseline id and `cluster_id` under both reporters.

#### Scenario: A test name with a backslash is the same under both reporters
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with a file `names.test.js`: `import test from "node:test";` / `import assert from "node:assert";` / `test("back\\slash", () => assert.equal(1, 2));`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test names.test.js` and the same command with `--test-reporter=spec` run
- **THEN** both report one cluster with `sample_tests` `["back\\slash"]` (the single-backslash name `back\slash`) and the same `cluster_id`

### Requirement: A test file node cannot read is INVALID_RED under TAP
When a whole test file failed (`error: 'test failed'` with an `exitCode:` key) and the error its subprocess printed is a read failure on the test file itself (`Error: EACCES` or `Error: EPERM` whose text contains the test file's absolute path in single quotes, as in `open '/dir/file.test.js'`), the failure SHALL have `error_kind` `SYNTAX_IMPORT_ERROR`, because the runner never ran a test; with `--tdd-phase=red` the run is `INVALID_RED` and exits `64` (INV-5, a runner startup crash). The message is the error line.

#### Scenario: An unreadable test file is INVALID_RED with exit 64
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `noread.test.js` (`import test from "node:test";` / `test("x", () => {});`) set to mode `000`, run by a user who is not root
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test noread.test.js` runs
- **THEN** the exit code is `64`, `status` is `"INVALID_RED"`, and the cluster has `error_kind` `SYNTAX_IMPORT_ERROR` and a message that starts with `Error: EACCES: permission denied` (before this change: `VALID_RED`, exit `0`, `RUNTIME_EXCEPTION`)

#### Scenario: A read failure of another file at load stays a behavioural red
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `secret.txt` (any text) set to mode `000`, and `loadsecret.test.js`: `import fs from "node:fs";` / `import test from "node:test";` / `fs.readFileSync(new URL("./secret.txt", import.meta.url));` / `test("uses it", () => {});`, run by a user who is not root
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test loadsecret.test.js` runs
- **THEN** the exit code is `0`, `status` is `"VALID_RED"`, and the cluster has `error_kind` `RUNTIME_EXCEPTION` and a message that starts with `Error: EACCES: permission denied` (the error names `secret.txt`, not the test file)

#### Scenario: A read failure of a sibling file whose name starts like the test file stays a behavioural red
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `cfg.test.json` (any text) set to mode `000` and `cfg.test.js`: `import fs from "node:fs";` / `import test from "node:test";` / `fs.readFileSync(new URL("./cfg.test.json", import.meta.url));` / `test("x", () => {});`, run by a user who is not root
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test cfg.test.js` runs
- **THEN** the exit code is `0`, `status` is `"VALID_RED"` and the cluster has `error_kind` `RUNTIME_EXCEPTION` (the error names `'.../cfg.test.json'`, not `'.../cfg.test.js'`)
