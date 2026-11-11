# node-tap-diagnostics Specification

## Purpose
TBD - created by archiving change sharpen-weak-digest-cases. Update Purpose after archive.
## Requirements
### Requirement: One failure per failing node test from its TAP diagnostic block
The js-test adapter SHALL turn every `not ok N - <name>` entry of a TAP stream that is followed by a YAML diagnostic block (`---` ... `...`) with a top-level `failureType:` key (a *node block*: node writes `failureType:` on every failing entry, and no other key decides the path) into exactly one failure, except for the suite rows of the next requirement, where:
- the test name is `<name>` (the leaf name; no suite prefix), with the ` @<line>` suffix of the requirement "Same-named failing node tests in one file stay distinct under TAP" when it applies;
- the test file is the path part of `location:` (`<path>:<line>:<col>`), made relative to the working directory;
- the message is the non-blank lines of `error:` (a `|-` block scalar, or a quoted scalar with its quotes removed), each trimmed and joined with one space, with every remaining run of whitespace collapsed to one space, prefixed with `<name:>: ` when `name:` is present and the text does not already start with it;
- the diff is `{ expected: <expected:>, received: <actual:> }` when both keys are present: a scalar value as printed with any surrounding quotes removed (`'pen'` gives `pen`), an indented mapping value as its trimmed lines joined with `, ` (`a: 2`);
- the frames are the lines of `stack:`, each with any `file://` URL replaced by the filesystem path it denotes;
- the raw-log range runs from the `not ok` line to the block's closing `...` line;
- `error_kind` is derived from the message and frames with the existing classifier, so `AssertionError` gives `ASSERTION_FAILURE`, `TypeError` gives `RUNTIME_EXCEPTION`, and `timed out` gives `TIMEOUT_OR_CONN_REFUSED`.

A `not ok` entry without a diagnostic block, or whose block has no top-level `failureType:` key (whatever other keys it has, `error:` included), MUST keep the v0.1.2 behavior, so the existing `tap grammar` test keeps passing. Fixture: `tests/fixtures/node-cart/` holds `cart.js`, `cart.test.js` and `package.json` (`{"type":"module"}`) copied byte for byte from the README measurement project (`/tmp/dtd-work/nodetest/`): 6 tests, of which `discount 10% leaves 90%`, `total with 10% off`, `total with 100% off is free` and `first of an empty cart is undefined` fail.

#### Scenario: The cart run with the default (TAP) reporter yields four distinct clusters
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/` and stdout is piped (so node picks the TAP reporter)
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test cart.test.js` runs
- **THEN** the exit code is `1`, `status` is `"FAIL"`, `execution_gear` is `"GEAR_0_GRAMMAR"` and `summary` is `{ "passed": 2, "failed": 4, "skipped": 0, "total_clusters": 4 }`
- **AND** `clusters` lists, in this order, each with `affected_count: 1`:
  - `c_9721831d`, `ASSERTION_FAILURE`, `top_frame` `cart.test.js:7:46`, message `AssertionError: Expected values to be strictly equal: 0 !== 900`, diff `{ "expected": "900", "received": "0" }`, `sample_tests` `["discount 10% leaves 90%"]`
  - `c_6edce10a`, `ASSERTION_FAILURE`, `top_frame` `cart.test.js:8:41`, message `AssertionError: Expected values to be strictly equal: 0 !== 1634`, diff `{ "expected": "1634", "received": "0" }`, `sample_tests` `["total with 10% off"]`
  - `c_fdff652c`, `ASSERTION_FAILURE`, `top_frame` `cart.test.js:9:50`, message `AssertionError: Expected values to be strictly equal: -16335 !== 0`, diff `{ "expected": "0", "received": "-16335" }`, `sample_tests` `["total with 100% off is free"]`
  - `c_53a8182a`, `RUNTIME_EXCEPTION`, `top_frame` `cart.js:5:42`, message `TypeError: Cannot read properties of undefined (reading 'name')`, no `diff`, `sample_tests` `["first of an empty cart is undefined"]`
- **AND** no cluster has `top_frame` `unknown:0:0` or message `Unknown test failure`

#### Scenario: Each node failure gets a SignalWindow from the right file
- **GIVEN** the same cart run as above
- **WHEN** its `--format=json` envelope is read
- **THEN** the `signal_window` of `c_9721831d` contains the row `7 > test("discount 10% leaves 90%", () => assert.equal(discount(1000, 10), 900));`
- **AND** the `signal_window` of `c_53a8182a` is exactly these three rows joined by `\n`:
  `3 | export const discount = (n, p) => n - Math.round(n * p / 10); // bug: /10`,
  `4 | export const total = (items, p = 0) => { const d = discount(subtotal(items), p); return d + tax(d); };`,
  `5 > export const first = (items) => items[0].name;`
- **AND** no `pruned_stack` entry contains `file://` or `node:internal`

#### Scenario: The compact-md digest of the cart run no longer merges the failures
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev -- node --test cart.test.js` runs
- **THEN** the exit code is `1`, the first stdout line starts with `[FAIL] 4 failed, 2 passed in ` and stdout is at most 2,400 bytes
- **AND** stdout contains `diff: expected 900 / received 0` and contains neither `unknown:0:0`, `Unknown test failure`, `file://`, nor any line ending in `received ` (an empty received value)

#### Scenario: A recorded TAP log parses to the same records at the adapter seam
- **GIVEN** `tests/fixtures/logs/node-tap-cart.log`, the recorded TAP output of the `node-cart` fixture (3,710 bytes when recorded; regeneration and the values that must survive it are in `design.md` "Fixtures") with the copy's absolute path replaced by `__ROOT__`, and the test replaces `__ROOT__` with `<cwd>/tests/fixtures/node-cart`
- **WHEN** `runGear0` parses its lines
- **THEN** the adapter is `js-test`, counts are `{ passed: 2, failed: 4, skipped: 0 }`, and there are 4 failures with test files `tests/fixtures/node-cart/cart.test.js` and raw ranges `15-39`, `41-65`, `67-91` and `93-111`

#### Scenario: A TAP block without a failureType key keeps the v0.1.2 behavior
- **WHEN** `runGear0` parses these lines, whose block has `error:` but no `failureType:`: `not ok 1 - cart totals`, `  ---`, `  error: |-`, `    AssertionError: expected 99 to be 100`, `  ...`, `1..1`, `# tests 1`, `# pass 0`, `# fail 1`
- **THEN** the adapter is `js-test`, `counts.failed` is `1`, and there is exactly 1 failure with `errorKind` `ASSERTION_FAILURE` and message `AssertionError: expected 99 to be 100`

### Requirement: Node TAP counts, suites and timeouts
In a node TAP stream the adapter SHALL read `# pass N` as passed, `# fail N` plus `# cancelled N` as failed (node reports a timed-out test as cancelled), and `# skipped N` plus `# todo N` as skipped. A `not ok` entry whose block has `failureType: 'subtestsFailed'` (a suite whose children failed) MUST NOT produce a failure. The sum of `affected_count` over all clusters MUST NOT exceed `summary.failed` (SPEC-002 §4.2.2).

Fixture `tests/fixtures/node-cart/suite.test.js`, exactly:
```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
import { discount, first } from "./cart.js";
describe("cart", () => {
  it("discount 10% leaves 90%", () => assert.equal(discount(1000, 10), 900));
  it("first item name", () => assert.equal(first([{ name: "pen" }]), "pen"));
  it("names match", () => assert.deepEqual({ a: 1 }, { a: 2 }));
  it("slow", { timeout: 20 }, async () => { await new Promise((r) => setTimeout(r, 200)); });
});
```

#### Scenario: Nested suite with a deep-equal failure and a timeout
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test suite.test.js` runs
- **THEN** the exit code is `1` and `summary` has `passed: 1`, `failed: 3`, `skipped: 0`
- **AND** the union of `sample_tests` is exactly `discount 10% leaves 90%`, `names match`, `slow`, no cluster names `cart`, and the sum of `affected_count` is `3`
- **AND** the `names match` cluster is `ASSERTION_FAILURE` with `top_frame` `suite.test.js:7:34`, message `AssertionError: Expected values to be strictly deep-equal: + actual - expected { + a: 1 - a: 2 }` and diff `{ "expected": "a: 2", "received": "a: 1" }`
- **AND** the `slow` cluster is `TIMEOUT_OR_CONN_REFUSED` with message `test timed out after 20ms`, `top_frame` `unknown:0:0` and `signal_window` `""` (no repository frame exists; the `location:` line is not borrowed)

### Requirement: Same-named failing node tests in one file stay distinct under TAP
When two or more failures that the adapter produces from node blocks of the same test file have the same leaf name, the adapter SHALL name each of those failures `<name> @<line>`, where `<line>` is the 1-based line part of its `location:`; a leaf name that no other failure of that file shares MUST stay unchanged. Each such test therefore has its own identity `<file>::<name> @<line>` (SPEC-002 §4.3), its own TDD baseline entry and its own `affected_count`, so `uniqueFailures` does not merge them. Suite rows are excluded before names are compared.

Fixture `tests/fixtures/node-cart/same-name.test.js`, exactly (256 bytes):
```js
import { describe, it } from "node:test";
import assert from "node:assert/strict";
describe("add", () => {
  it("handles empty", () => assert.equal([].length, 1));
});
describe("remove", () => {
  it("handles empty", () => assert.equal([].length, 1));
});
```

#### Scenario: Two same-named failing tests in one file stay two failures under TAP
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/`
- **WHEN** `dot-test-digest --no-jev --format=json -- node --test same-name.test.js` runs
- **THEN** the exit code is `1`, `summary` is `{ "passed": 0, "failed": 2, "skipped": 0, "total_clusters": 2 }` and the sum of `affected_count` is `2`
- **AND** `clusters` lists, in this order, each `ASSERTION_FAILURE` with `affected_count: 1` and message `AssertionError: Expected values to be strictly equal: 0 !== 1`: `c_20e326b9` with `top_frame` `same-name.test.js:4:36` and `sample_tests` `["handles empty @4"]`, and `c_0044f190` with `top_frame` `same-name.test.js:7:36` and `sample_tests` `["handles empty @7"]`; no cluster names `add` or `remove`
- **AND** `dot-test-digest --no-jev --tdd-phase=red --scope-id=same-tap -- node --test same-name.test.js` exits `0` and `state-same-tap.json` has `baseline` equal to `same-name.test.js::handles empty @4` and `same-name.test.js::handles empty @7` (in any order)

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

### Requirement: Red-phase verdicts and exit codes for node --test (TAP) do not regress
With `node --test` and its default (TAP) reporter, the TDD gate SHALL keep the verdicts in the README's red-phase table and SPEC-002 §4.3 (INV-5), and the exit code SHALL stay transparent outside an `INVALID_RED` block (INV-3). Each scenario runs in a fresh copy of `tests/fixtures/node-cart/` with `DOT_TEST_DIGEST_HOME` set to a temporary directory.

#### Scenario: Assertion failures are VALID_RED with exit 0 and the baseline holds canonical ids
- **WHEN** `dot-test-digest --no-jev --tdd-phase=red --scope-id=tap-red -- node --test cart.test.js` runs
- **THEN** the exit code is `0`, stdout is one line of at most 160 bytes starting with `[VALID_RED | RED] 2 passed, 4 failed in `
- **AND** `state-tap-red.json` has `baseline` equal to `cart.test.js::discount 10% leaves 90%`, `cart.test.js::total with 10% off`, `cart.test.js::total with 100% off is free`, `cart.test.js::first of an empty cart is undefined` (in any order)

#### Scenario: A missing module is INVALID_RED with exit 64
- **WHEN** `dot-test-digest --no-jev --tdd-phase=red -- node --test missing-module.test.js` runs
- **THEN** the exit code is `64`, stdout contains `INVALID_RED` and `SYNTAX_IMPORT_ERROR`, and stderr contains `Test failed due to syntax or unresolved module import rather than a behavioral assertion.`

#### Scenario: A missing export is VALID_RED with exit 0
- **WHEN** `dot-test-digest --no-jev --tdd-phase=red -- node --test missing-export.test.js` runs
- **THEN** the exit code is `0` and stdout starts with `[VALID_RED | RED]`

#### Scenario: A test that already passes is INVALID_RED with exit 64
- **WHEN** `dot-test-digest --no-jev --tdd-phase=red -- node --test passing.test.js` runs
- **THEN** the exit code is `64`, stdout contains `INVALID_RED`, and stderr contains `New test passed before implementation; expected a failing behavioral assertion.`

#### Scenario: Without a TDD phase the child's exit code passes through
- **WHEN** `dot-test-digest --no-jev -- node --test cart.test.js` and `dot-test-digest --no-jev -- node --test passing.test.js` run
- **THEN** their exit codes are `1` and `0`, equal to those of `node --test cart.test.js` and `node --test passing.test.js` run directly, and the passing run prints one line of at most 160 bytes starting with `[PASS] 1 passed, 0 failed in `

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

