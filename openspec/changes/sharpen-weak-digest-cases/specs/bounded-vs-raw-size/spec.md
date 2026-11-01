## ADDED Requirements

### Requirement: A compact-md failure digest is never larger than the raw output plus its header line
For every run rendered as a clustered body in `compact-md` (every status except `PASS` and `VALID_RED`), stdout SHALL be at most `R + H` bytes, where:
- `R` be the UTF-8 byte length of the captured stream after Gear 0 normalisation (ANSI stripped, carriage-return overwrites collapsed, SPEC-002 §4.2), counting one `\n` after every line;
- `H` be the byte length of the first stdout line (the header: status, counts, cluster count, `log:` pointer) including its `\n`;
- `D` be the total bytes written to stdout, including the trailing `\n`.

The runtime SHALL emit `D <= R + H`, and `D <= 2400` (INV-2) MUST keep holding. It SHALL pick the first of these levels whose output, after INV-2's budget handling, satisfies `D <= R + H`:
1. **Full**: today's cluster blocks (header row, message, `diff:` row, stack rows, SignalWindow rows, `tests:` row, `raw:` row).
2. **No windows**: level 1 without SignalWindow rows.
3. **No stack**: level 2 without stack rows.
4. **One line per cluster**: `<cluster_id> <error_kind> x<affected_count> <top_frame> <raw_log_lines> <message>`, message truncated to 240 bytes as today.
5. **Raw**: the header line followed by the normalised stream, verbatim (so `D = H + R`; with `R = 0` stdout is the header line alone).

Level 5 is reached only when the raw text is smaller than every clustered rendering; its header reports the number of clusters in the envelope. Omitted-cluster footers (see `omitted-cluster-visibility`) count toward `D` at levels 1 to 4; level 5 needs none because nothing is omitted. The header line and its `log:` pointer are present at every level, and every `raw:` range that is printed MUST resolve to lines of that log file. `PASS` and `VALID_RED` one-liners stay governed by INV-1 only. `--format=json` output MUST NOT change.

#### Scenario: Five tsc errors print the raw diagnostics under the header
- **GIVEN** the working directory is a fresh copy of `tests/fixtures/tsc-small/` (`src/a.ts`, `src/b.ts`, `tsconfig.json` and `tsc.log`, all copied byte for byte from `/tmp/dtd-work/tscproj/`; `tsc.log` is that directory's `raw-tsc.txt`, 5 lines, 419 bytes, the first being `src/a.ts(2,14): error TS2322: Type 'number' is not assignable to type 'string'.`)
- **WHEN** `dot-test-digest --no-jev -- node -e "process.stdout.write(require('node:fs').readFileSync('tsc.log','utf8')); process.exit(2)"` runs
- **THEN** the exit code is `2`
- **AND** the first stdout line matches `^\[FAIL\] 5 failed, 0 passed in \d+ms \| 5 clusters \| log: \S+\.log$`
- **AND** the rest of stdout is exactly the 419 bytes of `tsc.log`, so stdout is `419 + H` bytes (v0.1.2 printed 1,538 bytes)

#### Scenario: The JSON envelope of the same run is unchanged
- **GIVEN** the same working directory
- **WHEN** the same command runs with `--format=json`
- **THEN** the exit code is `2`, `summary.total_clusters` is `5`, every cluster has a non-empty `signal_window`, and the first cluster has `top_frame` `src/a.ts:2:14` and `pruned_stack` `["src/a.ts:2:14"]`

#### Scenario: Each level is chosen at its exact threshold
- **GIVEN** an envelope with `status` `FAIL`, `tdd_phase` `none`, `duration_ms` `10`, `summary` `{ passed: 0, failed: 1, skipped: 0 }`, `raw_log_path` `/tmp/logs/run_a.log`, and one cluster: `cluster_id` `c_0123abcd`, `error_kind` `ASSERTION_FAILURE`, `affected_count` `1`, `top_frame` `src/cart.ts:3:10`, `message` `AssertionError: expected 100 to be 900`, `diff` `{ expected: "900", received: "100" }`, `pruned_stack` `["src/cart.ts:3:10", "at total (src/cart.ts:5:20)"]`, `sample_tests` `["cart > discount 10% leaves 90%"]`, `raw_log_lines` `L5-L27`, and a `signal_window` of these 5 rows: `1 | export const subtotal = (n: number) => n;`, `2 | export const tax = (n: number) => Math.round(n * 0.21);`, `3 > export const discount = (n: number, p: number) => n - Math.round((n * p) / 10);`, `4 | export const total = (n: number) => discount(n, 0) + tax(n);`, `5 | export const first = (items: string[]) => items[0];`
- **AND** the header line is `[FAIL] 1 failed, 0 passed in 10ms | 1 cluster | log: /tmp/logs/run_a.log` (`H` = 73)
- **WHEN** `formatEnvelope(envelope, "compact-md", { rawText })` is called with `rawText` = `"r"` repeated `R - 1` times plus `"\n"`
- **THEN** for `R = 531` the output is level 1 (604 bytes: header, cluster header row, message, `diff: expected 900 / received 100`, `at total (src/cart.ts:5:20)`, the 5 window rows, `tests: cart > discount 10% leaves 90%`, `raw: L5-L27`, each continuation row indented by two spaces)
- **AND** for `R = 530` it is level 2 (283 bytes: the same without the 5 window rows)
- **AND** for `R = 200` it is level 3 (253 bytes: level 2 without the `at total` row)
- **AND** for `R = 120` it is level 4, exactly `[FAIL] 1 failed, 0 passed in 10ms | 1 cluster | log: /tmp/logs/run_a.log\nc_0123abcd ASSERTION_FAILURE x1 src/cart.ts:3:10 L5-L27 AssertionError: expected 100 to be 900\n` (168 bytes)
- **AND** for `R = 60` it is level 5, exactly the header line, `\n`, and `rawText` (133 bytes)

#### Scenario: Without raw text the size rule is not applied
- **GIVEN** the same envelope
- **WHEN** `formatEnvelope(envelope, "compact-md")` is called with no render context
- **THEN** the output is the level-1 rendering (604 bytes), so existing callers and `tests/envelope.spec.ts` keep their behavior

#### Scenario: A failure with no output prints only the header
- **WHEN** `dot-test-digest --no-jev -- node -e "process.exit(3)"` runs
- **THEN** the exit code is `3` and stdout is exactly one line matching `^\[BUILD_ERROR\] 0 failed, 0 passed in \d+ms \| 1 cluster \| log: \S+\.log$`
- **AND** with `--format=json` the same command still reports one `UNSTRUCTURED_BUILD_ERROR` cluster

#### Scenario: A tiny unstructured failure prints the header and the raw line
- **WHEN** `dot-test-digest --no-jev -- node -e "console.log('boom'); process.exit(1)"` runs
- **THEN** the exit code is `1` and stdout is exactly the header line, `\n`, `boom`, `\n` (v0.1.2 printed `boom` twice inside a cluster block)

#### Scenario: Large raw output keeps the full form and INV-2
- **GIVEN** the CT-2 cascade child of `tests/cli.spec.ts` (`vitestCascadeOutput(50, 35)`, more than 1,900 raw lines, exit 1) with that test's setup, so `src/auth/jwt.ts` is readable
- **WHEN** it runs through `dot-test-digest` in `compact-md`
- **THEN** the exit code is `1`, stdout contains `RUNTIME_EXCEPTION x50` and a SignalWindow row starting with `28 > ` (level 1), and stdout is at most 600 EstimatedTokens; the existing CT-2 assertions in `tests/cli.spec.ts` are unchanged and pass

#### Scenario: The log pointer resolves at every level
- **GIVEN** the tsc-small run above (level 5) and the `boom` run above
- **WHEN** the `log:` path in each header is read (with a leading `~` expanded to the home directory)
- **THEN** the file exists and its bytes equal the child's output (`tsc.log`'s 419 bytes; `boom\n`)

### Requirement: A stack row equal to top_frame is not rendered
In `compact-md`, a `pruned_stack` entry whose text equals the cluster's `top_frame` SHALL NOT be rendered as a stack row, because the cluster header row already shows it. The JSON `pruned_stack` MUST keep the entry.

#### Scenario: The duplicate row is dropped and the other frames stay
- **GIVEN** the envelope of the threshold scenario above
- **WHEN** `formatEnvelope(envelope, "compact-md")` is called
- **THEN** no output line equals `  src/cart.ts:3:10`, one line equals `  at total (src/cart.ts:5:20)`, and `formatEnvelope(envelope, "json")` still has `pruned_stack` `["src/cart.ts:3:10", "at total (src/cart.ts:5:20)"]`
