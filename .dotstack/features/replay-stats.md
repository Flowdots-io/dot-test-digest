# Replay and stats

`replay <run>` prints the digest of a recorded run again from its record (`logs/<run>.json`) and its log (`logs/<run>.log`), through the same pipeline a run uses, without starting anything: the stored phase, child exit code, duration and options apply unless `--format`, `--max-clusters` or `--context-lines` overrides one, Gear 1 is off, no TDD state is read (so no delta) and nothing is written. It exits with the record's `exit_code`. `stats` reads every record in the cache (all directories) and totals the raw bytes, the digest bytes and what the digests saved.

## Sub-features

- `replay-same` `replay last` with the stored options prints the original run's stdout byte for byte and exits with the record's `exit_code` (`1` for the cart).
- `replay-override` `--format=json`, `--max-clusters <1..15>` and `--context-lines <0..5>` (also `--flag value`) override the stored option; a bad value exits 64 with the run's flag message (`--max-clusters must be between 1 and 15, got 99`); an unknown flag exits 64 `unknown flag: <flag>`; no run exits 64 `replay needs a run: ...`.
- `replay-verdict` a TDD run keeps its verdict: a replayed `INVALID_RED` exits `64`, its header starts `[INVALID_RED | RED]` and stderr repeats the INV-5 message; a replayed green prints no `(delta: ...)`.
- `replay-readonly` no child process, no network, no state file read or written, no new log or record, no prune: the cache home is unchanged (names and mtimes).
- `replay-missing` a log without a record exits 66 `<run> has no record (written by an older version); replay needs one`; an unreadable record exits 66 `record of <run> is missing or unreadable`; a record whose log is gone exits 66 `log of <run> was removed`; unknown or ambiguous references behave as for `show` (see [cli-surface.md](./cli-surface.md)).
- `stats` `stats` prints `runs: <n>`, `raw bytes: <sum>`, `digest bytes: <sum>`, `saved: <raw - digest> bytes (<p>%), about <t> tokens` and `status: <S> <n>, ...` (sorted by status); `<p>` to one decimal (`0.0` when raw is `0`), `<t>` = ceil(saved / 4), `0` when the saving is not positive; with no records the single line `runs: 0`; exit `0`.
- `stats-last` `--last N` (also `--last=N`) counts only the N newest records by `created_at`; `N` must be a positive integer, else exit 64.
- `stats-json` `--json` prints one line `{"runs":..,"raw_bytes":..,"digest_bytes":..,"saved_bytes":..,"saved_percent":..,"estimated_tokens_saved":..,"statuses":{..}}`; with no records the same keys with zeros and `{}`.

## How to get to it (user POV)

- After a failing run, `dot-test-digest replay last --format=json --max-clusters=15` in the same directory to see every cluster, or `replay last --context-lines=4` for a larger source window, without running the tests again.
- `dot-test-digest stats` (or `stats --last 20`) to see how much output the digests kept out of the context.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done, `H=.acceptance/verify/$RUN/home`.
- A recorded cart run: `$V drive $RUN cart node-cart -- node --test cart.test.js` (exit `1`).
- Prod: not safe (the cart run writes a log and a record in the run's `home/`; `replay` and `stats` themselves write nothing).

- **Same digest.** `ls -l --time-style=+%s.%N $H/logs > /tmp/before`, then `$V drive $RUN replay node-cart replay last`. Exit `1`; `cmp` of `evidence/cart/stdout.txt` and `evidence/replay/stdout.txt` is silent; `ls -l --time-style=+%s.%N $H/logs | diff /tmp/before -` is empty (nothing written).
- **Every cluster.** `$V drive $RUN rjson node-cart replay last --format=json --max-clusters=15`. Exit `1`; `summary.total_clusters` is `4` and the ids are `c_9721831d c_6edce10a c_fdff652c c_53a8182a`.
- **Source window.** `$V drive $RUN ctx0 node-cart replay last --context-lines=0`. The first block has one source line, `  7 > test("discount 10% leaves 90%", () => assert.equal(discount(1000, 10), 900));`.
- **Red verdict.** `$V drive $RUN red node-cart --tdd-phase=red --scope-id=rr -- node --test passing.test.js` (exit `64`), then `$V drive $RUN rred node-cart replay last`: exit `64`, header `[INVALID_RED | RED] ...`, stderr `New test passed before implementation; expected a failing behavioral assertion.`
- **No record.** `echo x > $H/logs/run_legacy1.log`, then `$V drive $RUN legacy - replay run_legacy1`: exit `66`, stderr `run_legacy1 has no record (written by an older version); replay needs one`. Delete the file afterwards.
- **Log removed.** Move the cart run's `.log` aside, `$V drive $RUN gone - replay <run id>`: exit `66`, stderr `log of <run> was removed`. Move it back.
- **Stats.** After only the cart run, `$V drive $RUN stats - stats`: exit `0`, `runs: 1`, `raw bytes:` equals `wc -c` of the log, `digest bytes:` equals `wc -c` of `evidence/cart/stdout.txt`, `status: FAIL 1` (measured: `3800`, `2371`, `saved: 1429 bytes (37.6%), about 358 tokens`; the byte counts move with the fixture path length).
- **Stats JSON and --last.** `$V drive $RUN statsj - stats --json` prints the same numbers as one JSON line; after the red journey, `stats --last 1` counts only the `INVALID_RED` run.
- **Empty.** On a fresh launch, `$V drive $RUN none - stats`: stdout `runs: 0`, exit `0`.

## Gotchas

- `last` is the newest record of the current directory: drive `replay last` with the fixture the run used (`node-cart`), not `-`.
- A replay reads source windows from the run's directory as it is now; an edited fixture shows its new lines.
- The digest bytes and the log path in the header depend on the path length of the run's `home/`, so byte counts differ between launches; compare a replay with its own run, never with a number from another launch.
- `stats` counts records only: a log from before records existed, or a run that ended before its digest (exit `127` or `70`), is not counted.
