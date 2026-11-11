Ticket: none (request text: "do a delta spec for the cases you discovered and get to implement and test the solution. No spec review agents please.")

## Why

PR #5 (`sharpen-weak-digest-cases`) and its follow-up PR #6 shipped the node `--test` grammar, the size ladder and the omitted-cluster listing. Four rounds of independent review, an edge-case sweep and hand-driven runs (2026-11-10, Node v22.23.4, `--no-jev`) found cases the approved spec either allowed or did not cover. Each one was reproduced with a real run:

1. **Size rule drops to one full block (spec defect).** 30 distinct `tsc` errors, `--max-clusters=5`: v0.1.2 printed 5 full blocks (1,025 bytes); the shipped rule prints 1 full block, `+29 more clusters` and 19 listed lines (2,365 bytes) because every listed line is counted while the number of full blocks is decided. The README documents it as a limitation.
2. **`fits` allows 2,400 bytes, the cut is at 2,399**, so a listing that fills the budget exactly is cut mid-line and ends in `...`.
3. **A crashed file takes the wrong error under TAP.** A setup line such as `Error: config.json not found, using defaults` printed above the crash wins over the real `Cannot find module` error: `VALID_RED`/0 under TAP, `INVALID_RED`/64 under spec.
4. **A crashed file in a later run of a multi-run spec stream loses its error**: its block is printed after the first `✖ failing tests:` section, which the spec only searched before. A missing export in the second run is `INVALID_RED`/64 under spec and `VALID_RED`/0 under TAP.
5. **A syntax-error block is not attributed to its file under the spec reporter** when blank lines separate its `file://...:3` line from `SyntaxError:`: message `test failed` instead of `SyntaxError: Unexpected end of input`.
6. **A test file the runner cannot read** (`chmod 000`) is `VALID_RED`/0 under both reporters although no test ran (INV-5: runner startup crash).
7. **Cluster ids differ between the reporters** for the same failure: a plain `throw new Error('z')` is `z` under TAP and `Error: z` under spec (same for hook errors and rejected promises); a test name containing a backslash keeps `\\` under TAP; string diffs quoted with backticks keep them under spec but not under TAP.

## What Changes

- Omitted-cluster budget order: the number of full blocks is the number that fit together with the header and the `+N more clusters (see log)` line (the v0.1.2 count, at least one); listed lines then fill what is left; unlisted clusters stay counted in `N`. Size is measured against one limit: the digest, final newline included, is at most 2,400 bytes and 600 EstimatedTokens, and no listed line is cut.
- One error-attribution rule for a crashed file under both reporters: the message is the first `<Name>Error` line inside the crash block that node prints directly above the file's own entry (from the last location-only line to the `Node.js v<version>` trailer); nothing outside that block is used, so setup logs, other files' logs and errors naming a sibling module cannot stand in for it. No block or no error line in it: `test failed`.
- A crashed file whose error is a read failure on the test file itself (`EACCES` or `EPERM` whose text contains that file's absolute path in single quotes) is `SYNTAX_IMPORT_ERROR` (invalid red); a read failure of any other file at load is not.
- Parity details: a TAP `testCodeFailure` or `hookFailed` block with a `stack:` key and no `name:` key reads as `Error: <text>` (`Error` when empty); `\\` in a TAP test name is unescaped; spec diffs unquote backtick strings.
- README: the many-omitted-clusters limitation is replaced by the new behaviour; SPEC-002 §4.1.1 and §4.2.3 follow.
- No ceiling is raised (INV-1 160 bytes, INV-2 600 tokens / 2,400 bytes), INV-3 exit codes are untouched, INV-5 verdicts move only toward what INV-5 already says. `--format=json` is unchanged.

## Capabilities

### New Capabilities
<!-- none -->

### Modified Capabilities
- `omitted-cluster-visibility`: budget order and byte limit of the omitted-cluster listing.
- `node-tap-diagnostics`: error attribution for a crashed file, unreadable files, plain `Error` and backslash parity.
- `node-spec-reporter`: error attribution (position rule, multi-run streams), unreadable files, backtick diffs.

## Impact

- Code: `src/formatters/envelope.ts`, `src/adapters/node-test.ts`; tests `tests/node-test.spec.ts`, `tests/size-and-omission.spec.ts`, `tests/envelope.spec.ts`; `README.md`, `specs/SPEC-002-DOT-TEST-DIGEST.md`.
- Behaviour: in a `compact-md` failure with more than `--max-clusters` clusters the digest shows more full blocks than before this change when about 20 or more clusters are omitted (back to the v0.1.2 count). A crashed node file with no attributable error stays `test failed`/`INVALID_RED`.

## Out of scope (known limitations that remain)

A file that throws at load with a printed non-module error (`TypeError: x is not a function`) stays `VALID_RED`; a TAP stream cut before its summary; TAP escapes other than `\\` and `\#`; multi-line test names; a spec name containing `(200ms) #`; fake count lines printed by tests; the TAP diff row for nested values and the spec diff for objects (cosmetic); `--experimental-test-isolation=none`.
