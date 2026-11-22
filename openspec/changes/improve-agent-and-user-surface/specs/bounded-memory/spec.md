## ADDED Requirements

### Requirement: Output is read back from the log instead of held in memory
The tool SHALL give the adapters a `LineSource` (`count`, `at(n)`, `slice(from, to)`, iteration) instead of an array of every captured line. Output up to 4 MiB SHALL be held in memory; larger output SHALL be read back from the log file through a cache of at most 8 MiB of chunks. The raw text for size level 5 SHALL only be built when the output is at most 2,400 bytes. Memory use SHALL therefore not grow with the number of lines that no failure refers to. The digest SHALL be byte-identical to the one the array-based pipeline produced.

#### Scenario: Four hundred thousand lines under a small heap
- **GIVEN** a fresh home and the tool spawned as `node --max-old-space-size=96 dist/index.js --no-jev -- node -e "for(let i=0;i<400000;i++)console.log('line '+i+' some padding text to make it longer than usual')"` (v0.1.x exits `134` with a V8 out-of-memory abort here)
- **WHEN** the process exits
- **THEN** the exit code is `0`, stdout matches `^\[PASS\] exit 0 in <t>ms \| log: \S+\.log\n$`, and the log has 400,000 lines

#### Scenario: A failure in the middle of a huge output is still found
- **GIVEN** a fresh home and a child that prints 200,000 filler lines (`filler <i>`), then the whole content of `tests/fixtures/logs/node-tap-cart.log` (120 lines), then 200,000 more filler lines, and exits `1`, spawned under `--max-old-space-size=96`
- **WHEN** it runs
- **THEN** the exit code is `1`, the JSON digest has a cluster for the test `discount 10% leaves 90%` whose `raw_log_lines` is `L200015-L200039`, and `show last L200015-L200016` prints the first two lines of that range

#### Scenario: Small outputs are not read from disk
- **GIVEN** the cart
- **WHEN** `-- node --test cart.test.js` runs with a `LineSource` factory spy
- **THEN** the source was created in memory mode (output under 4 MiB) and the log file was not re-read by the adapters

#### Scenario: Every existing digest is unchanged
- **GIVEN** the 296 tests of v0.1.x, unmodified except for the input type of the adapters
- **WHEN** `pnpm run verify` runs
- **THEN** all of them pass

#### Scenario: A file-backed source gives the same digest as the in-memory one
- **GIVEN** the cart log and the vitest cart log, with the threshold for file-backed sources forced to 0 bytes in a test
- **WHEN** both are digested in `compact-md` and `json`
- **THEN** the four outputs equal those produced with the in-memory source, byte for byte

#### Scenario: The raw text is built only for tiny outputs
- **GIVEN** a child whose output is 3,000 bytes of unrecognized text and exits `1`
- **WHEN** it runs
- **THEN** the size ladder is evaluated without materializing the raw text (the `LineSource` reports no full read), and the digest is the same as before this change

#### Scenario: The time cost stays bounded
- **GIVEN** the 400,000-line run above without a heap limit
- **WHEN** it runs
- **THEN** it completes in under 15 seconds (v0.1.x: 1.8 seconds)

### Requirement: The run record states the size of the output it saw
The record's `raw_lines` and `raw_bytes` SHALL equal the number of lines and bytes of the log for every run, including runs larger than the in-memory threshold.

#### Scenario: A large run
- **GIVEN** the 400,000-line run
- **WHEN** it completes
- **THEN** the record has `raw_lines` `400000` and `raw_bytes` equal to the size of the log file
