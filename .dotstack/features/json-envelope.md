# JSON envelope

`--format=json` prints the complete structured result for another program: status, exit code, counts, and every cluster the run kept, with fingerprint, message, diff, pruned stack, source window and raw-log line range. It is not byte-capped.

## Sub-features

- `json-fail` a failing run is a JSON document with `status: "FAIL"` and the clusters.
- `json-pass` a passing run is a JSON document with `status: "PASS"` and no clusters.
- `json-max-clusters` `--max-clusters=N` keeps at most N clusters and `summary.total_clusters` equals their number.
- `json-parity` the cluster ids equal those in the `compact-md` digest of the same run.

## How to get to it (user POV)

- Run `dot-test-digest --format=json -- <command>` and parse stdout (for example with `jq`).

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test.
- Prod: not safe (writes a raw log under the run's isolated cache home).

- **Failing run.** `$V drive $RUN json-fail node-cart --format=json -- node --test cart.test.js`. Exit `1`. stdout parses as JSON (`python3 -c 'import json,sys; json.load(open("stdout.txt"))'` in the evidence directory) with `status` `FAIL`, `exit_code` `1`, `execution_gear` `GEAR_0_GRAMMAR`, `summary` `{passed: 2, failed: 4, skipped: 0, total_clusters: 4}`; cluster keys are `affected_count, cluster_id, diff, error_kind, fingerprint, message, pruned_stack, raw_log_lines, sample_tests, signal_window, top_frame`; `raw_log_path` is the log file.
- **Passing run.** `$V drive $RUN json-pass node-cart --format=json -- node --test passing.test.js`. Exit `0`; keys `status, tdd_phase, exit_code, signal, execution_gear, duration_ms, summary, raw_log_path`; `status` `PASS`; 354 bytes (the 160-byte ceiling does not apply to JSON).
- **Cluster cap.** `$V drive $RUN json-mc2 node-cart --format=json --max-clusters=2 -- node --test cart.test.js`. `clusters` has 2 entries and `summary.total_clusters` is `2` while `summary.failed` stays `4`.
- **Parity.** The ids in `json-fail` (`c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a`) are the ids in the compact digest of the same command ([failure-digest.md](./failure-digest.md)).

## Gotchas

- Unlike `compact-md`, JSON carries at most `--max-clusters` clusters and does not list the omitted ones; `summary.failed` is the full failure count.
- The JSON is a single document on stdout; diagnostics (usage errors) still go to stderr.
- Fields such as `duration_ms` and `raw_log_path` change per run.
