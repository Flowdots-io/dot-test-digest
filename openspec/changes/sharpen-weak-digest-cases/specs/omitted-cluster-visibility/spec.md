## ADDED Requirements

### Requirement: Clusters with equal affected_count are ordered by source position
`dedupeFailures` SHALL order clusters by `affected_count` descending, then by the cluster's first raw-log line ascending (numerically), then by its last raw-log line ascending, then by `cluster_id` ascending. The order MUST NOT depend on the lexicographic order of the `raw_log_lines` string. Lower-ranked clusters are the ones dropped first by `--max-clusters` and by INV-2's budget.

#### Scenario: Single-digit lines sort before double-digit lines
- **GIVEN** three failures with distinct fingerprints and one test each: `startLine 13, endLine 20`, `startLine 5, endLine 9`, `startLine 11, endLine 12`
- **WHEN** `dedupeFailures` runs with `maxClusters: 5`
- **THEN** the clusters' `raw_log_lines` are `["L5-L9", "L11-L12", "L13-L20"]` in that order (v0.1.2 gave `["L11-L12", "L13-L20", "L5-L9"]`)

#### Scenario: Equal first lines fall back to the last line
- **GIVEN** two failures with distinct fingerprints: `startLine 7, endLine 30` and `startLine 7, endLine 9`
- **WHEN** `dedupeFailures` runs
- **THEN** the order is `["L7-L9", "L7-L30"]`

#### Scenario: affected_count still ranks first
- **GIVEN** one failure at `startLine 5` with its own fingerprint and three failures sharing another fingerprint at `startLine 100`, `101`, `102`
- **WHEN** `dedupeFailures` runs
- **THEN** the `affected_count` sequence is `[3, 1]`

#### Scenario: --max-clusters keeps the first clusters in source order
- **GIVEN** `tests/fixtures/logs/tsc-12.log`, 12 lines where line `N` (1 to 12) is `src/m.ts(N,1): error TS2322: Type 'number' is not assignable to type 'string'.`
- **WHEN** `dot-test-digest --no-jev --format=json --max-clusters=5 -- node -e "process.stdout.write(require('node:fs').readFileSync('<abs path to tsc-12.log>','utf8')); process.exit(2)"` runs
- **THEN** the exit code is `2` and the clusters' `raw_log_lines` are `["L1-L1", "L2-L2", "L3-L3", "L4-L4", "L5-L5"]` (v0.1.2 gave `L1-L1, L10-L10, L11-L11, L12-L12, L2-L2`)

### Requirement: Every omitted cluster is listed on one line while INV-2's budget allows
In `compact-md`, a cluster is omitted when it is beyond `--max-clusters` or dropped by INV-2's 600-EstimatedToken budget. When at least one cluster is omitted, the body SHALL end with the line `+N more clusters (see log)`, where `N` counts every omitted cluster of both kinds, followed by one line per omitted cluster in rank order: two spaces, `<cluster_id> <error_kind> x<affected_count> <top_frame> <label>`, where `<label>` is the cluster's first sample test name, or its message when it has none, truncated to 80 bytes (ending in `...` when cut). The budget SHALL first drop the lowest-ranked full blocks (keeping at least one, as today), then, if the body is still over budget, drop listed lines from the end; clusters whose line was dropped stay counted in `N`. The total stays at most 600 EstimatedTokens and 2,400 bytes. The header's cluster count is the number of clusters rendered in full (blocks, or one-line entries at size level 4; at size level 5 it is the number of clusters in the envelope, see `bounded-vs-raw-size`). `--format=json` is unchanged: `clusters` holds at most `--max-clusters` entries and `summary.total_clusters` equals their number.

#### Scenario: Clusters beyond --max-clusters are listed instead of silently dropped
- **GIVEN** an envelope with `summary` `{ passed: 0, failed: 4 }`, `duration_ms` `10`, `raw_log_path` `/tmp/logs/run_b.log` and two clusters: `c_aaaaaaa1 ASSERTION_FAILURE x1 tests/cart.test.ts:7:66`, message `AssertionError: expected 100 to be 900`, test `cart > discount 10% leaves 90%`, raw `L5-L27`; and `c_bbbbbbb2 RUNTIME_EXCEPTION x1 src/cart.ts:10:50`, message `TypeError: Cannot read properties of undefined (reading 'name')`, test `cart > first of an empty cart is undefined`, raw `L28-L40` (no diff, stack or window)
- **AND** two omitted clusters passed as `omitted`: `c_ccccccc3 ASSERTION_FAILURE x1 tests/cart.test.ts:9:58` with test `cart > total without discount`, and `c_ddddddd4 TYPE_COMPILE_ERROR x1 src/a.ts:2:14` with no test and message `TS2322: Type 'number' is not assignable to type 'string'.`
- **WHEN** `formatEnvelope(envelope, "compact-md", { omitted })` is called
- **THEN** the output is exactly these 12 lines, each followed by `\n` (630 bytes):
  `[FAIL] 4 failed, 0 passed in 10ms | 2 clusters | log: /tmp/logs/run_b.log`,
  `c_aaaaaaa1 ASSERTION_FAILURE x1 tests/cart.test.ts:7:66`,
  `  AssertionError: expected 100 to be 900`,
  `  tests: cart > discount 10% leaves 90%`,
  `  raw: L5-L27`,
  `c_bbbbbbb2 RUNTIME_EXCEPTION x1 src/cart.ts:10:50`,
  `  TypeError: Cannot read properties of undefined (reading 'name')`,
  `  tests: cart > first of an empty cart is undefined`,
  `  raw: L28-L40`,
  `+2 more clusters (see log)`,
  `  c_ccccccc3 ASSERTION_FAILURE x1 tests/cart.test.ts:9:58 cart > total without discount`,
  `  c_ddddddd4 TYPE_COMPILE_ERROR x1 src/a.ts:2:14 TS2322: Type 'number' is not assignable to type 'string'.`

#### Scenario: Clusters dropped by the token budget are listed
- **GIVEN** an envelope with `summary.failed` `5`, `raw_log_path` `/tmp/logs/run_c.log` and five clusters `c_10000001` ... `c_10000005`, each `ASSERTION_FAILURE x1`, `top_frame` `src/modN.ts:10:5`, message `AssertionError: expected N to be 0`, test `suite > case N`, raw `L<10N>-L<10N+5>`, no diff or stack, and a `signal_window` of 5 rows of 105 bytes each
- **WHEN** `formatEnvelope(envelope, "compact-md")` is called
- **THEN** the output has full blocks for `c_10000001`, `c_10000002`, `c_10000003` (header says `3 clusters`), then `+2 more clusters (see log)`, `  c_10000004 ASSERTION_FAILURE x1 src/mod4.ts:10:5 suite > case 4`, `  c_10000005 ASSERTION_FAILURE x1 src/mod5.ts:10:5 suite > case 5`
- **AND** the output is at most 600 EstimatedTokens (v0.1.2 showed the same 3 blocks and only `+2 more clusters (see log)`)

#### Scenario: When the listing itself does not fit, the tail is only counted
- **GIVEN** an envelope with `summary.failed` `15`, `raw_log_path` `/tmp/logs/run_d.log` and one cluster `c_20000000 ASSERTION_FAILURE x1 src/cart.ts:3:10` (message `AssertionError: expected 100 to be 900`, raw `L1-L4`, nothing else)
- **AND** 14 omitted clusters `c_20000001` ... `c_2000000e`, each `ASSERTION_FAILURE x1`, `top_frame` `src/features/module-K/handlers/very-long-handler-name.ts:120:40` (K = 1..14), with the single test name `cart > a test name that is deliberately long so that the omitted-cluster label has to be truncated at eighty bytes` (114 bytes)
- **WHEN** `formatEnvelope(envelope, "compact-md", { omitted })` is called
- **THEN** the output contains `+14 more clusters (see log)` followed by exactly 12 listed lines, for `c_20000001` through `c_2000000c` in that order, each ending in `cart > a test name that is deliberately long so that the omitted-cluster labe...` (an 80-byte label)
- **AND** the output is at most 600 EstimatedTokens and 2,400 bytes

#### Scenario: Every failure of the node cart run is visible somewhere
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/node-cart/` (see `node-tap-diagnostics`)
- **WHEN** `dot-test-digest --no-jev -- node --test cart.test.js` runs
- **THEN** each of `c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a` starts exactly one stdout line, either as a full block header (column 0) or as a listed line (after two spaces), and if any is listed the body has `+N more clusters (see log)` where `N` is the number of listed ids

#### Scenario: --max-clusters on a real run lists the rest and keeps JSON capped
- **GIVEN** the same working directory
- **WHEN** `dot-test-digest --no-jev --max-clusters=2 -- node --test cart.test.js` runs
- **THEN** the header contains `| 2 clusters |`, and the body ends with `+2 more clusters (see log)`, `  c_fdff652c ASSERTION_FAILURE x1 cart.test.js:9:50 total with 100% off is free`, `  c_53a8182a RUNTIME_EXCEPTION x1 cart.js:5:42 first of an empty cart is undefined`
- **AND** the same command with `--format=json` reports 2 clusters (`c_9721831d`, `c_6edce10a`) and `summary.total_clusters` `2`
