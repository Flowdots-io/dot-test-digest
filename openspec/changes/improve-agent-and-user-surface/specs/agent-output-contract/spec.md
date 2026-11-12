## ADDED Requirements

### Requirement: A failure digest names the next step on its second line
In `compact-md`, at size levels 1 to 4, when the envelope carries a `run_id` and has at least one cluster, line 2 of the digest SHALL be `next: dot-test-digest show <run_id> <cluster_id>`, where `<cluster_id>` is the first omitted cluster in rank order when any cluster is omitted, and otherwise the first kept cluster. The line SHALL be counted by the size decision and reserved before the full blocks are chosen (like the `+N more clusters (see log)` line), so INV-2's 2,400 bytes and the `D <= R + H` rule keep holding. It SHALL NOT appear at size level 5, in pass lines (INV-1), in `VALID_RED` lines, or when the envelope has no `run_id`. The command it prints SHALL be accepted by `show` as written.

#### Scenario: Omitted clusters are the target
- **GIVEN** the cart and a fresh home
- **WHEN** `-- node --test cart.test.js` runs
- **THEN** line 2 matches `^next: dot-test-digest show run_[0-9a-z]+ c_[0-9a-f]{8}$`
- **AND** the cluster id on it is the id on the first line after `+N more clusters (see log)`
- **AND** stdout is at most 2,400 bytes

#### Scenario: With nothing omitted the target is the first cluster
- **GIVEN** the cart
- **WHEN** `--max-clusters=15 -- node --test cart.test.js` runs
- **THEN** line 2 names the first block's cluster id (`c_9721831d`)

#### Scenario: The printed command works
- **GIVEN** the run above
- **WHEN** the command on line 2 runs as `show <run_id> <cluster_id>`
- **THEN** it prints the `raw_log_lines` range of that cluster from the log and exits `0`

#### Scenario: No next line where the ladder shows raw text
- **GIVEN** a fresh home and `tests/fixtures/tsc-small/tsc.log`
- **WHEN** `-- node -e "process.stdout.write(require('node:fs').readFileSync('tests/fixtures/tsc-small/tsc.log','utf8')); process.exit(2)"` runs
- **THEN** stdout is the header followed by the 5 raw lines, with no `next:` line

#### Scenario: No next line on a pass or a hand-built envelope
- **GIVEN** the cart
- **WHEN** `-- node --test passing.test.js` runs, and `formatEnvelope` is called with a failing envelope that has no `run_id`
- **THEN** neither output contains a line starting `next:`, and the second is byte-identical to the 0.1.x rendering

#### Scenario: The ceiling holds with the line
- **GIVEN** the 30-error `tsc` project of the README (30 files `src/m1.ts` to `src/m30.ts`, each `export const vN: number = "text N";`)
- **WHEN** `--max-clusters=5 -- npx tsc --noEmit` runs
- **THEN** stdout is at most 2,400 bytes and line 2 is a `next:` line

### Requirement: The JSON envelope carries a version, the run id and omitted counts
`--format=json` SHALL add `schema_version` (the integer `1`) and `run_id` as top-level keys, `summary.omitted_clusters` (the number of clusters beyond `--max-clusters` or the budget, present only when greater than `0`) and `summary.warnings` (present only when greater than `0`). No existing key changes. A change that only adds optional keys SHALL keep `schema_version` at `1`.

#### Scenario: JSON of a failing run
- **GIVEN** the cart and a fresh home
- **WHEN** `--format=json --max-clusters=2 -- node --test cart.test.js` runs
- **THEN** the JSON has `schema_version` `1`, a `run_id` equal to the log's file name without `.log`, and `summary` `{ "passed": 2, "failed": 4, "skipped": 0, "total_clusters": 2, "omitted_clusters": 2 }`

#### Scenario: JSON of a passing run has no omitted count
- **GIVEN** the cart
- **WHEN** `--format=json -- node --test passing.test.js` runs
- **THEN** the top-level keys are `status, tdd_phase, exit_code, signal, execution_gear, duration_ms, summary, raw_log_path, schema_version, run_id` and `summary` has no `omitted_clusters`

### Requirement: The JSON Schema is committed and checked against real output
`schema/digest-envelope.schema.json` SHALL be a JSON Schema (draft 2020-12) of the `--format=json` envelope, generated from the zod schema by `pnpm run schema`, included in the package (`files`), and printed by `dot-test-digest schema`. A test SHALL fail when the committed file differs from the regenerated one, and SHALL validate real envelopes against it.

#### Scenario: The committed file matches the generator
- **GIVEN** the repository at the commit under test
- **WHEN** `pnpm run schema` regenerates the schema to a temporary path
- **THEN** it is byte-identical to `schema/digest-envelope.schema.json`

#### Scenario: Real envelopes validate
- **GIVEN** the cart
- **WHEN** the JSON of `-- node --test passing.test.js`, of `-- node --test cart.test.js`, and of `--tdd-phase=red --scope-id=s1 -- node --test cart.test.js` is validated against the schema
- **THEN** all three validate

#### Scenario: The schema subcommand prints the file
- **GIVEN** any home
- **WHEN** `schema` runs
- **THEN** stdout equals the content of `schema/digest-envelope.schema.json` and the exit code is `0`

### Requirement: ndjson gives one JSON object per line
`--format=ndjson` SHALL print a first line `{"type":"summary", ...}` with every top-level key of the JSON envelope except `clusters` (including `schema_version`, `run_id`, `summary`), then one `{"type":"cluster", ...}` line per kept cluster (the cluster's keys), then one `{"type":"omitted","cluster_id":...,"error_kind":...,"affected_count":...,"top_frame":...,"label":...,"raw_log_lines":...}` line per omitted cluster. Every line SHALL be valid JSON ending in `\n`. There is no byte ceiling. Colors never apply.

#### Scenario: The cart as ndjson
- **GIVEN** the cart and a fresh home
- **WHEN** `--format=ndjson --max-clusters=2 -- node --test cart.test.js` runs
- **THEN** stdout has 5 lines, each parsing as JSON, with `type` values `summary`, `cluster`, `cluster`, `omitted`, `omitted`
- **AND** the summary line has `status` `"FAIL"`, `exit_code` `1` and `summary.total_clusters` `2`
- **AND** the two `omitted` lines carry the ids `c_fdff652c` and `c_53a8182a` (in rank order)

#### Scenario: A pass is one line
- **GIVEN** the cart
- **WHEN** `--format=ndjson -- node --test passing.test.js` runs
- **THEN** stdout is exactly one line, a `summary` object with `status` `"PASS"`

#### Scenario: The format is accepted wherever json is
- **GIVEN** the cart
- **WHEN** `replay last --format=ndjson` runs after a run
- **THEN** the output has the same line types as the live ndjson of that run
