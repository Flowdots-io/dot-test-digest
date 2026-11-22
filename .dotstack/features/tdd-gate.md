# TDD gate

`--tdd-phase` checks that a test-first loop is honest. In `red`, the run is valid only if the test fails for a behavioral reason (an assertion, a missing export under test); a passing test, a syntax error, a broken import or a runner crash is `INVALID_RED` and exits 64. `green` and `refactor` compare against the failing tests recorded at red, and must have run at least one test: an exit-0 run with no passed or failed test recognised is `INVALID_GREEN` (exit 64, state unchanged) unless `--allow-no-tests` is passed.

## Sub-features

- `tdd-red-valid` an assertion failure is `VALID_RED`, exit 0, baseline recorded.
- `tdd-red-passing` a passing test is `INVALID_RED`, exit 64.
- `tdd-red-import` a missing module is `INVALID_RED`, exit 64.
- `tdd-red-export` a missing export under test is `VALID_RED`, exit 0.
- `tdd-green` after the fix, `[PASS | GREEN]` with `delta: +1 newly passing, 0 regressions`.
- `tdd-refactor` `[PASS | REFACTOR]`, and `REGRESSION_DETECTED` when a test breaks.
- `tdd-green-empty` a green or refactor run that ran no test is `INVALID_GREEN`, exit 64, no state written.
- `tdd-allow-no-tests` `--allow-no-tests` turns that run into `[PASS | GREEN] exit 0`.
- `tdd-state` the baseline is stored in `state-<scope-id>.json`.

## How to get to it (user POV)

- Run `dot-test-digest --tdd-phase=red -- <test command>` after writing a new test, then `--tdd-phase=green` after the fix, then `--tdd-phase=refactor` while restructuring.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test; `W=$(cat .acceptance/verify/$RUN/workdir)/node-cart`.
- Every journey uses its own `--scope-id`, because the default scope is the working directory.
- Prod: not safe (writes logs and a state file under the run's isolated cache home).

- **Valid red.** `$V drive $RUN red-valid node-cart --scope-id=a --tdd-phase=red -- node --test cart.test.js`. Exit `0`; header `[VALID_RED | RED] 2 passed, 4 failed in <t>ms | log: <path>`.
- **Invalid red, passing test.** `$V drive $RUN red-pass node-cart --scope-id=b --tdd-phase=red -- node --test passing.test.js`. Exit `64`; header `[INVALID_RED | RED] 0 failed, 1 passed ... | 0 clusters`; stderr `New test passed before implementation; expected a failing behavioral assertion.`
- **Invalid red, broken import.** `$V drive $RUN red-import node-cart --scope-id=c --tdd-phase=red -- node --test missing-module.test.js`. Exit `64`; `[INVALID_RED | RED]`, cluster kind `SYNTAX_IMPORT_ERROR`, message `Cannot find module '.../missing.js' imported from ...`.
- **Missing export is a valid red.** `$V drive $RUN red-export node-cart --scope-id=d --tdd-phase=red -- node --test missing-export.test.js`. Exit `0`; `[VALID_RED | RED]`.
- **Full cycle.** Write a failing test in the fixture copy: `printf 'import test from "node:test";\nimport assert from "node:assert/strict";\ntest("wip", () => assert.equal(1, 2));\n' > $W/wip.test.js`. Then `$V drive $RUN cyc-red node-cart --scope-id=cyc --tdd-phase=red -- node --test wip.test.js` (exit `0`, `[VALID_RED | RED] 0 passed, 1 failed`). Read the state: `cat .acceptance/verify/$RUN/home/state-cyc.json` has `"baseline": ["wip.test.js::wip"]`. Make it pass: `sed -i 's/assert.equal(1, 2)/assert.equal(1, 1)/' $W/wip.test.js`, then `$V drive $RUN cyc-green node-cart --scope-id=cyc --tdd-phase=green -- node --test wip.test.js`: exit `0`, `[PASS | GREEN] 1 passed, 0 failed (delta: +1 newly passing, 0 regressions)`.
- **Refactor.** Same scope: `$V drive $RUN cyc-ref node-cart --scope-id=cyc --tdd-phase=refactor -- node --test wip.test.js` gives exit `0`, `[PASS | REFACTOR] ... (delta: +0 newly passing, 0 regressions)`. Break it again (`sed -i 's/assert.equal(1, 1)/assert.equal(1, 2)/' $W/wip.test.js`) and re-run: exit `1`, header `[REGRESSION_DETECTED | REFACTOR] 1 failed, 0 passed`.
- **Green that ran nothing.** `$V drive $RUN green-empty node-cart --scope-id=g1 --tdd-phase=green -- node -e 'process.exit(0)'`. Exit `64`; header `[INVALID_GREEN | GREEN] 0 passed, 0 failed in <t>ms | log: <path>`; stderr `Command exited 0 but no passing test was recognized; a green run must run at least one test (pass --allow-no-tests to accept it).`; `ls .acceptance/verify/$RUN/home/state-g1.json` fails (no state). The same with `--tdd-phase=refactor --scope-id=g2` gives `[INVALID_GREEN | REFACTOR]`, and a file whose only test is skipped (`printf 'import test from "node:test";\ntest("s", { skip: true }, () => {});\n' > $W/skip.test.js`, then `--scope-id=g3 --tdd-phase=green -- node --test skip.test.js`) is `INVALID_GREEN` too.
- **Opt out.** `$V drive $RUN green-allow node-cart --scope-id=g5 --tdd-phase=green --allow-no-tests -- node -e 'process.exit(0)'`. Exit `0`; header `[PASS | GREEN] exit 0 in <t>ms | log: <path>`.
- **Green that fails.** `$V drive $RUN green-fail node-cart --scope-id=e --tdd-phase=green -- node --test cart.test.js`. Exit `1` (the child's code), header `[FAIL | GREEN] 4 failed, 2 passed`.

## Gotchas

- Exit `64` is `INVALID_RED` or `INVALID_GREEN` here but also the usage-error code ([cli-surface.md](./cli-surface.md)); a usage error prints nothing on stdout.
- Reusing a `--scope-id` or the default scope across journeys leaks the baseline: a later run reports a bogus `delta` (observed: `+1 newly passing, 1 regressions` on a fresh red).
- The red table for `node --test` was measured on Node 22.23.4; the unreadable-file rows need a non-root user (root can read a `chmod 000` file) and are not part of this map.
- The header cluster count for `[VALID_RED | RED]` is omitted: it is a one-line digest.
