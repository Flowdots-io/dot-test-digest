## 0. Ordering and lanes

Two lanes run in parallel; each lane is serial inside itself because its tasks write the same files. Section 3 waits for both. Each task is test first: write the scenario's test, watch it fail for the predicted reason, then change the code.

- Lane A (items 1 and 2): `src/adapters/js-test.ts`, `tests/adapters.spec.ts`, new `tests/node-test.spec.ts`, `tests/fixtures/node-cart/`, `tests/fixtures/logs/node-*.log`. Serial, because every task edits `js-test.ts`.
- Lane B (items 3 and 4): `src/pruner/cluster-dedup.ts`, `src/formatters/envelope.ts`, `src/index.ts`, `tests/dedup-and-tdd.spec.ts`, `tests/envelope.spec.ts`, new `tests/size-and-omission.spec.ts`, `tests/fixtures/tsc-small/`, `tests/fixtures/logs/tsc-12.log`. Serial, because 2.1 to 2.3 share `tests/size-and-omission.spec.ts` and 2.2 and 2.3 both edit `envelope.ts` and `index.ts`.
- Lanes A and B share no source or test file.
- First frontier: 1.1 and 2.1. Waves: {1.1, 2.1}, {1.2, 2.2}, {1.3, 2.3}, {1.4, 3.1}, {1.5}, {1.6}, {3.2, 3.3}, {4.1}, {4.2}.

## 1. Lane A: node --test grammar (`src/adapters/js-test.ts`)

- [ ] 1.1 Prefactor: add the node fixtures and the CLI test helper
  - scenarios: none (prefactor: fixtures and a test helper that every later lane A task and 3.1 use)
  - blocked-by: none
  - Add `tests/fixtures/node-cart/{cart.js,cart.test.js,package.json}` copied byte for byte from `/tmp/dtd-work/nodetest/`; `suite.test.js`, `missing-module.test.js`, `missing-export.test.js`, `passing.test.js` with the exact contents in `specs/node-tap-diagnostics/spec.md`; `tests/fixtures/logs/node-tap-cart.log` and `node-spec-cart.log` from `raw-default.txt` / `raw-spec.txt` with `/tmp/dtd-work/nodetest` replaced by `__ROOT__`. Add the helper in `tests/node-test.spec.ts` that copies `node-cart` to a temp dir, chdirs there and runs `main([...flags, "--", process.execPath, "--test", ...args])`. If `/tmp/dtd-work` is gone, regenerate the project from the sources quoted in the spec.

- [ ] 1.2 TAP diagnostic blocks: one failure per failing test
  - scenarios: "The cart run with the default (TAP) reporter yields four distinct clusters", "Each node failure gets a SignalWindow from the right file", "The compact-md digest of the cart run no longer merges the failures", "A recorded TAP log parses to the same records at the adapter seam", "A TAP block without node's keys keeps the v0.1.2 behavior"
  - blocked-by: 1.1

- [ ] 1.3 TAP counts, suites and timeouts
  - scenarios: "Nested suite with a deep-equal failure and a timeout"
  - blocked-by: 1.2

- [ ] 1.4 TAP file-level failures and the TAP red-phase guards
  - scenarios: "A missing module is one SYNTAX_IMPORT_ERROR failure", "A missing export is a RUNTIME_EXCEPTION failure, not a syntax error", "Assertion failures are VALID_RED with exit 0 and the baseline holds canonical ids", "A missing module is INVALID_RED with exit 64", "A missing export is VALID_RED with exit 0", "A test that already passes is INVALID_RED with exit 64", "Without a TDD phase the child's exit code passes through"
  - blocked-by: 1.3

- [ ] 1.5 Spec reporter: recognition, counts, failing-tests entries, file-level failures
  - scenarios: "The cart run with the spec reporter is parsed, not reported as BUILD_ERROR", "The spec reporter yields the same clusters as the TAP reporter", "The compact-md digest of the spec run names the failures", "A recorded spec log parses at the adapter seam", "A passing spec run is one line with the real count", "Nested suite and timeout under the spec reporter", "A missing module under the spec reporter is one SYNTAX_IMPORT_ERROR failure", "A missing export under the spec reporter is a RUNTIME_EXCEPTION failure"
  - blocked-by: 1.4

- [ ] 1.6 Spec-reporter red-phase guards
  - scenarios: "Assertion failures are VALID_RED with the real counts", "A missing module is INVALID_RED with exit 64 and the syntax message", "A missing export is VALID_RED with exit 0 under the spec reporter", "A test that already passes is INVALID_RED with exit 64 under the spec reporter", "Without a TDD phase the child's exit code passes through under the spec reporter"
  - blocked-by: 1.5

## 2. Lane B: size rule and omitted clusters (`envelope.ts`, `cluster-dedup.ts`, `index.ts`)

- [ ] 2.1 Numeric source-order tie-break
  - scenarios: "Single-digit lines sort before double-digit lines", "Equal first lines fall back to the last line", "affected_count still ranks first", "--max-clusters keeps the first clusters in source order"
  - blocked-by: none
  - `dedupeFailures` sorts by `affected_count` desc, first line, last line, `cluster_id`; add `tests/fixtures/logs/tsc-12.log`; the CLI scenario creates `tests/size-and-omission.spec.ts`.

- [ ] 2.2 Omitted-cluster footer
  - scenarios: "Clusters beyond --max-clusters are listed instead of silently dropped", "Clusters dropped by the token budget are listed", "When the listing itself does not fit, the tail is only counted"
  - blocked-by: 2.1
  - `formatEnvelope` render context `{ omitted }`, footer lines, budget order (blocks, then listed lines); `src/index.ts` dedupes uncapped and passes the remainder as `omitted`; `--format=json` stays capped.

- [ ] 2.3 Size rule: five-level ladder and hidden duplicate stack row
  - scenarios: "Five tsc errors print the raw diagnostics under the header", "The JSON envelope of the same run is unchanged", "Each level is chosen at its exact threshold", "Without raw text the size rule is not applied", "A failure with no output prints only the header", "A tiny unstructured failure prints the header and the raw line", "Large raw output keeps the full form and INV-2", "The log pointer resolves at every level", "The duplicate row is dropped and the other frames stay"
  - blocked-by: 2.2
  - Render context `{ rawText }`, the five levels, stack row equal to `top_frame` hidden; `src/index.ts` passes the normalised stream; add `tests/fixtures/tsc-small/` (copied from `/tmp/dtd-work/tscproj/`, `tsc.log` = `raw-tsc.txt`).

## 3. Integration and docs (after lanes A and B)

- [ ] 3.1 Cross-lane CLI scenarios on the real node cart run
  - scenarios: "Every failure of the node cart run is visible somewhere", "--max-clusters on a real run lists the rest and keeps JSON capped"
  - blocked-by: 1.2, 2.3
  - Tests go in `tests/size-and-omission.spec.ts`.

- [ ] 3.2 Re-measure the README from real runs
  - scenarios: none (docs only: measured claims must match the built binary)
  - blocked-by: 1.6, 2.3, 3.1
  - `pnpm build`, run with `--no-jev`, record the Node version. Update only what was measured: the Example (raw and digest bytes/lines and the digest block; if the original vitest cart project is not available, recreate one under `tests/fixtures/vitest-cart/` and say so with its real test count), the table rows for `node --test` (default/tap), `--test-reporter=spec` and `tsc`, the red-phase table and the note below it about node labels, and the "Things to know" bullets (only-3-clusters, omitted clusters, the size rule). No number may be written that was not produced by a run in this task; keep the raw command lines next to the measurements.

- [ ] 3.3 Amend `specs/SPEC-002-DOT-TEST-DIGEST.md` to 0.1.3
  - scenarios: none (docs only: the additive revision of the product contract)
  - blocked-by: 1.6, 2.3
  - Node TAP/spec grammar under §4.2 (new §4.2.3), the size rule and its levels under §4.1.1, INV-2's omission listing and `--max-clusters` counting, the tie-break, and a revision-history row stating that no invariant or ceiling is relaxed.

## 4. Verification

- [ ] 4.1 Full verify
  - scenarios: none (gate: every scenario above, plus the existing suite)
  - blocked-by: 3.1, 3.2, 3.3
  - `pnpm verify` (typecheck + all tests) is green, including the existing `tap grammar` test, CT-1..CT-6, `tests/bin-entry.spec.ts` and `tests/envelope.spec.ts`.

- [ ] 4.2 Validate the change
  - scenarios: none (gate)
  - blocked-by: 4.1
  - `openspec validate sharpen-weak-digest-cases --strict` exits 0.
