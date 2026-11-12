# JSON envelope

`--format=json` prints the complete structured result for another program: status, exit code, counts, and every cluster the run kept, with fingerprint, message, diff, pruned stack, source window, raw-log line range and, when the command names a known runner, the command that reruns the cluster's first test. `schema_version` (`1`) and `run_id` close every envelope. It is not byte-capped. `--format=ndjson` gives the same content one JSON object per line, and `dot-test-digest schema` prints the JSON Schema of the envelope.

## Sub-features

- `json-fail` a failing run is a JSON document with `status: "FAIL"` and the clusters.
- `json-pass` a passing run is a JSON document with `status: "PASS"` and no clusters.
- `json-max-clusters` `--max-clusters=N` keeps at most N clusters and `summary.total_clusters` equals their number.
- `json-parity` the cluster ids equal those in the `compact-md` digest of the same run.
- `json-contract` `schema_version` `1`, `run_id` equal to the log's file name without `.log`, `summary.omitted_clusters` only when clusters lie beyond `--max-clusters`.
- `json-rerun` each cluster of a `node --test` or `vitest` run has a `rerun` command that reruns that one test (jest, pytest, cargo, go and eslint forms are checked against fixture logs only, never against the real tools).
- `json-schema` `dot-test-digest schema` prints `schema/digest-envelope.schema.json`, and real envelopes validate against it.
- `json-ndjson` `--format=ndjson`: a `summary` line, one `cluster` line per kept cluster, one `omitted` line per omitted cluster.

## How to get to it (user POV)

- Run `dot-test-digest --format=json -- <command>` and parse stdout (for example with `jq`).
- Run `dot-test-digest --format=ndjson -- <command>` and read stdout line by line; `dot-test-digest replay last --format=ndjson` does the same for the last run of this directory.
- Run `dot-test-digest schema` for the schema.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test.
- Prod: not safe (writes a raw log under the run's isolated cache home).

- **Failing run.** `$V drive $RUN json-fail node-cart --format=json -- node --test cart.test.js`. Exit `1`. stdout parses as JSON (`python3 -c 'import json,sys; json.load(open("stdout.txt"))'` in the evidence directory) with `status` `FAIL`, `exit_code` `1`, `execution_gear` `GEAR_0_GRAMMAR`, `summary` `{passed: 2, failed: 4, skipped: 0, total_clusters: 4}` (no `omitted_clusters`: nothing lies beyond `--max-clusters`); top-level keys end with `raw_log_path, schema_version, run_id`, `schema_version` is `1` and `run_id` is the log's file name without `.log`; cluster keys are `affected_count, cluster_id, diff, error_kind, fingerprint, message, pruned_stack, raw_log_lines, rerun, sample_tests, signal_window, top_frame`; `c_9721831d` has `rerun` `node --test --test-name-pattern '^discount 10% leaves 90%$' cart.test.js` (measured 2026-11-12: 5,031 bytes).
- **Rerun works.** `cd $(cat .acceptance/verify/$RUN/workdir)/node-cart && sh -c "<that rerun>"` prints `# tests 1`, `# pass 0`, `# fail 1`.
- **Passing run.** `$V drive $RUN json-pass node-cart --format=json -- node --test passing.test.js`. Exit `0`; keys `status, tdd_phase, exit_code, signal, execution_gear, duration_ms, summary, raw_log_path, schema_version, run_id`; `status` `PASS`; `summary` has no `omitted_clusters`; 415 bytes with the run's long `home/` path (the 160-byte ceiling does not apply to JSON).
- **Cluster cap.** `$V drive $RUN json-mc2 node-cart --format=json --max-clusters=2 -- node --test cart.test.js`. `clusters` has 2 entries, `summary.total_clusters` is `2` and `summary.omitted_clusters` is `2`, while `summary.failed` stays `4`.
- **ndjson.** `$V drive $RUN ndjson node-cart --format=ndjson --max-clusters=2 -- node --test cart.test.js`. Exit `1`; 5 lines, each valid JSON, `type` `summary`, `cluster`, `cluster`, `omitted`, `omitted`; the summary line has every top-level key but `clusters`; the omitted lines are `c_fdff652c` then `c_53a8182a`, with `cluster_id, error_kind, affected_count, top_frame, label, raw_log_lines` (and `rerun`). A pass (`passing.test.js`) is one `summary` line. `$V drive $RUN ndjson-replay node-cart replay last --format=ndjson` repeats the last run's line types.
- **Schema.** `$V drive $RUN schema - schema`. Exit `0`; `cmp` of `stdout.txt` with the repo's `schema/digest-envelope.schema.json` is silent (the helper copies `schema/` beside the build, as the package ships it beside `dist/`).
- **Parity.** The ids in `json-fail` (`c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a`) are the ids in the compact digest of the same command ([failure-digest.md](./failure-digest.md)).

## Gotchas

- Unlike `compact-md`, JSON carries at most `--max-clusters` clusters and does not list the omitted ones; `summary.failed` is the full failure count.
- The JSON is a single document on stdout; diagnostics (usage errors) still go to stderr.
- Fields such as `duration_ms`, `raw_log_path` and `run_id` change per run.
- `rerun` exists only when the command has a runner token of the grammar that read the output: `-- node --test ...`, `-- npx vitest run`, `-- pytest ...` do; `-- pnpm test`, `-- npm test`, `-- make test`, `tsc`, a shell script (`-- sh -c "npm run build && vitest"`: a word with whitespace is never a runner) and a JavaScript failure under `-- pnpm --dir packages/go test` (`go` is not a JavaScript runner) do not. vitest and jest get `-t '<test>'`; a name starting with `-` gets `-t '\-...'` so it is not read as a flag (executed with vitest: `-t '\-1 is rejected'` runs only that test). The quoting is POSIX shell only.
- When the run record cannot be written (`could not write the run record` on stderr), the `next:` line of the compact digest and `run_id` still name the run, and `show <run> <cluster>` exits `66` with `record of <run> is missing or unreadable`; the log the header names still holds the lines.
- The schema has `additionalProperties: false`: a key the schema does not declare fails validation, so a consumer validates output with the schema of the same version (`dot-test-digest schema` of the binary that produced it), and a developer regenerates it (`pnpm run schema`, Node 22.18 or later for type stripping) with any envelope change; the test that compares it with the generator catches a stale file.
