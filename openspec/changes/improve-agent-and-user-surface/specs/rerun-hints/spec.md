## ADDED Requirements

### Requirement: A cluster carries the command that reruns its first test
Each cluster that has a first sample test SHALL carry an optional `rerun` string when the runner is known: it is the wrapped command's prefix up to and including the runner token, followed by the arguments below, with every argument quoted for a POSIX shell (single quotes, an embedded `'` written `'\''`; an argument made only of `A-Za-z0-9_@%+=:,./-` is not quoted). The runner token is the first element of the command whose basename is `vitest`, `jest`, `pytest`, `cargo`, `go`, `eslint` or `node` (`node` only when `--test` follows); for `python -m pytest` the prefix includes `-m pytest`. When the command has no runner token (`pnpm test`, `npm test`, `make test`) or the grammar gives no test name, no `rerun` is set. The test name used is the leaf (the text after the last ` > `), with regular-expression metacharacters escaped where the runner takes a pattern. `compact-md` SHALL print `  rerun: <command>` as the row before `raw:` on the first full block only, at size levels 1 and 2; JSON and ndjson carry `rerun` on every cluster that has one.

| Runner | `rerun` |
| --- | --- |
| `node --test` | `<prefix> --test-name-pattern '^<escaped leaf>$' <file>` (the prefix is `node --test`) |
| `vitest` | `<prefix> run <file> -t '<escaped leaf>'` |
| `jest` | `<prefix> <file> -t '<escaped leaf>'` |
| `pytest` | `<prefix> <file>::<name>` |
| `cargo` | `cargo test <name> -- --exact` |
| `go` | `go test -run '^<name>$' ./...` |
| `eslint` | `<prefix> <file>` |

`tsc` clusters have no rerun.

#### Scenario: rerun for node --test
- **GIVEN** the cart
- **WHEN** `--format=json -- node --test cart.test.js` runs
- **THEN** the cluster `c_9721831d` has `rerun` `node --test --test-name-pattern '^discount 10% leaves 90%$' cart.test.js`

#### Scenario: The rerun command really reruns that one test
- **GIVEN** the cart and the `rerun` string above
- **WHEN** it is executed through `sh -c`
- **THEN** the node output reports `# tests 1`, `# pass 0` and `# fail 1`

#### Scenario: vitest, with a prefix from the command
- **GIVEN** the vitest cart fixture and a fresh home
- **WHEN** `--format=json -- npx vitest run` runs
- **THEN** the cluster `c_992bb564` has `rerun` `npx vitest run tests/cart.test.ts -t 'discount 10% leaves 90%'`

#### Scenario: vitest, executed
- **GIVEN** the string above
- **WHEN** it runs in the fixture
- **THEN** vitest reports `1 failed | 28 skipped (29)`

#### Scenario: Regular-expression characters in a name are escaped and quoted
- **GIVEN** a failure of the test `parses a.b (v2)` in `cart.test.js` under `node --test`
- **WHEN** the cluster is built
- **THEN** `rerun` is `node --test --test-name-pattern '^parses a\.b \(v2\)$' cart.test.js`

#### Scenario: A single quote in a name is escaped for the shell
- **GIVEN** a failure of the test `it's broken` under `node --test`
- **WHEN** the cluster is built
- **THEN** `rerun` contains `--test-name-pattern '^it'\''s broken$'`

#### Scenario: A wrapped script has no runner token
- **GIVEN** a failing node test
- **WHEN** it runs as `-- pnpm test`
- **THEN** the JSON clusters have no `rerun` key and the digest has no `rerun:` row

#### Scenario: pytest, cargo, go and eslint from fixtures
- **GIVEN** the grammars' fixture logs (adapter seam, command `["pytest","-q"]`, `["cargo","test"]`, `["go","test","./..."]`, `["eslint","."]`)
- **WHEN** `pythonAdapter.parse`, `rustGoAdapter.parse` and `tscEslintAdapter.parse` build clusters for `tests/test_cart.py::test_total`, the cargo test `cart::tests::total`, the go test `TestTotal`, and the file `/abs/src/a.ts`
- **THEN** the `rerun` values are `pytest tests/test_cart.py::test_total` (the prefix stops at the runner token, so `-q` is dropped), `cargo test cart::tests::total -- --exact`, `go test -run '^TestTotal$' ./...` and `eslint /abs/src/a.ts`
- **AND** the README and the feature map list these four as checked against fixtures only

#### Scenario: tsc has no rerun
- **GIVEN** `tests/fixtures/tsc-small`
- **WHEN** `--format=json -- tsc --noEmit` runs
- **THEN** no cluster has `rerun`

#### Scenario: The row appears on the first block only
- **GIVEN** the cart
- **WHEN** `-- node --test cart.test.js` runs
- **THEN** the digest contains exactly one line starting `  rerun: `, and it is inside the first block, directly before that block's `  raw: ` line
