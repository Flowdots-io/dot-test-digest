# Pending spec: open code-review findings for `sharpen-weak-digest-cases`

Written as a hand-off so a fresh session can restart the review and implementation loop. Nothing in `openspec/changes/sharpen-weak-digest-cases/` was touched by this file (it is outside the spec hash).

## State at hand-off

- Branch `dotstack/sharpen-weak-digest-cases`, head `20a7fb52c4febd3ba3e753e10bf99961b1bb6d98`, base `main`. Not pushed, no PR.
- `pnpm run verify` green (typecheck + 209/209 tests). `openspec validate sharpen-weak-digest-cases --strict` ok. `dotstack spec-review check` = `ok` (WARN: reviewer used the author's model). The change is approved at spec hash `441a147f…`; tasks 1.1–4.2 all `[x]`.
- Independent code review: 3 rounds, all rejected (cap reached). Verdict recorded: **reject**. Round heads: `f24cb05` (fixed by merge of review-1), `b5da01b` (fixed by merge of review-2), `20a7fb5` (open findings below). Reviewer runs, round 3: `review-20261106T001000-c3d4` (correctness), `review-20261106T001000-q8f2` (quality). Both opus/high; author model unknown.
- `dotstack gate merge` would refuse until a review of the final head returns `approve` from both reviewers.

## Environment

- `export PATH=/usr/local/lib/nodejs/v22.23.4/bin:/home/octavio/.local/share/pnpm:$PATH` in every shell command.
- Plugin CLI: `node /opt/dotstack/plugins/dotstack/bin/dotstack.mjs`.
- Never rebuild or relink in `/opt/dot-test-digest`: the global `dot-test-digest` link points at its `dist/`. Build in a throwaway worktree (`git worktree add --detach /tmp/x HEAD`, symlink `node_modules`, `npx tsc -p . --outDir dist`).
- Brief templates and prior reviewer replies live in `/tmp/dtd-work/briefs/` (`common.md`, `review-1.md`, `review-2.md` and the reviewer replies); they are scratch and may be gone.

## Open findings (none High)

### F1 (Medium, correctness + quality): crashed test file is classified differently by reporter

- A test file whose only content is `process.exit(1);`, run with `--tdd-phase=red --no-jev`:
  - `--test-reporter=tap`: `[VALID_RED | RED] 0 passed, 1 failed`, exit 0, `RUNTIME_EXCEPTION`, message `test failed`.
  - `--test-reporter=spec`: `INVALID_RED`, exit 64, `SYNTAX_IMPORT_ERROR`.
- Main also gives `VALID_RED` under TAP, so this is not a regression, but the branch fixed only the spec twin (review-2 A1) and the proposal promises the same clusters under both reporters. INV-5 and `.dotstack/principles/invalid-red-exits-64.md`: a runner startup crash must be `INVALID_RED`/64.
- Root cause (quality #1): the "this file crashed" rule is written once per reporter in `src/adapters/node-test.ts`: TAP in `readTapEntry` (`fileLevel`, then `tapSubprocessError`), spec in `isCrashedFile` + `adoptSubprocessErrors`; the "no error found means startup crash" fallback (`errorKind = "SYNTAX_IMPORT_ERROR"`) exists only on the spec side, and `NodeEntry.errorKind?` exists only to carry it.
- Proposed fix: readers only gather facts (`NodeEntry.crashedFile: boolean`, `subprocessError?: string`; TAP sets `crashedFile` from `error: 'test failed'` plus an `exitCode:` key; spec uses `isCrashedFile`). `toRawFailure` applies one rule: `subprocessError !== undefined ? classifyMessage(subprocessError) : crashedFile ? "SYNTAX_IMPORT_ERROR" : classifyMessage(message + stack)`. Delete `NodeEntry.errorKind?`; `adoptSubprocessErrors` stops changing the kind. Add a TAP counterpart of the existing spec test `tests/node-test.spec.ts` "(a test file that exits at load time)" (red first: expect exit 64, INVALID_RED). This is a behaviour change for TAP (main said VALID_RED): state it in the spec delta (see "Spec work").

### F2 (Medium, correctness): size rule collapses to one full block when many clusters are omitted (SPEC DEFECT)

- 30 distinct tsc errors, default `--max-clusters=5`: main prints 5 full blocks with windows (988 bytes); HEAD prints header `| 1 cluster |`, 1 full block, `+29 more clusters`, 19 listed lines (2,346 bytes). JSON still carries 5 clusters, so 4 SignalWindows are read and never shown.
- Cause: `fits(kept, all.length - kept)` in `src/formatters/envelope.ts` (~lines 211–213) counts every listed line while deciding how many full blocks to keep. The spec's literal order ("first drop the lowest-ranked full blocks … then drop listed lines") allows this; `design.md`'s Risks says "in rare cases one fewer full block fits than in v0.1.2", which understates it, and the rejected alternative argues for not changing how many full blocks today's runs show.
- Proposed fix: keep the v0.1.2 block count first (fit the blocks without the listing), then fill the remaining budget with listed lines and count the rest in the tail. Needs a spec amendment of `omitted-cluster-visibility` ("When the listing itself does not fit, the tail is only counted" and the budget-order requirement), `design.md` (Decisions + Risks), README "Things to know", SPEC-002 §4.1.1 text. That voids the spec approval: go through `dotstack:spec` then `dotstack:spec-review` (new round; the review cap restarts only for a new spec hash — check `spec-round`).
- Related Low: `fits` allows 2,400 bytes while `renderFailBody` cuts at `FAIL_BYTE_CEILING - 1` (2,399), so a listing that fills exactly 2,400 is cut mid-line and ends in `...` (the volume test carries a conditional expected value to cope). Make both use the same limit, and let each block carry its own leading `\n` so `fits` is plain concatenation (drop the `+1` / `kept - 1` arithmetic). Build the omitted `lines` once, not per level.

### F3 (Medium, correctness): suite-level failures break Σ affected_count ≤ summary.failed

- Only `subtestsFailed` suites are excluded (`node-test.ts` ~250, 295, 318). A suite with a failing hook (`hookFailed`) or a `describe` body that throws becomes a failure, but node does not count suites in `fail`/`cancelled`. The approved requirement says the sum MUST NOT exceed `summary.failed`.
- Evidence (HEAD, same under TAP and spec unless noted): `before` hook throws: main `failed 3` Σ 3; HEAD `failed 2` Σ 3. `describe` body throws: `failed 1`, Σ 2. `after` hook throws: TAP `failed 1` (line-318 fallback), spec `failed 0` with 1 cluster, so the reporters disagree.
- Proposed fix: after building failures, raise `counts.failed` to at least the number of distinct failures (or fold suite-level failures into the summary); same rule for both reporters. Add hook-failure and describe-throws tests (red first). Check whether this needs a new scenario in `specs/node-tap-diagnostics` / `node-spec-reporter` (it is an existing requirement; a regression test suffices, but say so).

### Lows

- L1: failing `# TODO` / `# SKIP` directive tests: `not ok 2 - not yet # TODO` becomes a cluster; TAP counts it twice (`failed 1, skipped 1`, the line-318 fallback overrides `# fail 0`), spec counts 0 with 1 cluster; names differ (`not yet # TODO` vs `not yet (2.2ms) # TODO`). Exit 0/PASS, gate unaffected. Fix: skip directive entries, strip the directive from names. Also unescape `\#` is already done.
- L2: spec-reporter counts are last-wins: a stream with two node runs (`pnpm -r test`) reports `1 passed, 0 failed` next to 4 clusters (main: `BUILD_ERROR`). Sum the summaries, or never let `failed` fall below the number of failures (the same floor as F3).
- L3 (quality #2): the `Slot` union, `isEntry`, `finish`, `GenericReader` and `entries.flat().length` in `parseNodeTap` exist only for the rare "block without `failureType:`" case. Collect `entries: NodeEntry[]` and `foreign: RawFailure[]` separately and return `[...entries.map(toRawFailure), ...foreign]`; send both non-node cases (no block, or no `failureType`) to one fallback; ideally move `parseGeneric` out of `js-test.ts` into `src/adapters/js-generic.ts` so `node-test.ts` imports it directly and the injected callback disappears.
- L4 (quality #4): `RenderContext.rawText?` is a mode only tests use (production always passes it); `signal_window: ""` placeholder in `cluster-dedup.ts` (rank `RankedCluster`, build `FailureCluster` after the keep/omit split; type `top` with the named frame type); three error-line regexes with drifting identifier rules (`NODE_ERROR_LINE`, the `[CODE]` tag remover in `cleanNodeMessage`, `ERROR_LINE` in `js-test.ts`) → one shared pattern in `common.ts`; `nodeCounts(..., highestPass: boolean)` bare boolean.
- L5 (quality #5, tests): `tests/node-test.spec.ts` (771 lines) declares local `Cluster`/`Envelope` types, use `DigestEnvelope`/`FailureCluster` from `src/types/schema.ts`; many `describe` blocks wrap a single `it` with the same name, group by reporter and concern; `size-and-omission.spec.ts` uses inline casts.

## What the reviewers found clean (do not redo)

Size ladder arithmetic `D ≤ R + H` per level, level 5 ≤ 2,400 bytes (brute-forced), JSON envelope unchanged and capped, `index.ts` wiring (uncapped dedupe via `keep`, JSON capped, gate evidence from kept clusters), numeric tie-break, exit-code pass-through (INV-3), all 51 spec scenarios have a matching test, no repo-module mocks, README figures consistent with the code, acceptance script 17 pass / 1 skip.

## Spec work (do first if F2 or the TAP-crash behaviour change is taken)

1. F2 changes the approved `omitted-cluster-visibility` budget rule; F1 changes TAP red-phase behaviour for a crashed file with no error line (a new `node-tap-diagnostics` scenario "A test file that exits at load time is INVALID_RED under TAP"). Both are spec edits: `dotstack:spec` (amend proposal/design/specs, `openspec validate --strict`), re-run `dotstack:to-tasks` if tasks change, then `dotstack:spec-review` (fresh reviewer, ideally a different model than the author: the previous gate warned the reviewer used the author's model).
2. Update `README.md` ("Things to know": omitted clusters / size rule; red-phase table: TAP crashed-file row) and `specs/SPEC-002-DOT-TEST-DIGEST.md` (§4.1.1 size rule, §4.2.3, revision row) in the same change; re-measure README numbers from a real build (`dotstack:implement` task 3.2 style) if the tsc example changes.

## Suggested restart plan

1. Read this file, `openspec/changes/sharpen-weak-digest-cases/{proposal,design,tasks}.md`, `git log --oneline main..HEAD`.
2. Decide F2 (recommended: keep v0.1.2 block count first, then list). Amend the spec; spec-review; `dotstack:to-tasks` for the new tasks (suggested tasks: T-A F1 + L3 refactor in `node-test.ts`; T-B F3 + L2 counts floor + L1 directives; T-C F2 envelope budget + `fits` limit; T-D docs). T-A and T-B share `node-test.ts` (serial); T-C is independent.
3. `dotstack:implement` (fresh implementers, red test first via `dotstack tdd run`; use existing/new scenario titles), merge `--no-ff`, `pnpm run verify`.
4. `dotstack:review` on the new head with fresh reviewers (the cap restarts with a new head only if the skill's rule permits; otherwise treat the first review after the spec amendment as round 1).
5. `dotstack:verify` (no repo verify skill exists: run `dotstack:create-verification` or drive the built binary on `tests/fixtures/node-cart` and `tests/fixtures/tsc-small`), then `dotstack:ship` (confirm with the user before pushing or opening a PR).

## Housekeeping still open

- `/opt/dotstack/plugins/dotstack/lib/tdd-run.mjs` `scopeId` fix (+ `/opt/dotstack/tests/tdd-scope.test.mjs`) is uncommitted next to the user's other WIP in the dotstack checkout.
- CT-4 is a pre-existing timing flake (1200 ms Jev client timeout under CPU load); unrelated.
- Skipped steps: `deslop`, `no-comments`, `edge-cases` (review preconditions); run them before the next review.
- Shared green SHAs across scenario rows may be a gate risk at `dotstack gate merge`.
- Stale branch `feat/digest-weak-cases` and leftover worktrees under `.claude/worktrees/` (`git worktree list`) need cleanup.
- `.dotstack/principles/*.md` are still founder drafts with `TODO(enforced-by)`.
- SPEC-002 §5 module table already lists `src/adapters/node-test.ts` (commit after review-1).
