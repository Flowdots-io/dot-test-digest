# Progress and large outputs

`--progress` (or `"progress": true` in a config file, or `DOT_TEST_DIGEST_PROGRESS=1`) prints `dot-test-digest: running... <N> lines, <S>s` on `stderr` every 10 seconds while the wrapped command runs, where `N` is the number of lines written to the log so far and `S` the elapsed seconds with one decimal. On a terminal each heartbeat overwrites the previous one (`\r`) and the last is cleared (`\r\u001b[K`) before the digest is printed; on a pipe each heartbeat is its own line. Nothing goes to `stdout`, and the exit code and the digest are unchanged. Separately, a run's memory no longer grows with its output: up to 4 MiB of output is held in memory, and above that the grammars read the lines back from the log through a cache of at most 8 MiB. `digest`, `replay` and `show` read their logs the same way.

## Sub-features

- `progress-beat` with `--progress` and a child that runs longer than the interval, `stderr` has heartbeat lines matching `^dot-test-digest: running\.\.\. \d+ lines, \d+\.\ds$`; `stdout` is the normal digest and the exit code is the child's.
- `progress-off` without the flag, `progress`, or the variable, `stderr` carries nothing from this feature; `--progress=false` turns a configured `progress: true` off for one run.
- `progress-fast` a child that finishes before the first interval (10 s by default) prints no heartbeat.
- `progress-json` `--progress --format=json`: `stdout` is still one JSON document.
- `progress-tty` on a terminal the heartbeat overwrites itself and is cleared before the digest (unit-tested through `main` with `stderrIsTTY`; not driven here, since `verify.sh` captures `stderr` to a file).
- `memory-large` 400,000 lines of output under `node --max-old-space-size=96` exit `0` with the one-line pass digest (0.1.x aborted with exit `134`); the record's `raw_lines` and `raw_bytes` are the log's line count and size.
- `memory-middle` a failure printed between 200,000 filler lines on each side is still found, with `raw:` pointers into the middle of the log, and `show last L<a>-L<b>` prints those lines.

## How to get to it (user POV)

- A long suite in CI that would otherwise look stuck: `dot-test-digest --progress -- pnpm test`.
- Always on for a project: `{ "progress": true }` in `.dot-test-digest.json`.
- A build with a very large log: nothing to do; the digest is the same, and the tool's memory stays bounded.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done, `R=$PWD/.acceptance/verify/$RUN`, `W=$(cat $R/workdir)`.
- `DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS` shortens the 10-second interval; `verify.sh drive` passes the caller's environment through, so set it in front of the command.
- Prod: not safe (each drive writes a log and a record in the run's `home/`).

- **Heartbeats.** `DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS=300 $V drive $RUN pbeat - --progress -- sh -c "echo a; sleep 1.2; echo b"`. Exit `0`; `stdout` is `[PASS] exit 0 in <t>ms | log: ...`; `evidence/pbeat/stderr.txt` has at least 2 lines like `dot-test-digest: running... 1 lines, 0.3s`.
- **Off by default.** The same without `--progress` (label `pquiet`): `stderr.txt` is empty.
- **JSON.** `DOT_TEST_DIGEST_PROGRESS_INTERVAL_MS=300 $V drive $RUN pjson - --progress --format=json -- sh -c "echo a; sleep 1.2; echo b"`: `jq . evidence/pjson/stdout.txt` succeeds.
- **Fast child.** `$V drive $RUN pfast node-cart --progress -- node --test passing.test.js`: exit `0`, `stderr.txt` empty.
- **Small heap.** Outside the helper (it cannot pass node flags): `(cd $W && DOT_TEST_DIGEST_HOME=$R/home XDG_CONFIG_HOME=$R/xdg node --max-old-space-size=96 $R/build/index.js --no-jev -- node -e "for(let i=0;i<400000;i++)console.log('line '+i+' some padding text to make it longer than usual')")`. Exit `0`, one `[PASS]` line; `wc -l` of the log is `400000`; `show last --record` has `"raw_lines": 400000` and `raw_bytes` equal to `wc -c` of the log.
- **Failure in the middle.** Write a script that prints `filler <i>` 200,000 times, then `tests/fixtures/logs/node-tap-cart.log`, then 200,000 more filler lines and exits `1`; run it like the small-heap command with `--format=json`. Exit `1`; the cluster of `discount 10% leaves 90%` has `raw_log_lines` `L200015-L200039`; `show last L200015-L200016` (also under `--max-old-space-size=96`) prints lines 15 and 16 of the fixture.

## Gotchas

- `N` counts every line in the log so far, stdout and stderr together, so a retried run (`--retry-flakes`) keeps counting from the first attempt.
- The heartbeat goes to `stderr` only; a caller that merges `stderr` into `stdout` (`2>&1`) sees the heartbeats before the digest.
- Lines read back from the log have lost which stream they came from; no grammar uses it, so the digest does not change.
- The 400,000-line run takes about 5.5 s of wall time on the measured machine (Node 22.23.4, 2026-11-13), against 3.2 s for 0.1.x, which held every line in memory; the bound in the spec is 15 s.
- `/usr/bin/time` reports a maximum RSS around 240 MB for that run either way: that figure includes the waited-for `node -e` child, which buffers its own output. The tool's own heap is what `--max-old-space-size=96` limits.
