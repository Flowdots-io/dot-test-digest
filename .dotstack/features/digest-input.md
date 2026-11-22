# Digest input

`digest <file|-> [--exit-code N] [--format F] [--max-clusters N] [--context-lines N] [--no-jev]` turns a log that already exists (a CI job's output, a pasted log, stdin) into the digest a wrapped run would print. The lines are copied verbatim to a new `logs/<run>.log`, so `raw:` pointers are the input's line numbers; the run is recorded with `source: "digest"`, `command: []` and `input` (the path as given, or `"-"`), and the cache is pruned afterwards as after a run. The header has no `in <t>ms` segment and the JSON envelope has `duration_ms: 0`. The exit code is `--exit-code`, else `1` when a grammar found a failure and `0` otherwise.

## Sub-features

- `digest-file` `digest <file>` prints the digest of the file; the size rules are a run's (the 5-line `tsc-small/tsc.log` gives the header plus the 5 raw lines).
- `digest-exit` without `--exit-code` the exit is `1` when a grammar found a failure, else `0` (a log of `all good` prints `[PASS] exit 0 | log: ...`); `--exit-code N` (`0` to `255`, also `--exit-code=N`) is the exit and the code the pipeline sees.
- `digest-stdin` `digest -` reads stdin; same stdout and exit as the file, except for the log path; with a terminal on stdin it exits `64` with `no input: pipe a log into "digest -"`.
- `digest-record` the record has `source` `"digest"`, `command` `[]`, `input`, `duration_ms` `0`, `phase` `"none"`; `show last`, `show last L<a>-L<b>`, `replay last` (byte-identical to the digest, also without `in <t>ms`) and `stats` read it like a run's.
- `digest-foreign` source windows are read from the working directory and left out when the file does not exist there (a log from another machine still gives its clusters).
- `digest-confined` a frame whose file is outside the working directory (absolute path, `../`, or a symlink pointing out, by real path) gets no window, in `digest` and in `replay` of a digest record; the cluster stays. Live runs are not confined.
- `digest-flags` `--no-jev` also as `--no-jev=true|false` (overrides `noJev` from the configuration; another value exits 64 `--no-jev accepts only true or false, got <v>`); `--` ends the flags, so `digest -- -name.log` reads a file named `-name.log`.
- `digest-errors` empty input exits `64` `input is empty`; an unreadable file `66` `cannot read <path>: <code>` (`ENOENT`, `EISDIR`); `--exit-code` not an integer in 0..255 `64` `--exit-code must be an integer between 0 and 255, got <value>`; `--tdd-phase` `64` `--tdd-phase is not supported by digest`; an unknown flag `64` `unknown flag: <flag>`; no input argument `64` `digest needs a file or -: ...`.
- `digest-jev` Gear 1 runs as for a run when the exit code is non-zero, no grammar found a failure and the log has more than 150 lines (only reachable with an explicit non-zero `--exit-code`); `--no-jev` or `noJev` keeps it local.

## How to get to it (user POV)

- In CI: `pnpm test 2>&1 | tee test.log > /dev/null && status=0 || status=$?`, then `dot-test-digest digest test.log --exit-code "$status" --no-jev`.
- With a log someone sent: `dot-test-digest digest their.log`, then `dot-test-digest show last L<a>-L<b>` to read the lines a cluster points at.
- From a pipe: `kubectl logs job/tests | dot-test-digest digest -`.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done, `H=.acceptance/verify/$RUN/home`, `W=$(cat .acceptance/verify/$RUN/workdir)`.
- `verify.sh` appends `--no-jev` to a `digest` drive (after the subcommand's own arguments), so Gear 1 is never called.
- Prod: not safe (each digest writes a log and a record in the run's `home/`).

- **Compiler log.** `$V drive $RUN dtsc tsc-small digest tsc.log --exit-code 2`. Exit `2`; header `[FAIL] 5 failed, 0 passed | 5 clusters | log: ...` with no `in <t>ms`; the rest of stdout is `cmp`-equal to `$W/tsc-small/tsc.log`.
- **Inferred exit.** `$V drive $RUN dtsc1 tsc-small digest tsc.log` exits `1`; `printf 'all good\n' > $W/tsc-small/ok.log`, then `$V drive $RUN dok tsc-small digest ok.log` exits `0` with `[PASS] exit 0 | log: ...`.
- **Foreign TAP log.** `cp tests/fixtures/logs/node-tap-cart.log $W/node-cart/tap.log`, `$V drive $RUN dtap node-cart digest tap.log`. Exit `1`; header `[FAIL] 4 failed, 2 passed | 4 clusters | ...`; the four failing tests (`discount 10% leaves 90%`, `total with 10% off`, `total with 100% off is free`, `first of an empty cart is undefined`) appear; no source window (the paths are `__ROOT__/...`).
- **Read back.** Then `$V drive $RUN dshow node-cart show last L15-L17`: stdout is `sed -n 15,17p` of the TAP log; `$V drive $RUN drec node-cart show last --record` shows `"source": "digest"`, `"command": []`, `"input": "tap.log"`.
- **JSON.** `$V drive $RUN djson node-cart digest tap.log --format=json`: `status` `FAIL`, `exit_code` `1`, `duration_ms` `0`.
- **stdin.** Outside the helper (it does not pipe stdin), with `R=$PWD/.acceptance/verify/$RUN`: `(cd $W/node-cart && DOT_TEST_DIGEST_HOME=$R/home XDG_CONFIG_HOME=$R/xdg node $R/build/index.js digest - --no-jev < tap.log)`. Exit `1`; stdout equals `evidence/dtap/stdout.txt` once `run_<id>` is masked in both.
- **Errors.** `: > $W/node-cart/empty.log`; `digest empty.log` exits `64` `input is empty`; `digest missing.log` exits `66` `cannot read missing.log: ENOENT`; `digest tap.log --exit-code 300` exits `64`; `digest tap.log --tdd-phase=red` exits `64` `--tdd-phase is not supported by digest`.

## Gotchas

- `input` in the record is the path as typed, relative to the directory the digest ran in; `last` is scoped to that directory too.
- Cluster ids hash the paths in the log, so the same failures logged under another root get other ids than a live run here.
- A log without a trailing newline is stored with one; the line numbers are unchanged.
- Input is decoded as UTF-8, as a live run's output is: invalid bytes become U+FFFD in the copied log, so `raw_bytes` can differ from the input file's size.
- `digest -` from an interactive shell without a pipe refuses at once instead of waiting for input.
- The automatic prune runs after a digest as after a run: digesting many logs in a fresh home can delete older runs beyond the newest 50 that are older than 14 days.
