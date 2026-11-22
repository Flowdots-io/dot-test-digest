## ADDED Requirements

### Requirement: stats totals the bytes and tokens the digests saved
`stats [--last N] [--json]` SHALL read the run records in the cache (all directories) and print five lines: `runs: <n>`, `raw bytes: <sum of raw_bytes>`, `digest bytes: <sum of digest_bytes>`, `saved: <raw - digest> bytes (<p>%), about <t> tokens`, and `status: <S1> <n1>, <S2> <n2>, ...` (statuses sorted alphabetically). `<p>` is `(raw - digest) / raw * 100` rounded to one decimal (`0.0` when raw is `0`); `<t>` is `ceil((raw - digest) / 4)`, the tool's own EstimatedToken rule, and is `0` when the saving is not positive. `--last N` limits to the N newest records by `created_at`. `--json` prints one JSON object with `runs`, `raw_bytes`, `digest_bytes`, `saved_bytes`, `saved_percent`, `estimated_tokens_saved` and `statuses` (an object). With no records the output is the single line `runs: 0` (JSON: the same keys with zeros and `{}`). The exit code is `0`.

#### Scenario: Three recorded runs
- **GIVEN** a home with three records: `raw_bytes` 10000 / `digest_bytes` 1500 / `status` `FAIL`; 4000 / 200 / `PASS`; 2000 / 150 / `PASS`
- **WHEN** `stats` runs
- **THEN** stdout is exactly the five lines `runs: 3`, `raw bytes: 16000`, `digest bytes: 1850`, `saved: 14150 bytes (88.4%), about 3538 tokens`, `status: FAIL 1, PASS 2`

#### Scenario: stats as JSON
- **GIVEN** the same home
- **WHEN** `stats --json` runs
- **THEN** stdout parses as `{ "runs": 3, "raw_bytes": 16000, "digest_bytes": 1850, "saved_bytes": 14150, "saved_percent": 88.4, "estimated_tokens_saved": 3538, "statuses": { "FAIL": 1, "PASS": 2 } }`

#### Scenario: Only the newest runs
- **GIVEN** the same home, where the `FAIL` record is the oldest
- **WHEN** `stats --last 2` runs
- **THEN** `runs: 2`, `raw bytes: 6000`, `digest bytes: 350`, `saved: 5650 bytes (94.2%), about 1413 tokens`, `status: PASS 2`

#### Scenario: A digest larger than its raw output does not count as negative tokens
- **GIVEN** a home with one record of `raw_bytes` 100 and `digest_bytes` 130
- **WHEN** `stats` runs
- **THEN** the saved line is `saved: -30 bytes (-30.0%), about 0 tokens`

#### Scenario: No records
- **GIVEN** a fresh home
- **WHEN** `stats` runs
- **THEN** stdout is `runs: 0` and the exit code is `0`

#### Scenario: A real run is counted
- **GIVEN** the cart and a fresh home, after `-- node --test cart.test.js`
- **WHEN** `stats --json` runs
- **THEN** `runs` is `1`, `raw_bytes` equals the size of the log, `digest_bytes` equals the bytes the run wrote to stdout, and `statuses` is `{ "FAIL": 1 }`
