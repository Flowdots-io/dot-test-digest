## ADDED Requirements

### Requirement: The status word can be colored for a terminal
`--color auto|always|never` (default from configuration, `auto`) SHALL control ANSI color. The only colored text is the status word inside the header brackets, wrapped in an SGR color and a reset: green (`32`) for `PASS` and `VALID_RED`, red (`31`) for `FAIL`, `INVALID_RED`, `INVALID_GREEN`, `REGRESSION_DETECTED` and `BUILD_ERROR`. `auto` colors only when stdout is a terminal, `NO_COLOR` is unset or empty, and `TERM` is not `dumb`; `always` colors regardless of `NO_COLOR`; `never` never colors. The byte ceilings (INV-1, INV-2, the size rule) are evaluated on the uncolored text; removing the SGR sequences from colored output SHALL give exactly the uncolored output. `--format=json` and `--format=ndjson` are never colored.

#### Scenario: always colors a pass line
- **GIVEN** the cart
- **WHEN** `--color=always -- node --test passing.test.js` runs
- **THEN** the header starts with `[\u001b[32mPASS\u001b[0m] 1 passed, 0 failed`

#### Scenario: always colors a failure red
- **GIVEN** the cart
- **WHEN** `--color=always -- node --test cart.test.js` runs
- **THEN** the header starts with `[\u001b[31mFAIL\u001b[0m] 4 failed, 2 passed`

#### Scenario: Stripping the color gives the plain output
- **GIVEN** the same two runs repeated with `--color=never`
- **WHEN** the SGR sequences are removed from the colored outputs
- **THEN** each equals the `--color=never` output once the run-specific durations and log paths are masked

#### Scenario: Auto is plain when stdout is not a terminal
- **GIVEN** `main` is called with `deps.stdoutIsTTY` `false`
- **WHEN** `-- node --test passing.test.js` runs
- **THEN** stdout contains no `\u001b`

#### Scenario: Auto colors on a terminal unless NO_COLOR is set
- **GIVEN** `main` is called with `deps.stdoutIsTTY` `true`
- **WHEN** `-- node --test passing.test.js` runs with `NO_COLOR` unset, then with `NO_COLOR=1`, then with `NO_COLOR=1 --color=always`
- **THEN** the first output contains `\u001b[32m`, the second none, and the third contains `\u001b[32m`

#### Scenario: JSON is never colored
- **GIVEN** the cart
- **WHEN** `--color=always --format=json -- node --test passing.test.js` runs
- **THEN** stdout contains no `\u001b` and parses as JSON

#### Scenario: A bad color value is a usage error
- **GIVEN** any home
- **WHEN** `--color=blue -- true` runs
- **THEN** the exit code is `64` and stderr is `--color must be auto, always or never`
