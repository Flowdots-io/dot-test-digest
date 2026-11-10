## MODIFIED Requirements

### Requirement: A file-level spec-reporter failure carries the error its subprocess printed
When the failing-tests section reports a whole test file (`✖ <file> (<duration>)` whose message is `'test failed'`), the adapter SHALL use as that failure's message the error of that file's crash block. node prints what a crashed test file's subprocess wrote to stderr as one *crash block*, directly above that file's own entry: a location-only line (`file:///<path>:<N>`, `node:<module>:<N>` or `/<path>:<N>`), the source line and caret when there are any, the error, its stack, and the trailer `Node.js v<version>` (measured on Node 22.23.4 for a missing module, a transitive missing module, a missing export, a syntax error, a `ReferenceError`, a `throw 42`, an `EACCES`, a CJS `require`; a file that calls `process.exit(1)` prints no block). The adapter SHALL take the failure's message from the crash block of its own entry and from nothing else: among the lines above the entry (see below) take the last `Node.js v<version>` trailer line and the last location-only line before it; the message is the first line matching `<Name>Error[ [CODE]]: <text>` or `Error[ [CODE]]: <text>` from that location-only line to the trailer, with the ` [CODE]` tag removed. When there is no such block, or the block has no such line (`throw 42`, `process.exit(1)`), the message stays `test failed`. Lines printed outside the block (a setup module's `Error: config.json not found`, the log of another file, a stack frame that names another file) never take part, whatever they contain and whether or not they name the file. A path, a position or a count of crashed files is never used to pick a line. Under the spec reporter the lines above the entry are the lines between the previous tree row (a line starting `✔`, `✖`, `▶`, `﹣` or `ℹ`) and the file's own `✖ <file>` tree row outside every failing-tests section; when the same file name appears in several runs of one stream, the n-th crashed entry of that name takes the n-th such row. Those subprocess lines MUST NOT create failures of their own.

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


#### Scenario: A syntax error block with blank lines is attributed to its file
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test --test-reporter=spec missing-module.test.js syntax-error.test.js` runs
- **THEN** the cluster with `sample_tests` `["syntax-error.test.js"]` has `error_kind` `SYNTAX_IMPORT_ERROR` and message `SyntaxError: Unexpected end of input` (before this change: `test failed`)

#### Scenario: A startup crash is not blamed on another run's output
- **GIVEN** the same working directory and `wrap.mjs`, a file `exitload.test.js` (`process.exit(1);`) and `logc.test.js` (`import test from "node:test";` / `console.log("TypeError: cfg.get is not a function (handled)");` / `test("x", () => {});`)
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node wrap.mjs spec exitload.test.js logc.test.js` runs, and the same with `tap`
- **THEN** under each reporter the exit code is `64`, `status` is `"INVALID_RED"` and the cluster with `sample_tests` `["exitload.test.js"]` has `error_kind` `SYNTAX_IMPORT_ERROR` and message `test failed` (before this change under the spec reporter: `VALID_RED`, exit `0`, the `TypeError` of the other run)

#### Scenario: A crashed file in a later run of a multi-run stream keeps its error
- **GIVEN** the same working directory and a file `wrap.mjs` that runs `node --test --test-reporter=<reporter> <file>` once per file argument with inherited stdio and exits with the first non-zero status: `import { spawnSync } from "node:child_process";` / `const [reporter, ...files] = process.argv.slice(2);` / `let code = 0;` / `for (const f of files) { const r = spawnSync(process.execPath, ["--test", "--test-reporter=" + reporter, f], { stdio: "inherit" }); code = code || (r.status ?? 1); }` / `process.exit(code);`
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node wrap.mjs spec cart.test.js missing-export.test.js` runs, and the same with `tap`
- **THEN** under each reporter the exit code is `0`, `status` is `"VALID_RED"`, and the cluster with `sample_tests` `["missing-export.test.js"]` has `error_kind` `RUNTIME_EXCEPTION` and message `SyntaxError: The requested module './cart.js' does not provide an export named 'applyCoupon'` (before this change under the spec reporter: `INVALID_RED`, exit `64`, message `test failed`)

## ADDED Requirements

#### Scenario: The same file crashing in two runs keeps each run's own error
- **GIVEN** the same working directory, `wrap.mjs`, and `twice.test.js`: `import fs from "node:fs";` / `const marker = new URL("./twice.marker", import.meta.url);` / `if (fs.existsSync(marker)) { throw new RangeError("second run"); }` / `fs.writeFileSync(marker, "x");` / `throw new TypeError("first run");`
- **WHEN** the adapter parses the output of `node wrap.mjs spec twice.test.js twice.test.js` (two runs, each with a crash block directly above its own `✖ twice.test.js` row)
- **THEN** it returns two failures named `twice.test.js`, whose messages are `TypeError: first run` and `RangeError: second run` in that order (before this change both read `TypeError: first run`)

#### Scenario: A startup crash is not blamed on another file's log, in either file order
- **GIVEN** the same working directory, `exitload.test.js` and `logc.test.js` (see `node-tap-diagnostics`, "A startup crash is not blamed on another file's log under TAP")
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test --test-reporter=spec logc.test.js exitload.test.js` runs, and the same with the order reversed
- **THEN** both runs exit `64` with `status` `"INVALID_RED"`, and the cluster with `sample_tests` `["exitload.test.js"]` has `error_kind` `SYNTAX_IMPORT_ERROR` and message `test failed`

### Requirement: String diffs quoted with backticks are unquoted under the spec reporter
A diff value that node prints as one backtick-quoted string literal SHALL lose its backticks, as single- and double-quoted values do, so the diff and the `cluster_id` equal the TAP reporter's for the same failure.

#### Scenario: A backtick string diff equals the TAP diff
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `names.test.js` containing `import test from "node:test";` / `import assert from "node:assert";` / ``test("bt", () => assert.equal(`a'b"c`, `a'b"d`));``
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test names.test.js` and the same command with `--test-reporter=spec` run
- **THEN** both report one cluster whose `diff` is `{ "expected": "a'b\"d", "received": "a'b\"c" }`, and the same `cluster_id`

### Requirement: A test file node cannot read is INVALID_RED under the spec reporter
Same rule as under TAP (see `node-tap-diagnostics`): a crashed file whose subprocess error is `Error: EACCES` or `Error: EPERM` whose text contains the test file's absolute path in single quotes SHALL be `SYNTAX_IMPORT_ERROR`, so `--tdd-phase=red` gives `INVALID_RED` and exit `64`.

#### Scenario: An unreadable test file is INVALID_RED with exit 64 under the spec reporter
- **GIVEN** a fresh copy of `tests/fixtures/node-cart/` with `noread.test.js` (`import test from "node:test";` / `test("x", () => {});`) set to mode `000`, run by a user who is not root
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test --test-reporter=spec noread.test.js` runs
- **THEN** the exit code is `64`, `status` is `"INVALID_RED"`, and the cluster has `error_kind` `SYNTAX_IMPORT_ERROR` and a message that starts with `Error: EACCES: permission denied`

#### Scenario: A read failure of another file at load stays a behavioural red under the spec reporter
- **GIVEN** the files of the scenario "A read failure of another file at load stays a behavioural red" (see `node-tap-diagnostics`)
- **WHEN** `dot-test-digest --no-jev --format=json --tdd-phase=red -- node --test --test-reporter=spec loadsecret.test.js` runs
- **THEN** the exit code is `0`, `status` is `"VALID_RED"` and the cluster has `error_kind` `RUNTIME_EXCEPTION`
