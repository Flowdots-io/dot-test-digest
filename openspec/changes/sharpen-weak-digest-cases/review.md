---
verdict: reject
reviewer_model: "opus"
author_model: "opus"
reviewer_run: "review-20261101T1520-m2xz"
author_run: "spec-20261101T1450-rev1"
spec_hash: "ac2ced02577a0381b81585db1655ce88b3487a6846d3b1b1c9ca8c481a720955"
reviewed_at: "2026-11-01T14:05:14Z"
round: 2
---

## Intent

Fix the weak cases that the README's own measurements expose, so the digest is never worse than the raw output it replaces: `node --test` failures merged into one cluster or not recognised at all, a digest larger than the raw output for a small `tsc` run, and clusters past the first few hidden or silently dropped. The work follows dotstack's spec-then-implement procedure.

## Reasons

1. **The fixtures behind the hard-coded scenario values live only in `/tmp`, are not in the spec, and the task's fallback points at sources that do not exist.**
   - **Where.** Five scenarios depend on fixture contents that are defined only by reference to `/tmp/dtd-work/`:
     - `specs/node-tap-diagnostics/spec.md`: the requirement text (line 13), "The cart run with the default (TAP) reporter yields four distinct clusters", "Each node failure gets a SignalWindow from the right file" and "A recorded TAP log parses to the same records at the adapter seam".
     - `specs/node-spec-reporter/spec.md`: every cart scenario, and "A recorded spec log parses at the adapter seam".
     - `specs/bounded-vs-raw-size/spec.md`: "Five tsc errors print the raw diagnostics under the header", "The JSON envelope of the same run is unchanged" and "Level 5 has no footer even when --max-clusters cut clusters".
   - **What they depend on.** All of these scenarios assert exact values that are fixed by the bytes of `cart.js`, `cart.test.js`, `src/a.ts`, `src/b.ts` and `tsc.log`: the cluster ids (`c_9721831d`, `c_42a23d40`, ...), the `top_frame` columns (`cart.test.js:7:46`, `cart.js:5:42`), the window rows, the 419 bytes, the 589-byte level-4 body, and the raw ranges `15-39` / `18-37`. The spec defines those files only as "copied byte for byte from `/tmp/dtd-work/...`".
   - **Why that blocks.** `/tmp/dtd-work` is a volatile scratch directory outside the repository.
     - Task 1.1 says "If `/tmp/dtd-work` is gone, regenerate the project from the sources quoted in the spec". That is false. The spec quotes only `cart.js` lines 3 to 5, `cart.test.js` line 7 and the first line of `tsc.log`. It does not quote `cart.js` lines 1 and 2, the rest of `cart.test.js`, `src/a.ts`, `src/b.ts`, `tsconfig.json`, or `tsc.log` lines 2 to 5.
     - Task 2.3 has the same dependency on `/tmp/dtd-work/tscproj/`.
     - Once that directory is gone, nobody can rebuild the GIVEN of these scenarios from the contract, so a test cannot be written to the stated values.
   - **Related wording error.** The requirement text, both log scenarios, the proposal's Impact and the design's Defaults chosen still call these files "the README measurement project" and "the README run". The proposal and the design's Context correctly say they are smaller scratch projects (6 tests, 5 tsc errors), not the README's (26 tests, 6 errors).
   - **Fix.**
     - Quote the exact contents in the spec, as is already done for `suite.test.js` and `same-name.test.js`. That means `cart.js` (355 B), `cart.test.js` (636 B), `package.json`, `tsc-small/src/a.ts`, `src/b.ts`, `tsconfig.json` and all 5 lines of `tsc.log`.
     - For the two recorded logs, either quote them, or state the command that regenerates them (`node --test [--test-reporter=spec] cart.test.js` in the fixture copy, Node 22.23.4, path replaced by `__ROOT__`). In the second case, say which asserted values must survive regeneration (raw ranges and counts) and which are only descriptive (the byte totals).
     - Correct task 1.1's fallback sentence and the "README measurement project/run" wording.

## Notes

The checklist and the round 1 reasons:

- **Gate.** `openspec validate sharpen-weak-digest-cases --strict` exits 0.
- **Round 1 reasons.** All five are genuinely resolved:
  1. The footer applies at levels 1 to 4 only. A new `--max-clusters=2` tsc scenario pins level 5 with no footer. I recomputed the level-4 body at exactly 589 B, which is more than R = 419.
  2. Whitespace collapse is now in both message rules and in the design. Under both reporters, the deep-equal text normalises to the expected message.
  3. Each reporter has a two-crashing-file scenario. I checked the real Node 22.23.4 output: the TAP position rule and the spec path rule each pick the right error line for each file, both error blocks are on stdout, and stderr is empty.
  4. Colliding leaf names get the `@<line>` suffix. `c_20e326b9` and `c_0044f190` match `computeFingerprint`, and the `location:` / `test at` lines give 4 and 7.
  5. The INV-2 "exactly once" to "at most once" amendment is stated in the proposal, in a design decision, in Defaults chosen and in task 3.3. The claim "no invariant is relaxed" is gone.
- **Claims checked by running code** (Node v22.23.4, built v0.1.2 binary, copies of `/tmp/dtd-work`):
  - **Cluster ids.** `c_42febbe1`, `c_11eac407` and the four cart ids match `computeFingerprint`.
  - **Byte counts.** `string-diff.test.js` is 131 B and `same-name.test.js` is 256 B. The truncated log is 14 lines and 348 B. `raw-spec.txt` is 91 lines and 3,396 B, and `raw-default.txt` is 3,710 B. The TAP ranges 15-39 through 93-111 and the spec ranges 18-37 through 81-91 hold.
  - **Ladder.** H = 73, then 604, 283, 253, 168 and 133 B. The thresholds pick the stated levels.
  - **Budget scenario.** 3 blocks plus the 2 listed lines take 557 tokens and 4 blocks take 707, for any `duration_ms`.
  - **tsc v0.1.2 JSON.** With `--max-clusters=2` it gives `c_42a23d40`/`L1-L1` and `c_39d5c117`/`L2-L2`. The level-4 body for 5 clusters is 574 B, more than 419, so the run lands on level 5.
  - **v0.1.2 behaviours quoted in the spec.** TAP with two crashing files gives 3 clusters and misattributes the error. The spec reporter with two files gives `INVALID_RED`, `0 failed`, `UNSTRUCTURED_BUILD_ERROR`. A failure with no output gives 1 cluster. `boom` is printed twice. The raw log for `boom` is exactly `boom\n`.
  - **Non-node TAP block.** The block without `failureType:` gives `AssertionError: expected 99 to be 100` and `ASSERTION_FAILURE`.
  - **Classifier and gate.** The classifier checks missing export before the syntax tokens, so the two-file red run is INVALID_RED in `tdd-gate.ts`.
- **Testability and seams.** All 51 scenarios have concrete triggers and values at the four seams named in design.md: the CLI, `formatEnvelope`, `dedupeFailures` and `runGear0`. Apart from reason 1, none could be passed by a stub.
- **Coverage and consistency.** Sad paths are covered: empty output, a tiny raw output, a cut stream, non-node TAP, collisions, timeouts and suites. Defaults chosen records every product call I found.
- **Principles.** `spec-is-the-contract` is respected except for reason 1. `exit-code-transparency`, `pass-state-ceiling` and `invalid-red-exits-64` are covered by passthrough, one-liner and red-phase scenarios under both reporters. The INVALID_RED red-phase runs keep `SYNTAX_IMPORT_ERROR` visible: their R (1,064 to 2,062 B) keeps them at levels 1 to 4. No principle file is added, so the proof check does not apply.
- **Blast radius.** I grepped `formatEnvelope`, `renderFailBody`, `dedupeFailures`, `maxClusters`, `more clusters`, `pruned_stack` and `top_frame` in `tests/`, `scripts/acceptance/` and `src/`. The existing compact-md assertions survive:
  - envelope.spec's blocks, the budget test and the INVALID_RED test have no `rawText`, so they render at level 1.
  - The `tests/cli.spec.ts` unresolved-import test asserts only `INVALID_RED`, which the header keeps at every level.
  - The CT-2 and CT-3 raw outputs are large.
  - Hiding the duplicate stack row breaks no assertion.
- **Tasks.** The graph is well formed: every id exists, there are no cycles, and 1.1 and 2.1 are the roots. All 51 scenarios are owned exactly once. The shared test file `tests/size-and-omission.spec.ts` has the edge 3.1 to 2.3.

Non-blocking:
- **Request text.** The proposal's quoted request text ends "Draft a spec." The verbatim request ends "Draft a spec and implement using dotstack's procedures." Quote it exactly.
- **`boom` header.** "A tiny unstructured failure prints the header and the raw line" does not pin the header with a regex, unlike the empty-output scenario. Add `^\[BUILD_ERROR\] 0 failed, 0 passed in \d+ms \| 1 cluster \| log: \S+\.log$`.
- **Path-dependent byte counts.** The design table's "digest 1,538 B" depends on the log path. `dig-tsc.txt` is 1,540 B. Task 3.2 re-measures anyway.
- **Adapter-seam test files.** At the adapter seam, the TAP log yields the test file `tests/fixtures/node-cart/cart.test.js` and the spec log yields `cart.test.js`. Both follow the rule as written. Parity is only claimed for CLI runs, but a sentence saying so would help.
