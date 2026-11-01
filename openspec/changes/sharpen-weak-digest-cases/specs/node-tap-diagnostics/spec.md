## ADDED Requirements

### Requirement: One failure per failing node test from its TAP diagnostic block
The js-test adapter SHALL turn every `not ok N - <name>` entry of a node TAP stream that is followed by a YAML diagnostic block (`---` ... `...`) into exactly one failure, where:
- the test name is `<name>` (the leaf name; no suite prefix);
- the test file is the path part of `location:` (`<path>:<line>:<col>`), made relative to the working directory;
- the message is the non-blank lines of `error:` (block scalar `|-` or a quoted scalar, unquoted), each trimmed and joined with one space, prefixed with `<name:>: ` when `name:` is present and the text does not already start with it;
- the diff is `{ expected: <expected:>, received: <actual:> }` when both keys are present, using the scalar text as printed, or, for an indented mapping value, its trimmed lines joined with `, `;
- the frames are the lines of `stack:`, each with any `file://` URL replaced by the filesystem path it denotes;
- the raw-log range runs from the `not ok` line to the block's closing `...` line;
- `error_kind` is derived from the message and frames with the existing classifier, so `AssertionError` gives `ASSERTION_FAILURE`, `TypeError` gives `RUNTIME_EXCEPTION`, and `timed out` gives `TIMEOUT_OR_CONN_REFUSED`.

A `not ok` entry without a diagnostic block, or a block without these keys, MUST keep the v0.1.2 behavior, so the existing `tap grammar` test keeps passing. Fixture: `tests/fixtures/node-cart/` holds `cart.js`, `cart.test.js` and `package.json` (`{"type":"module"}`) copied byte for byte from the README measurement project (`/tmp/dtd-work/nodetest/`): 6 tests, of which `discount 10% leaves 90%`, `total with 10% off`, `total with 100% off is free` and `first of an empty cart is undefined` fail.

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
- **GIVEN** `tests/fixtures/logs/node-tap-cart.log`, the README run's TAP output (`/tmp/dtd-work/nodetest/raw-default.txt`, 3,710 bytes) with every `/tmp/dtd-work/nodetest` replaced by `__ROOT__`, and the test replaces `__ROOT__` with `<cwd>/tests/fixtures/node-cart`
- **WHEN** `runGear0` parses its lines
- **THEN** the adapter is `js-test`, counts are `{ passed: 2, failed: 4, skipped: 0 }`, and there are 4 failures with test files `tests/fixtures/node-cart/cart.test.js` and raw ranges `15-39`, `41-65`, `67-91` and `93-111`

#### Scenario: A TAP block without node's keys keeps the v0.1.2 behavior
- **WHEN** `runGear0` parses `not ok 1 - cart totals`, `  ---`, `  error: |-`, `    AssertionError: expected 99 to be 100`, `  ...`, `1..1`, `# tests 1`, `# pass 0`, `# fail 1`
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

### Requirement: A file-level TAP failure carries the error its subprocess printed
When node reports a whole test file as failed (a `not ok` entry whose block has `error: 'test failed'` and an `exitCode:` key), the adapter SHALL use as that failure's message the error line printed by the file's subprocess, which node relays as `# `-prefixed comment lines before the file's `# Subtest:` line: the line matching `<Name>Error[ [CODE]]: <text>` (or `Error[ [CODE]]: <text>`), with the ` [CODE]` tag removed. In a node TAP stream (one containing `# Subtest:`), comment lines MUST NOT create a failure of their own, so the file contributes exactly one failure.

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
