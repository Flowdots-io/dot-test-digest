Ticket: none (request text: "Read README.md and identify improvements from the test disclosed in there (the 'Example' and 'Where it works well, and where it does not' sections). Draft a spec and implement using dotstack's procedures.")

## Why

The README's own measurements, reproduced on 2026-11-01 with the built binary (Node v22.23.4, `--no-jev`) on smaller scratch projects (6 node tests, 5 tsc errors; the README's projects had 26 tests and 6 errors, so the byte counts below are this change's measurements and task 3.2 re-measures the README), show four cases where the digest is worse than the raw output it replaces, for the people (and agents) who wrap `node --test`, `tsc` or a many-failure vitest run:

1. `node --test` (default reporter when piped = TAP), cart project with 4 of 6 tests failing: all four failures collapse into one cluster `c_11eac407 RUNTIME_EXCEPTION x4 unknown:0:0 "Unknown test failure"` with `diff: expected 900 / received ` (empty). The adapter reads only the `not ok N - name` header and ignores node's YAML diagnostic block (`location:`, `error:`, `name:`, `expected:`/`actual:`, `stack:` with `file://` URLs).
2. `node --test --test-reporter=spec`: not recognised at all; reported as `[BUILD_ERROR] 0 failed, 0 passed` with the log tail and a malformed `top_frame` (`(file:/tmp/dtd-work/nodetest/cart.test.js:10:64`). With a missing export under test the red gate even returns `INVALID_RED` (exit 64), contradicting INV-5, where the TAP reporter correctly returns `VALID_RED`.
3. `tsc` with 5 errors in 2 files: raw 419 B, digest about 1,540 B (path dependent). Source windows plus a stack row that repeats `top_frame` make the digest 3.7x the raw output.
4. vitest with 5 failing tests: only 3 clusters are shown and the other 2 are only counted (`+2 more clusters (see log)`); clusters beyond `--max-clusters` are dropped with no mention at all (5 tsc errors with `--max-clusters=2` print `2 clusters` and no omission line). Ties in `affected_count` are ordered by `raw_log_lines.localeCompare`, so `L11` sorts before `L5`.

## What Changes

- The js-test adapter reads node's TAP YAML diagnostics (blocks with a `failureType:` key): one failure per failing test with its file, message (internal whitespace collapsed), expected/actual diff (string quotes removed), repository stack (`file://` URLs turned into paths), the right `error_kind` and therefore a `SignalWindow`; suite rows (`failureType: 'subtestsFailed'`) are not failures; timeouts count as failures.
- Two failing node tests of one file with the same leaf name (under different `describe`s) stay two failures: each is named `<leaf> @<line>`; unique names are unchanged.
- The js-test adapter recognises node's `spec` reporter (`✔`/`✖` rows, `ℹ tests|pass|fail|cancelled|skipped|todo N` summary, `✖ failing tests:` section) and produces the same clusters (same `cluster_id`s) as the TAP reporter for the same run.
- A file-level node failure (`'test failed'`, the test file's subprocess crashed) carries the error its own subprocess printed, also when several files crash in one run, so a missing module stays `INVALID_RED` and a missing export becomes `VALID_RED` under both reporters.
- A spec-reporter stream cut after its summary (no `✖ failing tests:` section) yields one `Unknown test failure` per failing row with honest counts, instead of `BUILD_ERROR` with `0 failed`.
- New compact-md size rule: a failed-run digest is never larger than the ANSI-stripped raw output plus its own header line. It degrades through fixed levels (drop source windows, drop stack rows, one line per cluster) and, when the raw text is smaller than every digest, prints the header followed by the raw text, which shows every failure and so carries no omitted-cluster footer. A stack row identical to `top_frame` is never rendered. `--format=json` is unchanged.
- Omitted clusters are listed one line each (cluster id, kind, count, `top_frame`, first test name) under `+N more clusters (see log)` while INV-2's 600-token budget allows, at size levels 1 to 4; clusters dropped by `--max-clusters` are now counted and listed too (previously silent).
- Clusters with equal `affected_count` are ordered by numeric source position (first raw-log line, then last line), not lexicographically.
- README's measured claims are re-measured from real runs after the code lands; SPEC-002 gains a 0.1.3 revision describing the additions.
- Contract: no ceiling is raised (INV-1's 160 bytes, INV-2's 600 EstimatedTokens / 2,400 bytes), INV-3's exit codes and INV-5's gate verdict rules are unchanged (the spec-reporter missing-export run moves from `INVALID_RED` to `VALID_RED` because it now meets INV-5's existing rule). One INV-2 clause is amended for compact-md: a collapsed cluster shows its stack trace and SignalWindow "at most once" (never repeated) instead of "exactly once", because the size rule may omit them when the digest would otherwise be larger than the raw output; `--format=json` always carries them. §4.2's SignalWindow inliner sentence is amended to match.
- Not breaking for `--format=json` consumers: the envelope schema and field semantics are unchanged. Cluster order within an `affected_count` tie changes (bug fix), so which clusters survive `--max-clusters` can change.

## Capabilities

### New Capabilities
- `node-tap-diagnostics`: parsing node's TAP output (default reporter when piped) into one failure per failing test from its YAML diagnostic block, including same-named tests, file-level subprocess failures (one or several files) and the red-phase verdicts that depend on them.
- `node-spec-reporter`: recognising node's `spec` reporter, its counts and its failing-tests section (or, when the section is missing, its tree rows), producing the same clusters as TAP, and the red-phase verdicts that depend on it.
- `bounded-vs-raw-size`: the compact-md rule that a failure digest is never larger than the raw output it replaces plus its header line, with its degradation levels; JSON untouched.
- `omitted-cluster-visibility`: numeric source-order tie-break for clusters and the one-line listing of every omitted cluster (budget-dropped or beyond `--max-clusters`) within INV-2's budget.

### Modified Capabilities
<!-- none: openspec/specs/ has no baseline yet; the existing contract is specs/SPEC-002-DOT-TEST-DIGEST.md -->

## Impact

- Code: `src/adapters/js-test.ts` (TAP YAML, spec reporter, file-level failures, same-name suffix, counts), `src/formatters/envelope.ts` (size ladder, omitted-cluster footer, `formatEnvelope` gains an optional render context), `src/pruner/cluster-dedup.ts` (tie-break, windows read only for kept clusters), `src/index.ts` (uncapped dedupe, passes omitted clusters and normalised raw text to the formatter).
- Tests: new `tests/helpers/node-cart.ts` (shared CLI runner over a temp copy of `tests/fixtures/node-cart/`), new `tests/node-test.spec.ts` (lane A, CLI over real `node --test` runs), new `tests/size-and-omission.spec.ts` (lane B and integration), additions to `tests/adapters.spec.ts`, `tests/envelope.spec.ts`, `tests/dedup-and-tdd.spec.ts`; the existing `tap grammar` describe and CT-1..CT-6 keep passing.
- Fixtures: `tests/fixtures/node-cart/` (the project quoted in design.md "Fixtures", plus `suite.test.js`, `same-name.test.js`, `string-diff.test.js` and three red-phase files), `tests/fixtures/tsc-small/`, `tests/fixtures/logs/` (`node-tap-cart.log`, `node-spec-cart.log`, `node-spec-truncated.log`, `tsc-12.log`), and `tests/fixtures/vitest-cart/` if task 3.2 has to recreate the README's vitest example project.
- Docs: `README.md` measured rows and notes; `specs/SPEC-002-DOT-TEST-DIGEST.md` revision 0.1.3 (including the INV-2 and §4.2 amendments).
- Consumers: compact-md readers see more failures and smaller output; JSON readers see correct node clusters and the corrected tie order.
