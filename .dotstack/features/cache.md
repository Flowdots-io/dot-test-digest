# Cache retention

The cache (`$DOT_TEST_DIGEST_HOME`, default `~/.cache/dot-test-digest`) holds runs in `logs/` (`<run>.log` plus `<run>.json`, one run) and TDD state in `state-<scope>.json`. After each run has printed its digest the tool prunes it: it keeps the newest 50 runs, deletes the older ones created more than 14 days ago, and deletes state files untouched for 90 days. `gc` applies the same rule on demand and prints what it did. Nothing modified in the last hour, no symlink and no file not named like a run or a state file is ever deleted, and a prune failure never changes the exit code.

## Sub-features

- `auto-prune` after the digest (and after the record is written), keep the newest `retention.keepRuns` (50) runs including the current one, delete among the rest those whose `created_at` is older than `retention.maxAgeDays` (14) days; a log without a record uses its mtime; a record without a log is deleted; at most 200 files per run, oldest first.
- `state-prune` `state-*.json` not modified for `retention.stateMaxAgeDays` (90) days are deleted, never the current scope's.
- `prune-safety` never the current run, never a file modified in the last hour, only regular files named `run_<id>.log`, `run_<id>.json` (in `logs/`) or `state-<scope>.json` (in the cache root); symlinks are never followed or deleted.
- `prune-limits-trust` the three limits are read from the user file only; a project file setting one is ignored with `dot-test-digest: ignoring retention.<key> in <file>: retention limits are read from the user config only` (see [config.md](./config.md)).
- `prune-symlinked-home` a cache directory that is a symlink is resolved once with realpath; runs and state files are pruned in the directory it names.
- `prune-switch` `DOT_TEST_DIGEST_PRUNE=0` or `{ "retention": { "auto": false } }` (project or user file) turns the automatic prune off; a failure prints `dot-test-digest: could not prune the cache: <reason>` and keeps the exit code.
- `gc` `gc [--keep N] [--max-age-days D] [--state-max-age-days D] [--dry-run]`, defaults from the user file's `retention.*` limits; prints `removed <R> runs (<S> state files), kept <K> runs` or, with `--dry-run`, `would remove <R> runs (<S> state files), keeping <K> runs`; exit 0; a bad value exits 64 `<flag> must be a non-negative integer, got <value>`; no cap on the number of files.

## How to get to it (user POV)

- Use the tool for a few weeks: the cache stays at about the newest 50 runs plus the last 14 days.
- Run `dot-test-digest gc --dry-run` to see what would go, then `dot-test-digest gc`.
- Set `DOT_TEST_DIGEST_PRUNE=0` to keep everything.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done, `H=.acceptance/verify/$RUN/home`.
- Seed 60 old runs (legacy logs without records count by their mtime): `mkdir -p $H/logs && now=$(date +%s) && for i in $(seq -w 1 60); do f=$H/logs/run_old0$i.log; echo x > $f; touch -d "@$(( now - 20*86400 + 10#$i*60 ))" $f; done` (one minute apart, so `run_old060` is the newest). Re-seed after each journey that deletes.
- Prod: not safe (deletes files in the run's `home/`; nothing outside it).

- **gc dry-run.** `$V drive $RUN gcdry - gc --dry-run`. Exit `0`; stdout `would remove 10 runs (0 state files), keeping 50 runs`; `ls $H/logs | wc -l` still `60`.
- **gc.** `$V drive $RUN gc - gc`. Exit `0`; stdout `removed 10 runs (0 state files), kept 50 runs`; `ls $H/logs` starts at `run_old011.log`.
- **gc stricter.** Re-seed, then `$V drive $RUN gcstrict - gc --keep 10 --max-age-days 2`: `removed 50 runs (0 state files), kept 10 runs`.
- **Bad value.** `$V drive $RUN gcbad - gc --keep -1`. Exit `64`; stderr `--keep must be a non-negative integer, got -1`; nothing deleted.
- **Auto prune.** Re-seed, then `$V drive $RUN auto node-cart -- node --test passing.test.js`. Exit `0`, stderr empty; `ls $H/logs/*.log | wc -l` is `50` (the new run and `run_old012` to `run_old060`); the new run's `.json` is there.
- **Switched off.** Re-seed, then `DOT_TEST_DIGEST_PRUNE=0 $V drive $RUN off node-cart -- node --test passing.test.js`: `61` logs.
- **One hour.** Re-seed with `touch -d "10 minutes ago"` instead: `gc` prints `removed 0 runs (0 state files), kept 60 runs`.
- **State.** `echo '{}' > $H/state-aaa.json; touch -d "100 days ago" $H/state-aaa.json`, then `gc`: `(1 state files)`, and the file is gone.
- **Project file cannot tighten.** Re-seed, `mkdir -p $W/node-cart/.git` (`W=$(cat .acceptance/verify/$RUN/workdir)`) and `echo '{ "retention": { "keepRuns": 0, "maxAgeDays": 0 } }' > $W/node-cart/.dot-test-digest.json`, then `$V drive $RUN tighten node-cart -- node --test passing.test.js`: `50` logs, and stderr has `ignoring retention.keepRuns in ` and `ignoring retention.maxAgeDays in `. Delete the file afterwards.
- **Missing cache.** `rm -rf $H`, then `$V drive $RUN gcnone - gc`: `removed 0 runs (0 state files), kept 0 runs`, exit `0`, `$H` not created.

## Gotchas

- The 1-hour rule uses file mtimes, so freshly seeded files are safe until you `touch -d` them into the past.
- A run's age is its record's `created_at`; touching a record's mtime alone does not age the run (it only ends the one-hour protection).
- `drive` with a fixture other than `-` runs the wrapper, which prunes on its own: drive `gc` with `-` as the fixture, and unset `DOT_TEST_DIGEST_PRUNE` unless the journey sets it.
- The automatic prune stops at 200 files per run; `gc` has no cap.
