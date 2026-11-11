# Failure digest

A failing run is collapsed into clusters of failures with the same root cause. Each shown cluster has an id, error kind, location, message, diff, a pruned stack and a source window around the failing line; the whole digest is at most 2,400 bytes (600 estimated tokens). Clusters that do not fit are listed one per line, never dropped silently. The child's exit code is unchanged.

## Sub-features

- `fail-clusters` four failing tests are four clusters (`c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a`); each is either shown in full or listed on one line.
- `fail-omitted` `+N more clusters (see log)` followed by one line per omitted cluster.
- `fail-ceiling` stdout is at most 2,400 bytes.
- `fail-raw-pointer` each `raw: L<a>-L<b>` resolves to lines of the log named in the header.
- `fail-max-clusters` `--max-clusters` and `--context-lines` change what is shown.
- `fail-vitest` vitest output is parsed into clusters.
- `fail-tsc-fallback` when the digest would be larger than the raw output, the header plus the raw text is printed.
- `fail-unstructured` output no grammar recognises is `BUILD_ERROR` with a narrowed tail.

## How to get to it (user POV)

- Run `dot-test-digest -- <test or build command>` on a project with failures.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test.
- Prod: not safe (writes a raw log under the run's isolated cache home).

- **node --test.** `$V drive $RUN fail node-cart -- node --test cart.test.js`. Exit `1`. Header `[FAIL] 4 failed, 2 passed in <t>ms | <K> clusters | log: <path>`. All four ids appear in stdout (`grep -c` of each is at least 1): the first K as full blocks in rank order, the rest after `+<4-K> more clusters (see log)` as lines like `c_53a8182a RUNTIME_EXCEPTION x1 cart.js:5:42 first of an empty cart is undefined`. `c_9721831d` is the first block: `cart.test.js:7:46`, `diff: expected 900 / received 0`, a `7 >` source window, `tests: discount 10% leaves 90%`, `raw: L15-L39`; `c_6edce10a` is the second (`cart.test.js:8:41`, `raw: L41-L65`). `wc -c` of stdout is at most `2400` (measured 2,380 with K=3 and 1,864 with K=2).
- **Same under the spec reporter.** `$V drive $RUN fail-spec node-cart -- node --test --test-reporter=spec cart.test.js`. Exit `1`; the same four cluster ids appear (shown or listed).
- **Raw pointer.** Take the log path from the header and run `sed -n 15,17p <log>`. It starts at `not ok 3 - discount 10% leaves 90%`, the first failing test.
- **Fewer clusters.** `$V drive $RUN mc1 node-cart --max-clusters=1 -- node --test cart.test.js`. Header says `| 1 cluster |`, one full block, and `+3 more clusters (see log)`.
- **Smaller window.** `$V drive $RUN cl0 node-cart --context-lines=0 -- node --test cart.test.js`. The source window of the first cluster is only the `7 >` line.
- **vitest.** `$V drive $RUN vitest-fail vitest-cart -- vitest run`. Exit `1`. Header `[FAIL] 5 failed, 24 passed in <t>ms | 3 clusters`; ids `c_992bb564`, `c_95e904e3`, `c_cf012b19` in full, then `+2 more clusters (see log)` and two lines (`c_c7823024`, `c_8bdc37b0`).
- **tsc fallback.** `$V drive $RUN tsc tsc-small -- tsc --noEmit`. Exit `2`. Header `[FAIL] 5 failed, 0 passed in <t>ms | 5 clusters | log: <path>` followed by the five raw `src/a.ts(2,14): error TS2322: ...` lines unchanged (raw text is smaller than any clustered form).
- **Unstructured.** `$V drive $RUN unstructured - -- sh -c 'echo something broke; exit 3'`. Exit `3`; stdout is the header `[BUILD_ERROR] 0 failed, 0 passed in <t>ms | 1 cluster | log: <path>` followed by the narrowed tail `something broke`, well under 2,400 bytes. The cluster kind `UNSTRUCTURED_BUILD_ERROR` is visible with `--format=json`.

## Gotchas

- The header's cluster count is the number of clusters shown in full, not the number of failures: node-cart says `3 clusters` for 4 failures with the helper's `/tmp` fixture path, and `2 clusters` when the path is longer (a longer path makes every stack row longer, and the third block no longer fits in the 2,400-byte budget). Assert the four ids and `shown + listed = 4`, never a fixed K. The footer reads `+1 more clusters (see log)`, with no singular form.
- Absolute fixture paths appear in stack rows and change per run; compare the cluster ids and `file:line`, not the full path.
- `tsc` takes about 5 seconds; the vitest fixture needs the repo's `node_modules` (the helper symlinks it).
- A project whose directory contains a vitest config changes what vitest runs. The helper copies fixtures outside the repo for that reason; do not run vitest inside the repo for this journey.
- Durations (`in 277ms`) differ every run.
