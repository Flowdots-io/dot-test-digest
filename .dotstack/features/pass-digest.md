# Pass digest

A passing run is one line of at most 160 bytes (final newline included), however many lines the child printed. The complete raw output is kept in a log file whose path is in the line.

## Sub-features

- `pass-line` one `[PASS] <n> passed, 0 failed in <t>ms | log: <path>` line, exit `0`.
- `pass-ceiling` stdout is at most 160 bytes, also for 2,500 lines of child output.
- `pass-log` the log file holds every line the child printed.
- `pass-phase` with `--tdd-phase=green|refactor` the header is `[PASS | GREEN]` / `[PASS | REFACTOR]` (see [tdd-gate.md](./tdd-gate.md)).

## How to get to it (user POV)

- Run `dot-test-digest -- <test command>` on a project whose tests all pass.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test.
- Prod: not safe (writes a raw log under the run's isolated cache home).

- **node --test.** `$V drive $RUN pass node-cart -- node --test passing.test.js`. Exit `0`; stdout is one line `[PASS] 1 passed, 0 failed in <t>ms | log: <path>`.
- **vitest.** `$V drive $RUN vitest-pass vitest-cart -- vitest run --testNamePattern=subtotal`. Exit `0`; `[PASS] 21 passed, 0 failed in <t>ms | log: <path>`.
- **Noise.** `$V drive $RUN noise - -- sh -c 'for i in $(seq 1 2500); do echo "ok test $i"; done'`. Exit `0`; `[PASS] 0 passed, 0 failed in <t>ms | log: <path>` (no grammar counts these lines), and `wc -c < evidence/noise/stdout.txt` is at most `160` (measured 136).
- **Log keeps everything.** `wc -l` of the log file named in the header is `2500` for the noise run, and its first line is `ok test 1`.

## Gotchas

- The log path is shortened to `~/...` only when it is under the user's home; inside a verification run the path is the long isolated one, so a pass line can reach 160 bytes and be cut with `...`. The ceiling is the proof, not the full path.
- A run that prints nothing recognisable but exits 0 is still `[PASS]` with `0 passed`; counts come from a grammar, not from the exit code.
- `--format=json` is exempt from the 160-byte ceiling (see [json-envelope.md](./json-envelope.md)).
