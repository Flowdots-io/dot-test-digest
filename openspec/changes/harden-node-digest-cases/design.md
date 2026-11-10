## Context

`sharpen-weak-digest-cases` (archived `2026-11-10-sharpen-weak-digest-cases`, capabilities now in `openspec/specs/`) shipped through PR #5 and #6. This change is a delta over those capabilities: it modifies two requirements whose text allowed a wrong result and adds four small requirements. Seams are unchanged: the CLI through `main()` over real `node --test` runs in a temp copy of `tests/fixtures/node-cart/` (`tests/helpers/node-cart.ts`), `formatEnvelope` (envelope seam) and `jsTestAdapter.parse` (adapter seam). Constraints are those of the archived change: INV-1 160 bytes, INV-2 600 EstimatedTokens / 2,400 bytes, INV-3 exit codes, INV-5 gate verdicts, `--format=json` untouched, runtime dependencies `zod` only.

## Decisions

- **Reserve the footer line, fix the blocks first, then list.** v0.1.2 chose its full blocks with a budget that had no listing. The shipped rule counted every listed line while choosing blocks (`fits(kept, all - kept)`), which collapsed 5 blocks to 1 with 25 omitted clusters. New order: (1) blocks: the largest `kept` (at least 1) for which header + blocks + the `+N more clusters (see log)` line fit; (2) listing: as many whole lines as fit in the rest; (3) the unlisted clusters stay in `N`. The `+N` line is reserved before the blocks because the archived requirement says it ends the body at levels 1 to 4. (Alternative rejected: keep the shipped order and raise the cap on listed lines; it still takes blocks away from the clusters the user asked for with `--max-clusters`.)
- **One byte limit.** The shipped code decided with `ceil(bytes/4) <= 600` (up to 2,400 bytes) and cut at 2,399, so an exactly-full listing lost its last bytes to a cut. The digest including its final newline is at most 2,400 bytes: the size decision uses 2,399 bytes before the newline, the same as the cut.
- **One attribution rule, position first.** For a crashed file the error is the first error-shaped line at or after the last line that mentions the file, among the lines that node printed for that file. TAP already had the position (the comment run above `# Subtest: <file>`); the spec reporter now has it too: the lines between the previous tree row and the file's own `✖ <file>` row, measured on Node 22.23.4 (`node --test --test-reporter=spec missing-module.test.js syntax-error.test.js` prints each file's block directly above its own `✖` row). The archived design rejected a position rule for the spec reporter because it depends on node's layout; it is kept only as the first rule, and the archived path rule and the lone-failure rule remain as fallbacks over all lines outside every failing-tests section, so a layout change degrades to the old behaviour. "At or after the last mention" is what makes a setup log line (`Error: config.json not found`) printed earlier lose to `Error [ERR_MODULE_NOT_FOUND]: ... imported from <file>`, and what lets `file://...:3` / blank lines / `SyntaxError:` stay together.
- **Read failures are invalid red.** `Error: EACCES`, `EPERM`, `EISDIR` as the error of a crashed file mean node could not read the test file at all: INV-5's runner startup crash. `ENOENT` is not included: node reports a missing file before any subprocess exists (`Could not find ...`), already `INVALID_RED`.
- **Nameless errors are `Error`.** A TAP block of failure type `testCodeFailure` or `hookFailed` with no `name:` key is a plain `Error` (measured: `throw new Error("z")` prints `error: 'z'` and no `name:`; `TypeError` and `AssertionError` print `name:`). The spec reporter prints `Error: z`. Node prints a thrown string exactly like a plain `Error` under TAP, so a thrown string reads `Error: text` under TAP and `text` under spec: accepted, plain errors are far more common (limit written in the spec).

## Defaults chosen

- A crashed file whose own error is a runtime error other than a missing export (`throw new TypeError(...)` at load) stays `VALID_RED`/`RUNTIME_EXCEPTION`: INV-5 lists `is not a function` among behavioural evidence, and a top-level call to a function that does not exist yet is a legitimate red. Only read failures and files with no attributable error are invalid red.
- Backslash handling covers `\\` only; other TAP escapes stay as they are.
- Cosmetic parity gaps (TAP `diff:` row for nested arrays, spec diff `{ a: 2 }` vs TAP `"a: 2"`) are not changed: the `cluster_id` does not depend on the diff.

## Fixtures

Existing: `tests/fixtures/node-cart/` (see the archived design). New: `plain.test.js` (contents in `specs/node-tap-diagnostics/spec.md`). Created by the tests through `options.files` and not stored: `names.test.js`, `wrap.mjs`, `noread.test.js` (mode `000`; the test is skipped when the process runs as root, which can read anything).

## Test seams

- CLI (`main()` over a temp cart copy): every node scenario, the 30-cluster envelope scenario is at the envelope seam.
- Envelope (`formatEnvelope`): the three omitted-cluster scenarios added here.
- `tests/envelope.spec.ts` and `tests/size-and-omission.spec.ts` carry byte limits that move from 2,400 to "2,399 + newline"; they are updated by the task that changes the limit.

## Risks / Trade-offs

- Scenario numbers that the old rule fixed (for instance the 12 listed lines of "When the listing itself does not fit, the tail is only counted") depend on the single byte limit; the task re-measures them and the scenario text is corrected in the same commit if one moves by a line.
- The spec-reporter position rule reads the layout of Node 22.23.4's reporter; fallbacks keep the old behaviour elsewhere. Other node versions were not tested.
- Treating `EACCES`/`EPERM`/`EISDIR` as a startup crash could hide a real behavioural red only if a test file's own subprocess died reading its own file, which is not behaviour.
