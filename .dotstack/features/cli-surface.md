# CLI surface

`dot-test-digest [flags] -- <command ...>` takes flags before a `--` delimiter and runs everything after it as the child command. Help and version print and exit 0; every malformed invocation is a usage error: a one-line diagnostic on stderr, nothing on stdout, exit 64, and the child is never started.

## Sub-features

- `cli-help` `--help` and `-h` print the usage and exit 0.
- `cli-version` `--version` and `-v` print the package version and exit 0.
- `cli-unknown-flag` an unknown flag is a usage error.
- `cli-missing-delimiter` a command without `--` is a usage error.
- `cli-bad-value` a missing, out-of-range or malformed flag value is a usage error.
- `cli-no-command` `--` with nothing after it is a usage error.

## How to get to it (user POV)

- Run `dot-test-digest --help` or `dot-test-digest --version` in a terminal.
- Mistype a flag or forget the `--` before the command.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test.
- Prod: safe (none of these journeys starts a child or writes a log; confirm with step "No side effects" below).

- **Help.** `$V drive $RUN help - --help`. Exit `0`; stdout starts `dot-test-digest — bounded test/build output compressor` and lists `--tdd-phase`, `--format`, `--max-clusters`, `--context-lines`, `--scope-id`, `--retry-flakes`, `--no-jev`.
- **Version.** `$V drive $RUN version - --version`. Exit `0`; stdout is `0.1.0` (the value in `package.json`/`src/version.ts` at the commit under test).
- **Unknown flag.** `$V drive $RUN unknown - --bogus -- true`. Exit `64`; stdout empty; stderr `unknown flag: --bogus`.
- **Missing delimiter.** `$V drive $RUN nodelim - true`. Exit `64`; stderr `missing -- delimiter before "true": dot-test-digest [flags] -- <command>`.
- **Out of range.** `$V drive $RUN range - --max-clusters=99 -- true`. Exit `64`; stderr `--max-clusters must be between 1 and 15, got 99`.
- **Bad enum.** `$V drive $RUN phase - --tdd-phase=blue -- true`. Exit `64`; stderr `--tdd-phase must be red, green, refactor or none`.
- **Bad boolean.** `$V drive $RUN bool - --no-jev=maybe -- true`. Exit `64`; stderr `--no-jev accepts only true or false, got maybe`.
- **Missing value.** `$V drive $RUN noval - --tdd-phase -- true`. Exit `64`; stderr `--tdd-phase requires a value`.
- **No command.** `$V drive $RUN nocmd - --`. Exit `64`; stderr `no command after --`.
- **No side effects.** Run the journeys above first on a fresh run, then `ls .acceptance/verify/$RUN/home` lists nothing (no `logs/` directory, no state file).

## Gotchas

- `verify.sh drive` always inserts `--no-jev` before your flags, so `--no-jev=maybe` is parsed after it and the last value is the invalid one; the usage error still fires.
- Usage errors come from the wrapper: the child (`true`) is never started, so an exit code 64 here is not the child's.
- An exit code of 64 also means `INVALID_RED` (see [tdd-gate.md](./tdd-gate.md)). Tell them apart by stdout: a usage error prints nothing on stdout.
