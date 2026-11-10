## 0. Ordering and lanes

Two lanes share no file and run in parallel; each is serial inside itself. Section 3 waits for both. Every task is test first: write the scenario's test, watch it fail for the predicted reason, then change the code.

- Lane A (1.x): `src/adapters/node-test.ts`, `tests/node-test.spec.ts`, `tests/fixtures/node-cart/plain.test.js`.
- Lane B (2.x): `src/formatters/envelope.ts`, `tests/envelope.spec.ts`, `tests/size-and-omission.spec.ts`.
- First frontier: 1.1 and 2.1.

## 1. Lane A: node attribution and parity

- [x] 1.1 One attribution rule for a crashed file under TAP (superseded by 4.1)
  - scenarios: "A log line above the crash is not mistaken for the file's error", "A syntax error in a test file is attributed to that file under TAP"
  - blocked-by: none
  - Shared function: first error line at or after the last line that mentions the file, else the first error line. Applied to the TAP comment run.

- [x] 1.2 The same rule under the spec reporter, position first, multi-run streams
  - scenarios: "A syntax error block with blank lines is attributed to its file", "A crashed file in a later run of a multi-run stream keeps its error"
  - blocked-by: 1.1
  - Lines between the previous tree row and the file's own `✖ <file>` row; fall back to the path rule and the lone rule over every line outside all failing-tests sections.

- [x] 1.3 Unreadable test file is invalid red (amended: EACCES/EPERM naming the test file's quoted path, no EISDIR)
  - scenarios: "An unreadable test file is INVALID_RED with exit 64", "An unreadable test file is INVALID_RED with exit 64 under the spec reporter"
  - blocked-by: 1.2
  - `errorKindOf`: a crashed file whose subprocess error starts `Error: EACCES|EPERM|EISDIR` is `SYNTAX_IMPORT_ERROR`. Tests skip when `process.getuid?.() === 0`.

- [x] 1.4 Reporter parity details
  - scenarios: "Plain errors and hook errors read as Error under both reporters", "A test name with a backslash is the same under both reporters", "A backtick string diff equals the TAP diff"
  - blocked-by: 1.3
  - Adds `tests/fixtures/node-cart/plain.test.js`.

## 2. Lane B: omitted-cluster budget (`src/formatters/envelope.ts`)

- [x] 2.1 Blocks first with the footer line reserved, then the listing, one byte limit
  - scenarios: "Many omitted clusters do not take blocks away from the kept ones", "The more-clusters line survives a block that alone exceeds the limit", "A listing that fills the limit exactly is not cut mid-line"
  - blocked-by: none
  - Also re-measures the existing scenarios whose numbers depend on the limit ("When the listing itself does not fit, the tail is only counted", "Each level is chosen at its exact threshold", the volume tests) and corrects the scenario text in this change if a number moves.

## 3. Docs (after lanes A and B)

- [x] 3.1 README, SPEC-002 and the evidence limits
  - scenarios: none (documentation)
  - blocked-by: 1.4, 2.1
  - README "Things to know": replace the many-omitted-clusters limitation with the new behaviour and re-measure (30 `tsc` errors, `--max-clusters=5`) from a throwaway build; add the red-phase rows; SPEC-002 §4.1.1 budget text and §4.2.3 attribution text with a revision row.

## 4. Round 2: crash block attribution (after review of 921a5f6 and 9613252)

- [x] 4.1 One crash-block rule for both reporters
  - scenarios: "A crash that does not name the test file keeps its own block", "A load-time throw of a non-error is an unattributed startup crash", "A startup crash is not blamed on another file's log under TAP", "A startup crash is not blamed on another file's log, in either file order", "The same file crashing in two runs keeps each run's own error", "A read failure of a sibling file whose name starts like the test file stays a behavioural red"
  - blocked-by: none
  - Replace `fileError`, the path-block and lone-crash fallbacks, `ownRunBlocks` and `linesAboveFileRow` by one function over the lines above the entry; the n-th crashed entry of a name takes the n-th row of that name; read failure needs the quoted absolute path.

- [ ] 4.2 Crash-block regressions found by the round-4 review
  - scenarios: "A load-time error in a path with a space, in eval code, or after a partial line keeps its error", "A file whose tests ran and then failed on a late error is not a startup crash", "An unreadable test file reached through a symlinked directory is INVALID_RED", "An uncaught exception in a timer reads the same under both reporters"
  - blocked-by: 4.1
  - Location line = a non-indented line that is not an error line and ends in `:<N>`; async-activity diagnostic as the no-block message; symlink-resolved path for the read-failure check; `uncaughtException` joins the nameless-error prefix rule.
