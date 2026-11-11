## MODIFIED Requirements

### Requirement: A file-level TAP failure carries the error its subprocess printed
When node reports a whole test file as failed (a `not ok` entry whose block has `error: 'test failed'` and an `exitCode:` key), the adapter SHALL use as that failure's message the error of that file's crash block. node prints what a crashed test file's subprocess wrote to stderr as one *crash block*, directly above that file's own entry: a location-only line (a line that is not indented, is not an error line and ends in `:<N>`: `file:///<path>:<N>`, `node:<module>:<N>`, `/<path with spaces>:<N>`, `<anonymous_script>:<N>`, or the same text after a partial stdout line), the source line and caret when there are any, the error, its stack, and the trailer `Node.js v<version>` (measured on Node 22.23.4 for a missing module, a transitive missing module, a missing export, a syntax error, a `ReferenceError`, a `throw 42`, an `EACCES`, a CJS `require`; a file that calls `process.exit(1)` prints no block). The adapter SHALL take the failure's message from the crash blocks above its own entry and from nothing else. Among the lines above the entry (see below), each `Node.js v<version>` trailer line ends one block; the block's location-only line is the last location-only line since the previous trailer that is followed, before this trailer, by an error line, and its error is the first line matching `<Name>Error[ [CODE]]: <text>` or `Error[ [CODE]]: <text>` after that location-only line, with the ` [CODE]` tag removed (so an unindented continuation line of the message that happens to end in `:<N>`, or a log line ending in `:<N>` printed earlier, is not the location). When several blocks sit above the entry (another process that shares the stderr, a server started by a setup module, crashed after the file did), the message is the error of the first block whose error is an import or syntax error (`SYNTAX_IMPORT_ERROR` by the classifier, a missing export excepted), so a broken import is never hidden by an unrelated crash, and otherwise the error of the last block. When there is no such block, or the block has no such line (`throw 42`, `process.exit(1)`), the message stays `test failed`. Lines printed outside the block (a setup module's `Error: config.json not found`, the log of another file, a stack frame that names another file) never take part, whatever they contain and whether or not they name the file. The block is found by its shape and its place only: no file name, path or count of crashed files is used to pick a line. When there is no crash block, a line `Error: Test "<name>" at <path>:<line>:<col> generated asynchronous activity after the test ended. ...` or `Error: A resource generated asynchronous activity after the test ended. ...` among the lines above the entry (node's own diagnostic for a test file whose tests ran and then failed on a late error; under the spec reporter it is an `ℹ ` row and the `ℹ ` is dropped) is the message and is classified normally, so a file whose tests ran is not turned into a startup crash. Under TAP the lines above the entry are the unbroken run of `# `-prefixed comment lines directly above that file's own `# Subtest: <file>` line (a line that is not a comment ends the run; the run never reaches back past the previous top-level entry's closing `...`), so in a run with several crashing files each file takes the block directly above its own `# Subtest:` line, never another file's. In a node TAP stream (one containing `# Subtest:`), comment lines MUST NOT create a failure of their own, so the file contributes exactly one failure.

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

#### Scenario: A load-time error in a path with a space, in eval code, or after a partial line keeps its error
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` placed in a directory whose name contains a space, with `typeload.test.cjs` (`const test = require("node:test");` / `const cfg = {};` / `cfg.get("x");` / `test("x", () => {});`) and `evalload.test.js` (`import test from "node:test";` / `eval("null.x");` / `test("x", () => {});`)
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test typeload.test.cjs` runs, and the same for `evalload.test.js`, each with the default and the `--test-reporter=spec` reporter
- **THEN** all four runs exit `0` with `status` `"VALID_RED"` and the cluster has `error_kind` `RUNTIME_EXCEPTION` and a message that starts with `TypeError: ` (`cfg.get is not a function`, `Cannot read properties of null`); before the crash-block rule these were `VALID_RED` too, and a location regex that does not accept a space or `<anonymous_script>:1` would turn them into `INVALID_RED`

#### Scenario: A file whose tests ran and then failed on a late error is not a startup crash
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `asyncfail.test.js`: `import test from "node:test";` / `import { subtotal } from "./cart.js";` / `test("calls impl", () => { setTimeout(() => { subtotal(undefined).x.y; }, 10); });`
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test asyncfail.test.js` runs, and the same with `--test-reporter=spec`
- **THEN** under each reporter the exit code is `0`, `status` is `"VALID_RED"` and the cluster has `error_kind` `RUNTIME_EXCEPTION` and a message that starts with `Error: Test "calls impl" at asyncfail.test.js` (node's diagnostic above the file's entry; on the base commit TAP gave the same and the spec reporter gave `INVALID_RED`)

#### Scenario: A late error in a file-level timer next to failing tests keeps the run a valid red
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `latethrow.test.js`: `import test from "node:test";` / `test("passes", () => {});` / `setTimeout(() => { throw new TypeError("late boom"); }, 50);`
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test cart.test.js latethrow.test.js` runs, and the same with `--test-reporter=spec`
- **THEN** under each reporter the exit code is `0` and `status` is `"VALID_RED"` (the four behavioural failures of `cart.test.js` are not turned into `INVALID_RED` by the late error of the other file)

#### Scenario: A crash of a process started by a setup module does not hide a broken import
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `server.js` (`import http from "node:http";` / `setTimeout(() => http.createServer(() => {}).listen(0), 200);` modified so that it crashes: `setTimeout(() => { throw new TypeError("app.listen is not a function"); }, 200);`) and `setup-dev.mjs` (`import { spawn } from "node:child_process";` / `spawn(process.execPath, [new URL("./server.js", import.meta.url).pathname], { stdio: "inherit" }).unref();`)
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test --import ./setup-dev.mjs missing-module.test.js` runs, and the same with `--test-reporter=spec`
- **THEN** under each reporter the exit code is `64`, `status` is `"INVALID_RED"` and the cluster has `error_kind` `SYNTAX_IMPORT_ERROR` and a message that starts with `Error: Cannot find module '` (both blocks sit above the file's entry; the import error wins; before this round the later `TypeError` block was taken and the run was `VALID_RED`, exit `0`)

#### Scenario: A load-time error whose message continues on a line ending in a number keeps its error
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `multiline.test.js`: `import test from "node:test";` / `throw new TypeError("config invalid at\n/etc/app/config.json:12");`
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test multiline.test.js` runs, and the same with `--test-reporter=spec`
- **THEN** under each reporter the exit code is `0`, `status` is `"VALID_RED"` and the cluster has `error_kind` `RUNTIME_EXCEPTION` and message `TypeError: config invalid at`

## ADDED Requirements

### Requirement: A thrown error without a name reads as Error under TAP
A TAP block with `failureType: 'testCodeFailure'`, `'hookFailed'` or `'uncaughtException'`, a `stack:` key and no `name:` key is an error whose class node does not print (a plain `Error`); its message SHALL be `Error: <error text>`, or `Error` when the text is empty, so that the same failure has the same message and `cluster_id` as under the spec reporter. A block that has a `name:` key (`TypeError`, `AssertionError`), a timeout, a cancellation and a crashed file are unchanged. A block without a `stack:` key (a thrown string or number, a failed `t.plan`) keeps its text as is, as the spec reporter prints it.

The fixture `tests/fixtures/node-cart/plain.test.js` (new) is: `import test, { describe, before } from "node:test";` / `test("plain", () => { throw new Error("z"); });` / `test("empty", () => { throw new Error(""); });` / `test("typed", () => { throw new TypeError("t"); });` / `describe("suite", () => { before(() => { throw new Error("hb"); }); test("inner", () => {}); });`.

#### Scenario: Plain errors and hook errors read as Error under both reporters
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test plain.test.js` and the same command with `--test-reporter=spec` run
- **THEN** under each reporter the clusters with `sample_tests` `["plain"]`, `["empty"]`, `["typed"]` and `["suite"]` have messages `Error: z`, `Error`, `TypeError: t` and `Error: hb`
- **AND** the set of `cluster_id` values is the same under both reporters (before this change TAP gave `z`, `Unknown test failure` and `hb`)

#### Scenario: An uncaught exception in a timer reads the same under both reporters
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `timer.test.js`: `import test from "node:test";` / `test("t", async () => { setTimeout(() => { throw new Error("u"); }, 5); await new Promise((r) => setTimeout(r, 50)); });`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test timer.test.js` and the same command with `--test-reporter=spec` run
- **THEN** both reporters report a cluster with message `Error: u` and the same `cluster_id` (before this change TAP gave `u`)

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
When a whole test file failed (`error: 'test failed'` with an `exitCode:` key) and the error its subprocess printed is a read failure on the test file itself (`Error: EACCES` or `Error: EPERM` whose text contains the test file's absolute path in single quotes, as in `open '/dir/file.test.js'`; the path as given and its real path, symlinks resolved, both count), the failure SHALL have `error_kind` `SYNTAX_IMPORT_ERROR`, because the runner never ran a test; with `--tdd-phase=red` the run is `INVALID_RED` and exits `64` (INV-5, a runner startup crash). The message is the error line.

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

#### Scenario: An unreadable test file reached through a symlinked directory is INVALID_RED
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `noread.test.js` set to mode `000` (see the scenario "An unreadable test file is INVALID_RED with exit 64"), a symlink `link` to that directory, and a user who is not root
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test <absolute path through link>/noread.test.js` runs from inside `link`, and the same with `--test-reporter=spec`
- **THEN** under each reporter the exit code is `64` and `status` is `"INVALID_RED"` (node's error names the real path, the entry carries the symlink path; both count)
