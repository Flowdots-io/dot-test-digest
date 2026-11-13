# dot-test-digest verification map

This directory is the maintained source for verifying the user-facing behavior of `dot-test-digest`, a one-shot CLI that wraps a test, compiler or build command and prints a bounded digest. Read the index, then use the matching feature file as the recipe. The driver is the project skill `.claude/skills/verify/SKILL.md` (`verify.sh`); the repo's own checks (`pnpm run verify`, `node scripts/acceptance/run-acceptance.mjs`) are in `.dotstack/surfaces.yaml` and the README of `scripts/acceptance/`.

## Baseline preconditions

- Node >= 20 on `PATH`. The numbers in these files were measured on Node 22.23.4, `--no-jev`; the `node --test` grammar is verified on that version only.
- `V=.claude/skills/verify/verify.sh; RUN=$($V launch)`, then `$V doctor $RUN` must show the commit under test. Run `$V cleanup $RUN` at the end.
- Every drive adds `--no-jev` (a subcommand drive such as `show last` gets none, since the subcommand must be the first word and only `digest` can call Jev; a `digest` drive gets `--no-jev` appended after its arguments) and uses the run's own `DOT_TEST_DIGEST_HOME`. Gear 1 (the Jev API) is never exercised here: it needs `TYPESAFE_API_KEY` and the network (see "Not covered").
- Fixtures: `node-cart` (`node --test`, 6 tests in `cart.test.js`: 2 pass, 4 fail), `tsc-small` (5 type errors in 2 files), `vitest-cart` (29 vitest tests, 5 fail). They are copied per run; edit the copy only.
- Mark each feature file `Prod: safe` (writes nothing) or `Prod: not safe`. There is no production deployment of this CLI: the marker only says whether a journey writes a log or state file.

## Driving conventions

- Start every recipe from a fresh `launch`, or use a distinct `--scope-id` for any TDD journey.
- Treat every command literally. Flags go before `--`, the wrapped command after it.
- The exit code is checked in every journey. `exit.txt` in the evidence directory holds it.
- Sizes are the bytes of `stdout.txt` (`wc -c`). Log paths in the header are long inside a run (the isolated `home/`), so the `INV-1` pass line can be cut with `...` at 160 bytes; that is not a failure.

## Proof and skip reporting

- Proof for a journey: the command, stdout, stderr and exit code from `evidence/<label>/`, plus the second view the journey names.
- Record the feature ID and journey label with every artifact.
- Report an unreachable path with the command tried and the unmet precondition. Do not report a skipped path as verified through another one.

### Not covered (report under Not verified)

Gear 1 (Jev, `--retry-flakes`), the pytest, `cargo`, `go test`, jest, Playwright and eslint grammars (fixtures only, never run against a real project), Node versions other than the one `doctor` prints, Windows.

## Feature entry contract

Each feature file has an H1, one paragraph, then exactly four H2s: `Sub-features`, `How to get to it (user POV)`, `Driving it with verify.sh`, `Gotchas`. The driving section starts with `Preconditions:` and a `Prod:` bullet.

## Features

- [CLI surface](./cli-surface.md): `--help`, `--version`, flag parsing and usage errors (exit 64), subcommand dispatch, the run record and `show` (exit 66).
- [Exit-code transparency](./exit-codes.md): the child's exit code, a signal, a missing command.
- [Pass digest](./pass-digest.md): a passing run is one line, at most 160 bytes, and the raw log keeps everything.
- [Failure digest](./failure-digest.md): clusters, the 2,400-byte ceiling, the `next:` line and the `rerun:` row, omitted clusters, `raw:` pointers, the tsc raw-text fallback.
- [Digest input](./digest-input.md): `digest <file|->` digests an existing log or stdin into a recorded run (`source: "digest"`), exit `--exit-code` or inferred, header without `in <t>ms`, input errors (64, 66).
- [Replay and stats](./replay-stats.md): `replay <run>` re-renders a recorded run without running it (flags override the stored options, exit is the record's), `stats` totals the bytes and tokens the digests saved.
- [TDD gate](./tdd-gate.md): `--tdd-phase` red, green and refactor, `VALID_RED`/`INVALID_RED`/`INVALID_GREEN`, exit 64, `--allow-no-tests`, baseline state.
- [JSON envelope](./json-envelope.md): `--format=json` and `--max-clusters`, `schema_version` and `run_id`, `rerun` commands, `--format=ndjson`, the `schema` subcommand.
- [Cache retention](./cache.md): the automatic prune after each run, `gc` and `--dry-run`, what is never deleted, `DOT_TEST_DIGEST_PRUNE`.
- [Progress and large outputs](./progress.md): `--progress` heartbeats on `stderr` (a line each on a pipe, overwritten on a terminal), never on `stdout`; bounded memory for large outputs (400,000 lines under a 96 MB heap, a failure in the middle of a huge log).
- [Configuration and color](./config.md): project and user config files, `DOT_TEST_DIGEST_*` variables, `config`, the `mcp` warning, `--color` and `NO_COLOR`.
