# Pass digest

A passing run is one line of at most 160 bytes (final newline included), however many lines the child printed. The complete raw output is kept in a log file whose path is in the line.

## Sub-features

- `pass-line` one `[PASS] <n> passed, 0 failed in <t>ms | log: <path>` line, exit `0`.
- `pass-skipped` skipped and todo tests add `, <n> skipped`, lint warnings add `, <n> warnings`, each only when nonzero.
- `pass-uncounted` output no grammar recognised gives `[PASS] exit 0 in <t>ms | log: <path>`.
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
- **vitest.** `$V drive $RUN vitest-pass vitest-cart -- vitest run --testNamePattern=subtotal`. Exit `0`; `[PASS] 21 passed, 0 failed, 8 skipped in <t>ms | log: <path>` (vitest counts the 8 tests the pattern filtered out as skipped).
- **Noise.** `$V drive $RUN noise - -- sh -c 'for i in $(seq 1 2500); do echo "ok test $i"; done'`. Exit `0`; `[PASS] exit 0 in <t>ms | log: <path>` (no grammar recognises these lines, so there are no counts), and `wc -c < evidence/noise/stdout.txt` is at most `160` (measured 116 on the 0.2.0 build with the helper's `home/` path; the size moves with the length of that path).
- **Skipped and todo.** `printf 'import test from "node:test";\ntest("a", () => {});\ntest("b", { skip: true }, () => {});\ntest("c", { todo: true }, () => {});\n' > $(cat .acceptance/verify/$RUN/workdir)/node-cart/sk.test.js`, then `$V drive $RUN skip node-cart -- node --test sk.test.js`. Exit `0`; `[PASS] 1 passed, 0 failed, 2 skipped in <t>ms | log: <path>`.
- **eslint warnings.** `printf '/abs/src/a.ts\n  3:5  warning  x is unused  no-unused-vars\n  4:5  warning  y is unused  no-unused-vars\n  5:5  warning  z is unused  no-unused-vars\n' > $(cat .acceptance/verify/$RUN/workdir)/lint.txt`, then `$V drive $RUN lint - -- sh -c 'cat lint.txt; exit 0'`. Exit `0`; `[PASS] 0 passed, 0 failed, 3 warnings in <t>ms | log: <path>`; with `--format=json` the `summary` is `{ "passed": 0, "failed": 0, "skipped": 0, "warnings": 3, "total_clusters": 0 }`.
- **Log keeps everything.** `wc -l` of the log file named in the header is `2500` for the noise run, and its first line is `ok test 1`.

## Gotchas

- The log path is shortened to `~/...` only when it is under the user's home; inside a verification run the path is the long isolated one, so a pass line can reach 160 bytes and be cut with `...`. The ceiling is the proof, not the full path.
- A run that prints nothing recognisable but exits 0 is `[PASS] exit 0`, with no counts; counts come from a grammar, not from the exit code. A run a grammar matched keeps its counts even when they are zero (a file whose only test is skipped reads `0 passed, 0 failed, 1 skipped`). An empty `node --test` file is not a zero: node reports the file itself as one passing test.
- eslint warnings need at least three diagnostic lines before the `tsc-eslint` grammar is picked; with fewer the output is unrecognised (`exit 0`).
- `--format=json` is exempt from the 160-byte ceiling (see [json-envelope.md](./json-envelope.md)).
