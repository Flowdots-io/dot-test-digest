## 0. Ordering and lanes

Two lanes run in parallel. Each lane is serial inside itself because its tasks write the same files. Section 3 waits for both. Every task is test first: write the scenario's test, watch it fail for the predicted reason, then change the code.

- Lane A (items 1.x): `src/adapters/js-test.ts`, `tests/adapters.spec.ts`, new `tests/helpers/node-cart.ts`, new `tests/node-test.spec.ts`, `tests/fixtures/node-cart/`, `tests/fixtures/logs/node-*.log`. Serial, because every task edits `js-test.ts`.
- Lane B (items 2.x): `src/pruner/cluster-dedup.ts`, `src/formatters/envelope.ts`, `src/index.ts`, `tests/dedup-and-tdd.spec.ts`, `tests/envelope.spec.ts`, new `tests/size-and-omission.spec.ts`, `tests/fixtures/tsc-small/`, `tests/fixtures/logs/tsc-12.log`. Serial, because 2.1 to 2.3 share `tests/size-and-omission.spec.ts`, and 2.2 and 2.3 both edit `envelope.ts` and `index.ts`.
- Lanes A and B share no source or test file. Task 3.1 adds tests to the lane B file `tests/size-and-omission.spec.ts` and imports, without editing, the lane A helper `tests/helpers/node-cart.ts`.
- First frontier: 1.1 and 2.1. Waves: {1.1, 2.1}, {1.2, 2.2}, {1.3, 2.3}, {1.4, 3.1}, {1.5}, {1.6}, {3.2, 3.3}, {4.1}, {4.2}.

## 1. Lane A: node --test grammar (`src/adapters/js-test.ts`)

- [x] 1.1 Prefactor: add the node fixtures and the shared CLI test helper
  - scenarios: none (prefactor: fixtures and a test helper that every later lane A task and 3.1 use)
  - blocked-by: none
  - Add `tests/fixtures/node-cart/{cart.js,cart.test.js,package.json}` with the exact contents quoted in `design.md` "Fixtures (authoritative contents)". Add `suite.test.js`, `same-name.test.js`, `string-diff.test.js`, `missing-module.test.js`, `missing-export.test.js` and `passing.test.js` with the exact contents given in `specs/node-tap-diagnostics/spec.md` and `specs/node-spec-reporter/spec.md`. Add `tests/fixtures/logs/node-tap-cart.log` and `node-spec-cart.log` from `raw-default.txt` / `raw-spec.txt` with `/tmp/dtd-work/nodetest` replaced by `__ROOT__`, and `node-spec-truncated.log` = the first 14 lines of `node-spec-cart.log` (348 bytes). Add the shared helper `tests/helpers/node-cart.ts`: it copies `node-cart` to a temp dir, chdirs there, sets `DOT_TEST_DIGEST_HOME` to a temp dir and runs `main([...flags, "--", process.execPath, "--test", ...args])`, returning stdout, stderr, the exit code and the home dir. No test file imports another test file. `/tmp/dtd-work` is not needed: the sources are quoted in `design.md` and the recorded logs are regenerated with the commands given there.

- [x] 1.2 TAP diagnostic blocks: one failure per failing test
  - scenarios: "The cart run with the default (TAP) reporter yields four distinct clusters", "Each node failure gets a SignalWindow from the right file", "The compact-md digest of the cart run no longer merges the failures", "A recorded TAP log parses to the same records at the adapter seam", "A TAP block without a failureType key keeps the v0.1.2 behavior"
  - blocked-by: 1.1
  - A block takes the node path only when it has a top-level `failureType:` key. Messages: lines trimmed, joined by one space, internal whitespace runs collapsed. Diff scalars unquoted.

- [x] 1.3 TAP counts, suites, timeouts and same-name collisions
  - scenarios: "Nested suite with a deep-equal failure and a timeout", "Two same-named failing tests in one file stay two failures under TAP"
  - blocked-by: 1.2
  - Same-name suffix ` @<line>` from `location:`, applied in the adapter after suite rows are excluded and only to leaf names shared by two or more failures of one file.

- [x] 1.4 TAP file-level failures and the TAP red-phase guards
  - scenarios: "A missing module is one SYNTAX_IMPORT_ERROR failure", "A missing export is a RUNTIME_EXCEPTION failure, not a syntax error", "Two crashing files under TAP each carry their own subprocess error", "Assertion failures are VALID_RED with exit 0 and the baseline holds canonical ids", "A missing module is INVALID_RED with exit 64", "A missing export is VALID_RED with exit 0", "A test that already passes is INVALID_RED with exit 64", "Without a TDD phase the child's exit code passes through"
  - blocked-by: 1.3
  - Position rule: the comment run between the previous top-level entry's closing `...` and the file's `# Subtest: <file>`.

- [x] 1.5 Spec reporter: recognition, counts, failing-tests entries, file-level failures, same-name collisions, cut streams
  - scenarios: "The cart run with the spec reporter is parsed, not reported as BUILD_ERROR", "The spec reporter yields the same clusters as the TAP reporter", "String values in diffs are unquoted under both reporters", "The compact-md digest of the spec run names the failures", "A recorded spec log parses at the adapter seam", "A passing spec run is one line with the real count", "Nested suite and timeout under the spec reporter", "Two same-named failing tests in one file stay two failures under the spec reporter", "A spec run cut before the failing-tests section still yields its failures", "A missing module under the spec reporter is one SYNTAX_IMPORT_ERROR failure", "A missing export under the spec reporter is a RUNTIME_EXCEPTION failure", "Two crashing files under the spec reporter each carry their own subprocess error"
  - blocked-by: 1.4
  - Path rule for subprocess blocks, which does not depend on the stream (node 22.23.4 writes them to stdout). Leaf `✖` rows give failures only when the `✖ failing tests:` section is missing.

- [x] 1.6 Spec-reporter red-phase guards
  - scenarios: "Assertion failures are VALID_RED with the real counts", "A missing module is INVALID_RED with exit 64 and the syntax message", "A missing export is VALID_RED with exit 0 under the spec reporter", "A test that already passes is INVALID_RED with exit 64 under the spec reporter", "Without a TDD phase the child's exit code passes through under the spec reporter"
  - blocked-by: 1.5

## 2. Lane B: size rule and omitted clusters (`envelope.ts`, `cluster-dedup.ts`, `index.ts`)

- [x] 2.1 Numeric source-order tie-break
  - scenarios: "Single-digit lines sort before double-digit lines", "Equal first lines fall back to the last line", "affected_count still ranks first", "--max-clusters keeps the first clusters in source order"
  - blocked-by: none
  - `dedupeFailures` sorts by `affected_count` desc, first line, last line, `cluster_id`. Add `tests/fixtures/logs/tsc-12.log`. The CLI scenario creates `tests/size-and-omission.spec.ts`.

- [x] 2.2 Omitted-cluster footer
  - scenarios: "Clusters beyond --max-clusters are listed instead of silently dropped", "Clusters dropped by the token budget are listed", "When the listing itself does not fit, the tail is only counted"
  - blocked-by: 2.1
  - `formatEnvelope` render context `{ omitted }`, the footer lines, and the budget order (blocks first, then listed lines). `src/index.ts` dedupes uncapped and passes the remainder as `omitted`; `--format=json` stays capped. `dedupeFailures` sorts before reading SignalWindows and reads them only for the first `windowLimit` clusters (new optional `DedupeOptions` field, default `maxClusters`; `index.ts` passes `--max-clusters`). See the design Risk "Uncapped dedupe and SignalWindow reads".

- [x] 2.3 Size rule: five-level ladder, no footer at level 5, hidden duplicate stack row
  - scenarios: "Five tsc errors print the raw diagnostics under the header", "The JSON envelope of the same run is unchanged", "Level 5 has no footer even when --max-clusters cut clusters", "Each level is chosen at its exact threshold", "Without raw text the size rule is not applied", "A failure with no output prints only the header", "A tiny unstructured failure prints the header and the raw line", "Large raw output keeps the full form and INV-2", "The log pointer resolves at every level", "The duplicate row is dropped and the other frames stay"
  - blocked-by: 2.2
  - Render context `{ rawText }`, the five levels, each measured with its own header line, the footer only at levels 1 to 4, and the stack row equal to `top_frame` hidden. `src/index.ts` passes the normalised stream with no line dropped. Add `tests/fixtures/tsc-small/` (copied from `/tmp/dtd-work/tscproj/`; `tsc.log` = `raw-tsc.txt`).

## 3. Integration and docs (after lanes A and B)

- [x] 3.1 Cross-lane CLI scenarios on the real node cart run
  - scenarios: "Every failure of the node cart run is visible somewhere", "--max-clusters on a real run lists the rest and keeps JSON capped"
  - blocked-by: 1.2, 2.3
  - Tests go in `tests/size-and-omission.spec.ts` and use `tests/helpers/node-cart.ts` (from 1.1).

- [ ] 3.2 Re-measure the README from real runs
  - scenarios: none (docs only: measured claims must match the built binary)
  - blocked-by: 1.6, 2.3, 3.1
  - Run `pnpm build`, then run with `--no-jev` and record the Node version. Update only what was measured:
    - the Example: raw and digest bytes/lines and the digest block. If the original vitest cart project is not available, recreate one under `tests/fixtures/vitest-cart/` and say so, with its real test count;
    - the table rows for `node --test` (default/tap), `--test-reporter=spec` and `tsc`;
    - the red-phase table and the note below it about node labels;
    - the "Things to know" bullets: only-3-clusters, omitted clusters, the size rule, and same-name `@<line>` labels.
  - Keep the "grouped by the shape of the error, not by root cause" limitation. No number may be written that was not produced by a run in this task. Keep the raw command lines next to the measurements.

- [x] 3.3 Amend `specs/SPEC-002-DOT-TEST-DIGEST.md` to 0.1.3
  - scenarios: none (docs only: the revision of the product contract)
  - blocked-by: 1.6, 2.3
  - Add the node TAP/spec grammar under §4.2 (new §4.2.3): the `failureType:` selection, message whitespace collapse, the ` @<line>` collision suffix and its limits, file-level subprocess errors, and streams cut before the failing-tests section.
  - Add the size rule and its levels under §4.1.1, with the footer at levels 1 to 4 only. Add INV-2's omission listing, the `--max-clusters` counting, and the tie-break.
  - Amend INV-2's "showing the stack trace and `SignalWindow` exactly once" to "at most once (never repeated); in `compact-md` the size rule may omit them when the digest would otherwise be larger than the raw output; `--format=json` always carries them".
  - Amend §4.2's SignalWindow inliner sentence so the window is attached to every cluster in the envelope and rendered in `compact-md` unless the size rule omits it.
  - Add a revision-history row that says exactly this: no ceiling is raised (INV-1's 160 bytes, INV-2's 600 EstimatedTokens / 2,400 bytes), INV-3's exit codes and INV-5's gate verdicts are unchanged, and INV-2's "exactly once" (and the §4.2 inliner sentence) is amended to "at most once" for `compact-md`.

## 4. Verification

- [ ] 4.1 Full verify
  - scenarios: none (gate: every scenario above, plus the existing suite)
  - blocked-by: 3.1, 3.2, 3.3
  - `pnpm verify` (typecheck + all tests) is green, including the existing `tap grammar` test, CT-1..CT-6, `tests/bin-entry.spec.ts` and `tests/envelope.spec.ts`.

- [ ] 4.2 Validate the change
  - scenarios: none (gate)
  - blocked-by: 4.1
  - `openspec validate sharpen-weak-digest-cases --strict` exits 0.
