## Context

`dot-test-digest` implements `specs/SPEC-002-DOT-TEST-DIGEST.md` (v0.1.2). The README's "Example" and "Where it works well, and where it does not" sections measured four weak cases. Each was reproduced on 2026-11-01 with the built binary (`/home/octavio/.local/share/pnpm/dot-test-digest`, Node v22.23.4, `--no-jev`) against the scratch projects in `/tmp/dtd-work/`:

| Case | v0.1.2 output | Root cause (code) |
| --- | --- | --- |
| `node --test` piped (TAP), cart, 4 of 6 failing | `c_11eac407 RUNTIME_EXCEPTION x4 unknown:0:0`, `Unknown test failure`, `diff: expected 900 / received ` | `parseGeneric` in `src/adapters/js-test.ts` treats `not ok N - name` as a header and reads only `Expected`/`Received`-shaped lines; node's YAML keys (`error: \|-`, `location:`, `name:`, `expected:`, `actual:`, `stack: \|-`) are ignored. `expected: 900` matches the loose `Expected\s*:?` regex, which is where the half-empty diff comes from. The four failures have no frames and no message, so they share one fingerprint. |
| `node --test --test-reporter=spec`, cart | `[BUILD_ERROR] 0 failed, 0 passed`, heuristic tail, `top_frame` `(file:/tmp/dtd-work/nodetest/cart.test.js:10:64` | No adapter scores the `✔`/`✖`/`ℹ` grammar (`HEADER` knows `✕ × ✗`, not `✖`); `file://` URLs are parsed as a path starting with `file:`. |
| same, `--tdd-phase=red`, missing export | `INVALID_RED`, exit `64` (TAP gives `VALID_RED`, exit `0`) | Heuristic window misses the `does not provide an export named` line that node printed on stderr before the summary. INV-5 says a missing export is a valid red. |
| `tsc`, 5 errors in 2 files | raw 419 B, digest 1,538 B | Every cluster carries a 3 to 5 row SignalWindow and a stack row equal to `top_frame`; nothing compares the digest with the raw size. |
| vitest, 5 failing (README) and tsc with `--max-clusters=2` | `+2 more clusters (see log)` only; with `--max-clusters=2` no omission line at all | `renderFailBody` only counts budget drops; `dedupeFailures` slices to `maxClusters` before the formatter sees the rest, which breaks INV-2's "never silent". Ties sort with `raw_log_lines.localeCompare` (`L11` < `L5`). |

Red-phase verdicts that are right today and must stay right (measured): TAP and spec, assertion failure, `VALID_RED`/0; missing module, `INVALID_RED`/64; already passing, `INVALID_RED`/64; TAP missing export, `VALID_RED`/0.

Constraints: INV-1..INV-6 and CT-1..CT-6 keep holding; §4.2.2 (one failure per canonical identity, `Σ affected_count <= summary.failed`, honest `unknown:0:0`) and §4.3 (`file::name` identity, gate table) keep holding; runtime dependencies stay `zod` only (§5); `--format=json` keeps its schema.

## Goals / Non-Goals

**Goals:**
- `node --test` (TAP and spec reporters) produces one failure per failing test with file, message, diff, repository stack, correct `error_kind` and a SignalWindow, and both reporters produce the same `cluster_id`s for the same run.
- File-level node failures (import crash) carry the subprocess error so the red gate decides on the real cause under both reporters.
- A compact-md failure digest is never larger than the raw output plus its header line.
- No failure is silent: every omitted cluster is counted, and listed while the budget allows; ties are ordered by source position.
- README's measured claims are re-measured honestly after the code lands; SPEC-002 records the additions as 0.1.3.

**Non-Goals:**
- Changing the JSON envelope (schema, `total_clusters` semantics, the `--max-clusters` cap on `clusters`). Only the tie order changes, as a bug fix.
- Suite-qualified test names for node (`cart > discount ...`); see Defaults chosen.
- Grammars for other TAP producers (`tap`, `tape`), node's `dot`/`junit`/`lcov` reporters, or mocha/jest/pytest changes.
- Changing INV-2's cluster-dropping policy (for example dropping windows to fit more full blocks).
- Fixing the pre-existing `raw: L1-L1` pointer emitted by the heuristic fallback when the child printed nothing (level 5 hides it in compact-md; JSON keeps it). Recorded under Risks.

## Decisions

- **TAP YAML is read by a small purpose-built block reader inside `src/adapters/js-test.ts`**, not a YAML library: after a `not ok` header, an indented `---` opens the block, the matching `...` closes it; top-level keys at the block's base indent; `|-` block scalars take the deeper-indented lines; `'...'`/`"..."` scalars are unquoted; a key with no inline value takes its indented mapping lines (used for `expected:`/`actual:` objects). (alternatives rejected: adding the `yaml` package, which breaks §5's `zod`-only runtime rule; per-key regexes over the whole stream, which cannot tell which block a key belongs to.)
- **Field mapping** (both reporters): message = `<name>: ` + non-blank error lines joined by one space, with a ` [CODE]` tag after the error name removed, so TAP's `name: 'AssertionError'` + `error: |- Expected values to be strictly equal: / 0 !== 900` and spec's `AssertionError [ERR_ASSERTION]: Expected values to be strictly equal: / 0 !== 900` both give `AssertionError: Expected values to be strictly equal: 0 !== 900`. Identical messages, `top_frame`s and kinds give identical fingerprints, so `cluster_id`s match across reporters. Test file = `location:` (TAP, absolute) or `test at` (spec, relative to node's cwd), made relative to `process.cwd()`, which is the same root `src/index.ts` passes to the pruner. (alternatives rejected: keep `[ERR_ASSERTION]`, which makes the two reporters fingerprint differently.)
- **`file://` URLs become paths in the adapter** (`fileURLToPath` semantics) before frames reach `topRepoFrame`/`pruneStack`; the pruner already treats `node:` frames as external and `<anonymous>` as engine frames, so INV-4 needs no change. (alternatives rejected: teaching `stack-pruner.ts` about URLs, which would widen lane A into the pruner shared with lane B.)
- **`top_frame` comes only from stack frames.** `location:`/`test at` feed the identity, never `top_frame`: §4.2.2 forbids borrowing the test file when no repository frame exists, so a timeout keeps `unknown:0:0`.
- **Node counts**: failed = `fail + cancelled` (node 22 counts a timed-out test as cancelled and exits 1; without this, `Σ affected_count` would exceed `summary.failed`), skipped = `skipped + todo`. Suite rows (`failureType: 'subtestsFailed'`, spec tree rows) are never failures.
- **File-level failures** (`error: 'test failed'` + `exitCode:` in TAP; `✖ <file>` with `'test failed'` in spec) adopt the subprocess's error line: TAP from the `# ` comments before that file's `# Subtest:`; spec from the non-blank stderr block that mentions the file's path or URL, else the first error line when there is exactly one file-level failure. Comment/stderr lines never make their own failure, so the import case is 1 cluster with `Σ affected_count = summary.failed = 1` (v0.1.2 TAP made 2). The gate then works unchanged: `Cannot find module` is `SYNTAX_IMPORT_ERROR` (INVALID_RED), `does not provide an export named` is checked first and is `RUNTIME_EXCEPTION` (VALID_RED). (alternatives rejected: special-casing node in `tdd-gate.ts`, which would put a grammar concern in the gate.)
- **Spec reporter is a third parse path** (`parseNodeSpec`) selected by `ℹ tests N`/`ℹ pass N`/`ℹ fail N`; `parseCompact` (vitest) and `parseGeneric` (TAP, Playwright) keep their selection rules. (alternatives rejected: folding it into `parseGeneric`, whose header regex would then match tree rows and double count.)
- **Size rule shape: `D <= R + H`, with a five-level ladder** (full; no windows; no stack; one line per cluster; header + raw). `R` is the normalised stream (what Gear 0 sees, so the comparison is against the text a reader would otherwise get, minus ANSI noise); `H` is the emitted header line. The allowance is the header because it is the one thing the raw output does not have (counts, verdict, log pointer); under the default cache location it is about 100 to 150 bytes. Level 5 always satisfies the rule exactly (`D = H + R`), and when `R + H > 2400` level 1 already satisfies it, because INV-2 caps level 1 at 2,400 bytes; so the rule never conflicts with INV-2 and the ladder only engages for small raw output. Levels are whole-body (every cluster drops its windows together) so the result is deterministic and easy to test. (alternatives rejected: a fixed allowance such as 160 B, which a long `DOT_TEST_DIGEST_HOME` path can exceed with the header alone; a ratio such as `D <= 1.2 R`, which an empty or one-line raw output cannot meet; truncating messages to fit, which hides the actual error; progressive per-cluster window dropping, which adds cases without a clear win.)
- **Level 5 and INV-2's cascade rule.** INV-2 collapses repeated failures so the output stays small; level 5 is chosen only when the raw text is already smaller than every clustered rendering, so it serves the same goal, omits nothing, and keeps the header with the log pointer. The cluster records are untouched and complete in `--format=json`. SPEC-002 0.1.3 states this explicitly so INV-2 is not read as weakened.
- **A stack row equal to `top_frame` is never rendered** in compact-md (it duplicates the cluster header row; tsc clusters always have one). JSON keeps it.
- **`formatEnvelope(envelope, format, context?)`** gains an optional `{ rawText?: string; omitted?: readonly FailureCluster[] }`. JSON ignores it. Without `rawText` the size rule is off (existing callers and tests keep their output). `src/index.ts` passes `rawText` (normalised lines, each plus `\n`) and `omitted`. (alternatives rejected: adding fields to `DigestEnvelope`, which would change the JSON schema.)
- **Uncapped dedupe**: `src/index.ts` calls `dedupeFailures` with `maxClusters: Number.POSITIVE_INFINITY`, gives the first `--max-clusters` clusters to the envelope (JSON unchanged) and the rest to the formatter as `omitted`. `dedupeFailures` keeps its signature and its `maxClusters` slice, so its existing tests stay valid.
- **Footer**: `+N more clusters (see log)` (INV-2's exact wording) then one line per omitted cluster, `  <id> <kind> x<n> <top_frame> <label>`, label = first sample test else message, 80-byte cap. Budget order: drop full blocks (keep 1), then listed lines from the end. (alternatives rejected: listing omitted clusters before shrinking full blocks, which would change how many full blocks today's runs show.)
- **Tie-break** in `dedupeFailures`: `affected_count` desc, first line asc, last line asc, `cluster_id` asc, comparing the numbers already computed (`startLine`/`endLine`), not the string.

## Test seams

- **The CLI** (`main(argv)` in-process with a real child process, cwd set to a temporary copy of a fixture project and `DOT_TEST_DIGEST_HOME` set to a temp directory, exactly as `tests/compliance.spec.ts` does; same argv, stdout and exit-code contract as the built bin, which `tests/bin-entry.spec.ts` already ties to `main`) because it is the highest seam that sees adapter selection, counts, clusters, the gate verdict, the exit code and the rendered size together. Used for every `node --test` scenario (real `node --test` runs of `tests/fixtures/node-cart/` via `process.execPath`), the red-phase guards, the tsc-small and tsc-12 replays, and the empty/`boom` cases. New files: `tests/node-test.spec.ts` (lane A) and `tests/size-and-omission.spec.ts` (lane B), so the lanes do not edit the same test file.
- **`formatEnvelope(envelope, "compact-md", context)`** (existing seam, new optional argument) for the exact ladder thresholds and footer formats, because hitting each level at its exact byte boundary through the CLI would need a fixture per level, and the formatter is where the decision lives. Tests in `tests/envelope.spec.ts`.
- **`dedupeFailures`** (existing seam, `tests/dedup-and-tdd.spec.ts`) for tie-break ordering with chosen line numbers; the tsc-12 CLI scenario covers the same rule end to end.
- **`runGear0(lines)`** (existing seam, `tests/adapters.spec.ts`) for the recorded TAP and spec logs and the existing `tap grammar` test: Node-version-independent and fast, as a backstop to the real-run CLI tests.
- README numbers are measured with the built binary (`pnpm build`, then `dist/index.js` or the linked `dot-test-digest`).

## Defaults chosen

- Node test names are leaf names (`discount 10% leaves 90%`), identity `<file>::<leaf>`, under both reporters. Change by: "qualify node names with their suite path (`cart > ...`)", which needs suite tracking in both parsers and changes TDD baselines.
- `summary.failed` for node = `fail + cancelled`; `summary.skipped` = `skipped + todo`. Change by: "report cancelled separately" (needs a schema field, so a JSON change).
- Node messages drop the ` [CODE]` tag and join continuation lines with one space. Change by: "keep the code tag" (the two reporters would then fingerprint differently).
- Diff values are the printed scalar; mapping values are their trimmed lines joined with `, ` (`a: 2`). Change by: "render objects as `{ a: 2 }`".
- Size rule allowance = the emitted header line; `R` = normalised (ANSI-stripped, CR-collapsed) stream bytes. Change by: "use a fixed allowance of N bytes" or "compare with the unnormalised raw log".
- Five whole-body levels, ending in header + raw text. Change by: "never print raw text; stop at one line per cluster even if larger than raw" (would require relaxing the size rule).
- Stack rows equal to `top_frame` are always hidden in compact-md, not only under the size rule. Change by: "only hide them at level 2+".
- Omitted-cluster line = `  <id> <kind> x<n> <top_frame> <label>` with an 80-byte label, no per-line `raw:` pointer. Change by: "add the raw range to each listed line".
- Clusters dropped by `--max-clusters` are counted and listed in compact-md (previously silent), while JSON stays capped with `total_clusters` = emitted count. Change by: "make `total_clusters` the uncapped count" (a JSON semantics change).
- Fixture projects are verbatim copies of the README measurement projects (`/tmp/dtd-work/nodetest`, `/tmp/dtd-work/tscproj`) plus three small red-phase files and `suite.test.js`. Change by: naming other fixtures.
- SPEC-002 is amended to 0.1.3 in this change (docs task). Change by: "keep SPEC-002 frozen; the openspec change is enough".

## Risks / Trade-offs

- [Node's TAP/spec text differs between Node 20 and 22 (stack frames, YAML keys)] -> parse by key, not by line position; the real-run tests use `process.execPath`, and the recorded logs pin the 22.23.4 shape at the adapter seam. Cluster ids in scenarios depend only on message, kind and `top_frame`, which come from V8 columns and the fixture source.
- [Hard-coded `cluster_id`s (`c_9721831d` ...) make the scenarios strict] -> intentional: they prove TAP/spec fingerprint parity; they were computed with the current `computeFingerprint` from the specified message, kind and `top_frame`.
- [Level 5 could be read as weakening INV-2's "collapse into a single cluster"] -> it is only chosen when raw text is smaller than any clustered form, nothing is omitted, JSON keeps the clusters, and SPEC-002 0.1.3 states it; reviewers can reject it via the default above.
- [The footer adds bytes, so in rare cases one fewer full block fits than in v0.1.2] -> blocks are still dropped lowest-rank first; the dropped one is now listed rather than only counted.
- [Spec-reporter stderr is interleaved non-deterministically with stdout] -> file-level failures match stderr blocks by file path, and fall back to the only error line when there is one file-level failure; multi-file crashes without a path in the block may attach the wrong error (accepted; noted in SPEC-002).
- [Detecting `ℹ tests N` could claim a non-node stream] -> require at least two of `ℹ tests|pass|fail N`; adapters still compete by score.
- [Pre-existing: the heuristic fallback emits `raw: L1-L1` for an empty log] -> out of scope; level 5 no longer prints it in compact-md; JSON still does.
- [Tie order change alters which clusters survive `--max-clusters` for JSON consumers] -> documented as a bug fix in the proposal and SPEC-002 0.1.3.
