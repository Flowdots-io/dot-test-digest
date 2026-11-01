---
verdict: reject
reviewer_model: "opus"
author_model: "opus"
reviewer_run: "review-20261101T1420-k7qd"
author_run: "spec-20261101T1315"
spec_hash: "930ee3273d56f1bea795d68c1058692fad77fecddb54fd6a91896734d1990d09"
reviewed_at: "2026-11-01T13:45:24Z"
round: 1
---

## Intent

Fix the weak cases that the README's own measurements expose: `node --test` failures merged into one cluster or not recognised at all, a digest larger than the raw output for a small `tsc` run, and clusters past the first few hidden or silently dropped. The goal is a digest that is never worse than the raw output it replaces. The fix goes through dotstack's spec-then-implement procedure.

## Reasons

1. **Two requirements contradict each other at size level 5 with `--max-clusters`.** In `specs/omitted-cluster-visibility/spec.md`, the requirement "Every omitted cluster is listed on one line while INV-2's budget allows" defines a cluster beyond `--max-clusters` as omitted. It then says that when at least one cluster is omitted the body SHALL end with `+N more clusters (see log)` and the listed lines, with no exception for any size level. `specs/bounded-vs-raw-size/spec.md` says level 5 is the header plus the raw stream verbatim (`D = H + R`), and that "level 5 needs none because nothing is omitted". Both cannot hold for the case the proposal itself cites as a bug (Why #4): the five-error `tsc` replay with `--max-clusters=2`. Level 4 for that run (2 one-line entries, the footer and 3 listed lines, about 570 B) is larger than R = 419 B, so the run lands on level 5. There one requirement demands a footer and the other forbids it. No scenario pins the outcome. Fix: say in the omitted-cluster requirement that the footer applies at levels 1 to 4 only (the level 5 raw text shows every failure). Then add a scenario that runs `tests/fixtures/tsc-small/` with `--max-clusters=2`, with exact expectations: header `| 2 clusters |`, then the 419 bytes of `tsc.log`, and no `more clusters` line.

2. **A scenario expects a message that its own requirement does not produce.** The scenario is "Nested suite with a deep-equal failure and a timeout" in `specs/node-tap-diagnostics/spec.md`. The requirement says the message is the non-blank `error:` lines, "each trimmed and joined with one space". The real Node 22.23.4 TAP block for `names match` (I ran it) contains the lines `+   a: 1` and `-   a: 2`, with three spaces inside each. Trimming leaves those spaces, so an implementation that follows the requirement gives `... { +   a: 1 -   a: 2 }`. The scenario expects `... { + a: 1 - a: 2 }`, so a faithful implementation fails the test. Fix one of the two: (a) add "runs of internal whitespace are collapsed to one space" to the TAP message rule, to the spec-reporter message rule in `specs/node-spec-reporter/spec.md` (so the two reporters still agree), and to the design's field mapping and Defaults chosen; or (b) change the expected message to `AssertionError: Expected values to be strictly deep-equal: + actual - expected { +   a: 1 -   a: 2 }`.

3. **No scenario can fail on the main rule for file-level failures.** The rule is in "A file-level spec-reporter failure carries the error its subprocess printed" (`specs/node-spec-reporter/spec.md`) and in "A file-level TAP failure carries the error its subprocess printed" (`specs/node-tap-diagnostics/spec.md`). The spec reporter is meant to match the error to a block that mentions the file's path or `file://` URL. TAP is meant to take the error from the comments before that file's `# Subtest:`. Every scenario (`missing-module`, `missing-export`, under both reporters) runs exactly one crashing file. The spec reporter's fallback ("exactly one file-level failure, the first such line in the stream") passes all of them, and so would a TAP rule of "first error comment anywhere". The path and position rules are never exercised, yet plain `node --test` runs every test file by default. I ran `node --test missing-module.test.js missing-export.test.js` under both reporters: each prints two file-level failures and two separate subprocess error blocks. Fix: add one scenario per reporter for that two-file run. Assert 2 clusters: `missing-module.test.js` as `SYNTAX_IMPORT_ERROR` with a message starting `Error: Cannot find module '`, and `missing-export.test.js` as `RUNTIME_EXCEPTION` with the `does not provide an export named 'applyCoupon'` message. Add a `--tdd-phase=red` assertion too (`INVALID_RED`, exit `64`).

4. **The leaf-name identity default silently drops distinct failures, against the stated goal that "No failure is silent".** Node test names are leaf names, and the identity is `<file>::<leaf>` (requirement text in both node specs, and "Defaults chosen" in `design.md`). SPEC-002 §4.2.2 and `uniqueFailures` keep one record per identity. So two failing tests with the same leaf name under different `describe` blocks in one file (for example `describe("add") { it("handles empty") }` and `describe("remove") { it("handles empty") }`) become one failure. The other appears in no cluster, no `+N more` count and no listed line, and the TDD baseline merges them. This is the same kind of merge the README complains about. The design records the default, but not this consequence, so whoever reviews the default cannot weigh it. Fix one of the two: (a) make the node identity unique, for example by adding the suite path or the `location:`/`test at` line, and add a scenario where two same-named `it`s under different `describe`s both fail and give 2 failures and Σ `affected_count` = 2; or (b) keep leaf names, but state the loss in "Defaults chosen" and "Risks", and add a scenario that pins the resulting output (1 failure recorded, `summary.failed` 2) so the behavior is a decision on record and not a surprise.

5. **The claim "no invariant is relaxed" is not squared with INV-2 for size levels 2 to 4.** SPEC-002 INV-2 says a collapsed cluster shows "the stack trace and SignalWindow exactly once". §4.2 says the SignalWindow inliner attaches the window "so the caller immediately sees the offending source lines". Levels 2, 3 and 4 in `specs/bounded-vs-raw-size/spec.md` show no window, no stack and no `tests:` row in compact-md, including for clusters with `affected_count > 1`. `design.md` squares only level 5 with INV-2 ("Level 5 and INV-2's cascade rule"). Even so, the proposal says "No invariant is relaxed", the design's Constraints say INV-1..INV-6 keep holding, and task 3.3 tells the implementer to write a revision row "stating that no invariant or ceiling is relaxed". That leaves the wording of the product contract to the implementer. Fix: add a design decision that covers levels 2 to 4. For example: in compact-md, INV-2's "exactly once" means "never repeated, and possibly omitted under the size rule"; the JSON record always carries the stack and window. Then make task 3.3 amend INV-2 and §4.2 to match. If that is judged a relaxation, drop the "no invariant is relaxed" claim from the proposal and from task 3.3.

## Notes

What I checked and found sound:

- **Gate.** `openspec validate sharpen-weak-digest-cases --strict` exits 0.
- **Claims checked by running code** (built `dist/index.js`, Node v22.23.4, copies of `/tmp/dtd-work`):
  - The cluster ids `c_9721831d`, `c_6edce10a`, `c_fdff652c` and `c_53a8182a` match `computeFingerprint` for the stated kind, `top_frame` and message.
  - The TAP raw ranges are 15-39, 41-65, 67-91 and 93-111; the spec-reporter ranges are 18-37, 39-58, 60-79 and 81-91.
  - The ladder byte counts hold exactly: H = 73, then 604, 283, 253, 168 and 133 bytes, and the thresholds R = 531, 530, 200, 120 and 60 pick levels 1 to 5.
  - The footer scenario is exactly 630 bytes.
  - The token-budget scenario fits 3 blocks at 557 tokens, and 4 blocks would take 707.
  - The truncation scenario fits exactly 12 listed lines for any `duration_ms`, and the 80-byte label equals `truncateBytes(name, 80)`.
  - The current behaviours in the scenarios and the proposal are confirmed: `c_11eac407 ... unknown:0:0` for TAP, `BUILD_ERROR 0 failed, 0 passed` for the spec reporter, `INVALID_RED`/64 for a spec-reporter missing export, `0 passed, 0 failed` for a spec-reporter VALID_RED, 2 clusters for a TAP missing module, no omission line for tsc with `--max-clusters=2`, `L1, L10, L11, L12, L2` for tsc-12, and `boom` printed twice.
  - The suite fixture's `top_frame`, diff, counts (`fail 2` + `cancelled 1`) and timeout message all match.
- **Tasks.** The blocked-by graph is well formed: every id exists, there are no cycles, and 1.1 and 2.1 are roots. All 44 scenarios are owned by exactly one task. The lanes share no source file.
- **Principles.** `exit-code-transparency`, `pass-state-ceiling` and `invalid-red-exits-64` are covered by exit-code, one-liner and red-phase scenarios. No principle file is added, so the proof check does not apply.
- **Blast radius.** I searched `formatEnvelope`, `renderFailBody`, `dedupeFailures`, `maxClusters`/`max-clusters`, `more clusters` and `localeCompare` across `src/`, `tests/`, `scripts/acceptance/` and `specs/`. Existing compact-md assertions survive: CT-3's `SYNTAX_IMPORT_ERROR` and the acceptance checks C04, C11 and C16 all have raw output large enough to stay at levels 1 to 4, or they only check the header.

Lesser findings that do not block:

- **Stream claim.** The spec-reporter requirement says the subprocess error is printed "on stderr". On Node 22.23.4 it goes to stdout (I checked by splitting the streams). The matching rule does not depend on the stream, but the design's "interleaved non-deterministically" risk rests on a wrong premise. Correct both texts.
- **Reporter parity on diffs and stacks.** For object values the TAP diff is `a: 2` and the spec diff is `{ a: 2 }`. `pruned_stack` entries carry `at ` under spec and not under TAP. Parity is only claimed for id, kind, `top_frame`, message and samples. Say so in Defaults chosen.
- **Ambiguous key rule.** In "A TAP block without node's keys keeps the v0.1.2 behavior", the block has `error:`, which is one of "these keys". The selection rule is ambiguous, although both paths give the asserted result.
- **Indentation in one assertion.** "Large raw output keeps the full form and INV-2" asks for a SignalWindow row "starting with `28 > `". In compact-md that row starts with two spaces (`  28 > `).
- **Definitions of H and R.**
  - H changes with the level when the header's cluster count changes (`1 cluster` against `2 clusters`). Define H as the header of the candidate level.
  - R points at §4.2 normalisation, which also mentions dropping passing noise; the code and the design do not drop it.
- **Window reads.** An uncapped dedupe reads a SignalWindow from disk for every cluster, where today it reads at most 15. Thousands of `tsc` errors would mean thousands of reads. Consider computing windows only for clusters that are kept.
- **Re-measured figures.** The proposal calls its figures a re-run of the README's measurements, but the scratch projects differ from the README's: 6 tests against "4 of 26", and 5 tsc errors against 6. The digest size is path-dependent (`dig-tsc.txt` is 1,540 B, my run gave 1,543 B, and the proposal says 1,538 B). Task 3.2 re-measures anyway.
- **Task details.**
  - Task 3.2 may add `tests/fixtures/vitest-cart/`, which the proposal's Impact does not list.
  - Task 3.1 needs the node-cart helper that 1.1 defines inside `tests/node-test.spec.ts`. Put it in a shared helper module.
- **Gaps in scope and coverage.**
  - The README's "grouped by the shape of the error, not by root cause" limitation is neither handled nor listed as a non-goal.
  - It is not stated whether quoted string scalars in TAP diffs keep their quotes.
  - A spec-reporter run killed before `✖ failing tests:` yields no failures and falls to `BUILD_ERROR`, and no scenario covers it.
