Ticket: none (request text: "Read README.md and identify improvements from the test disclosed in there (the 'Example' and 'Where it works well, and where it does not' sections). Draft a spec.")

## Why

The README's own measurements (re-run on 2026-11-01 with the built binary, Node v22.23.4, `--no-jev`) show four cases where the digest is worse than the raw output it replaces, for the people (and agents) who wrap `node --test`, `tsc` or a many-failure vitest run:

1. `node --test` (default reporter when piped = TAP), cart project with 4 of 6 tests failing: all four failures collapse into one cluster `c_11eac407 RUNTIME_EXCEPTION x4 unknown:0:0 "Unknown test failure"` with `diff: expected 900 / received ` (empty). The adapter reads only the `not ok N - name` header and ignores node's YAML diagnostic block (`location:`, `error:`, `name:`, `expected:`/`actual:`, `stack:` with `file://` URLs).
2. `node --test --test-reporter=spec`: not recognised at all; reported as `[BUILD_ERROR] 0 failed, 0 passed` with the log tail and a malformed `top_frame` (`(file:/tmp/dtd-work/nodetest/cart.test.js:10:64`). With a missing export under test the red gate even returns `INVALID_RED` (exit 64), contradicting INV-5, where the TAP reporter correctly returns `VALID_RED`.
3. `tsc` with 5 errors in 2 files: raw 419 B, digest 1,538 B. Source windows plus a stack row that repeats `top_frame` make the digest 3.7x the raw output.
4. vitest with 5 failing tests: only 3 clusters are shown and the other 2 are only counted (`+2 more clusters (see log)`); clusters beyond `--max-clusters` are dropped with no mention at all (5 tsc errors with `--max-clusters=2` print `2 clusters` and no omission line). Ties in `affected_count` are ordered by `raw_log_lines.localeCompare`, so `L11` sorts before `L5`.

## What Changes

- The js-test adapter reads node's TAP YAML diagnostics: one failure per failing test with its file, message, expected/actual diff, repository stack (`file://` URLs turned into paths), the right `error_kind` and therefore a `SignalWindow`; suite rows (`failureType: 'subtestsFailed'`) are not failures; timeouts count as failures.
- The js-test adapter recognises node's `spec` reporter (`✔`/`✖` rows, `ℹ tests|pass|fail|cancelled|skipped|todo N` summary, `✖ failing tests:` section) and produces the same clusters (same `cluster_id`s) as the TAP reporter for the same run.
- A file-level node failure (`'test failed'`, the test file's subprocess crashed) carries the error the subprocess printed, so a missing module stays `INVALID_RED` and a missing export becomes `VALID_RED` under both reporters.
- New compact-md size rule: a failed-run digest is never larger than the ANSI-stripped raw output plus its own header line. It degrades through fixed levels (drop source windows, drop stack rows, one line per cluster) and, when the raw text is smaller than every digest, prints the header followed by the raw text. A stack row identical to `top_frame` is never rendered. `--format=json` is unchanged.
- Omitted clusters are listed one line each (cluster id, kind, count, `top_frame`, first test name) under `+N more clusters (see log)` while INV-2's 600-token budget allows; clusters dropped by `--max-clusters` are now counted and listed too (previously silent).
- Clusters with equal `affected_count` are ordered by numeric source position (first raw-log line, then last line), not lexicographically.
- README's measured claims are re-measured from real runs after the code lands; SPEC-002 gains a 0.1.3 revision describing the additions. No invariant is relaxed.
- Not breaking for `--format=json` consumers: the envelope schema and field semantics are unchanged. Cluster order within an `affected_count` tie changes (bug fix), so which clusters survive `--max-clusters` can change.

## Capabilities

### New Capabilities
- `node-tap-diagnostics`: parsing node's TAP output (default reporter when piped) into one failure per failing test from its YAML diagnostic block, including file-level subprocess failures and the red-phase verdicts that depend on them.
- `node-spec-reporter`: recognising node's `spec` reporter, its counts and its failing-tests section, producing the same clusters as TAP, and the red-phase verdicts that depend on it.
- `bounded-vs-raw-size`: the compact-md rule that a failure digest is never larger than the raw output it replaces plus its header line, with its degradation levels; JSON untouched.
- `omitted-cluster-visibility`: numeric source-order tie-break for clusters and the one-line listing of every omitted cluster (budget-dropped or beyond `--max-clusters`) within INV-2's budget.

### Modified Capabilities
<!-- none: openspec/specs/ has no baseline yet; the existing contract is specs/SPEC-002-DOT-TEST-DIGEST.md -->

## Impact

- Code: `src/adapters/js-test.ts` (TAP YAML, spec reporter, file-level failures, counts), `src/formatters/envelope.ts` (size ladder, omitted-cluster footer, `formatEnvelope` gains an optional render context), `src/pruner/cluster-dedup.ts` (tie-break), `src/index.ts` (uncapped dedupe, passes omitted clusters and normalised raw text to the formatter).
- Tests: new `tests/node-test.spec.ts` (lane A, CLI over real `node --test` runs), new `tests/size-and-omission.spec.ts` (lane B), additions to `tests/adapters.spec.ts`, `tests/envelope.spec.ts`, `tests/dedup-and-tdd.spec.ts`; the existing `tap grammar` describe and CT-1..CT-6 keep passing.
- Fixtures: `tests/fixtures/node-cart/` (copied from the README measurement project), `tests/fixtures/tsc-small/`, `tests/fixtures/logs/`.
- Docs: `README.md` measured rows and notes; `specs/SPEC-002-DOT-TEST-DIGEST.md` revision 0.1.3.
- Consumers: compact-md readers see more failures and smaller output; JSON readers see correct node clusters and the corrected tie order.
