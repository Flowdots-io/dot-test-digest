# CLI surface

`dot-test-digest [flags] -- <command ...>` takes flags before a `--` delimiter and runs everything after it as the child command; `dot-test-digest <subcommand> [args]` runs a subcommand when its name is the first word. Help and version print and exit 0; every malformed invocation is a usage error: a one-line diagnostic on stderr, nothing on stdout, exit 64, and the child is never started. Every wrapped run writes a run record (`logs/<run>.json`) beside its log, and `show` prints a run's raw log lines back.

## Sub-features

- `cli-help` `--help` and `-h` print the usage and exit 0.
- `cli-version` `--version` and `-v` print the package version and exit 0.
- `cli-unknown-flag` an unknown flag is a usage error.
- `cli-missing-delimiter` a command without `--` is a usage error.
- `cli-bad-value` a missing, out-of-range or malformed flag value is a usage error.
- `cli-no-command` `--` with nothing after it is a usage error.
- `cli-subcommand` the first bare word `show`, `config`, `gc`, `replay`, `stats`, `digest`, `schema`, `doctor`, `init` or `mcp` dispatches (`config`: see [config.md](./config.md); `gc`: see [cache.md](./cache.md); `replay`, `stats`: see [replay-stats.md](./replay-stats.md); `digest`: see [digest-input.md](./digest-input.md); `schema`: see [json-envelope.md](./json-envelope.md); `doctor`, `init`: see [doctor-init.md](./doctor-init.md); `mcp`: see [mcp.md](./mcp.md)); any other bare word, or a subcommand name after a flag, is the missing-delimiter error; after `--` it is a program.
- `run-record` every wrapped run writes `logs/<run>.json` (command, cwd, exit codes, signal, phase, options, summary, log and digest sizes, every cluster) atomically after the digest.
- `show` `show <run> [L<a>-L<b>|<a>-<b>|L<a>|cluster_id] [--numbers] [--record]`; `<run>` is `last` (newest record of this directory), a run id or a 6+ character prefix; a missing run exits 66.

## How to get to it (user POV)

- Run `dot-test-digest --help` or `dot-test-digest --version` in a terminal.
- Mistype a flag or forget the `--` before the command.
- After any wrapped run, `dot-test-digest show last` (or `show last c_<id>` with a cluster id from the digest) in the same directory.

## Driving it with verify.sh

Preconditions:

- `RUN=$($V launch)` done and `$V doctor $RUN` shows the commit under test.
- Prod: safe (none of these journeys starts a child or writes a log; confirm with step "No side effects" below).

- **Help.** `$V drive $RUN help - --help`. Exit `0`; stdout starts `dot-test-digest — bounded test/build output compressor` and lists `--tdd-phase`, `--format`, `--max-clusters`, `--context-lines`, `--scope-id`, `--retry-flakes`, `--allow-no-tests`, `--no-jev`.
- **Version.** `$V drive $RUN version - --version`. Exit `0`; stdout is `0.1.0` (the value in `package.json`/`src/version.ts` at the commit under test).
- **Unknown flag.** `$V drive $RUN unknown - --bogus -- true`. Exit `64`; stdout empty; stderr `unknown flag: --bogus`.
- **Missing delimiter.** `$V drive $RUN nodelim - true`. Exit `64`; stderr `missing -- delimiter before "true": dot-test-digest [flags] -- <command>`.
- **Out of range.** `$V drive $RUN range - --max-clusters=99 -- true`. Exit `64`; stderr `--max-clusters must be between 1 and 15, got 99`.
- **Bad enum.** `$V drive $RUN phase - --tdd-phase=blue -- true`. Exit `64`; stderr `--tdd-phase must be red, green, refactor or none`.
- **Bad boolean.** `$V drive $RUN bool - --no-jev=maybe -- true`. Exit `64`; stderr `--no-jev accepts only true or false, got maybe`.
- **Missing value.** `$V drive $RUN noval - --tdd-phase -- true`. Exit `64`; stderr `--tdd-phase requires a value`.
- **No command.** `$V drive $RUN nocmd - --`. Exit `64`; stderr `no command after --`.
- **Help lists subcommands.** In the Help journey's stdout, the lines `  show <run> [range|cluster_id]`, `  replay <run>`, `  digest <file|->`, `  gc`, `  stats`, `  doctor`, `  init`, `  mcp`, `  config` and `  schema` are present.
- **Subcommand after a flag.** `$V drive $RUN lateword - --no-jev show last` (the helper adds a second `--no-jev` in front). Exit `64`; stderr `missing -- delimiter before "show": dot-test-digest [flags] -- <command>`.
- **No side effects.** Run the journeys above first on a fresh run, then `ls .acceptance/verify/$RUN/home` lists nothing (no `logs/` directory, no state file).

Run record and `show` (Prod: not safe, they write and read a log and a record in the run's `home/`):

- **A program called show.** `$V drive $RUN prog - -- show`. Exit `127`; stderr `dot-test-digest: spawn show ENOENT` (an empty log is created before the spawn fails, and no record).
- **No run yet.** On a fresh launch, `$V drive $RUN nolast node-cart show last`. Exit `66`; stderr `no run recorded for this directory`.
- **Record.** `$V drive $RUN cart node-cart -- node --test cart.test.js` (exit `1`), then `ls .acceptance/verify/$RUN/home/logs` shows one `run_*.log` and one `run_*.json` with the same id and no `*.tmp`. Second view: the `.json` has `"command": ["node", "--test", "cart.test.js"]`, `"exit_code": 1`, `"child_exit_code": 1`, `"status": "FAIL"`, four `clusters` (`c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a`), `raw_bytes` equal to `wc -c` of the log and `digest_bytes` equal to `wc -c` of `evidence/cart/stdout.txt`.
- **Range.** `$V drive $RUN range node-cart show last L15-L17`. Exit `0`; stdout is lines 15 to 17 of the log (`sed -n 15,17p` of it), the first `not ok 3 - discount 10% leaves 90%`.
- **Cluster.** `$V drive $RUN cluster node-cart show last c_9721831d`. Exit `0`; stdout is lines 15 to 39 of the log, the `raw: L15-L39` range the `cart` digest printed for that cluster.
- **Numbers.** `$V drive $RUN numbers node-cart show last L15-L16 --numbers`. Stdout `15<TAB>not ok 3 - discount 10% leaves 90%` and `16<TAB>  ---`.
- **Record file.** `$V drive $RUN record node-cart show last --record`. Stdout equals the `.json` file byte for byte (`cmp`).
- **Bad selectors.** `show last L500-L600` exits `64` with `the log has <N> lines`; `show last L9-L3` exits `64` with `invalid range: L9-L3`; `show last c_00000000` exits `64` with `no cluster c_00000000 in <run>`.
- **References.** `show run_a` exits `64` with `run reference "run_a" is too short (6 characters minimum)`; `show run_zzzzzz` exits `66` with `no such run: run_zzzzzz`; the first 10 characters of the cart run id resolve to the same output as `last`.
- **Removed log.** Delete the cart run's `.log`, then `show <run id>` exits `66` with `log of <run> was removed`. Restore it and delete the `.json` instead: `66` with `record of <run> is missing or unreadable`.

## Gotchas

- `verify.sh drive` always inserts `--no-jev` before your flags, so `--no-jev=maybe` is parsed after it and the last value is the invalid one; the usage error still fires.
- Usage errors come from the wrapper: the child (`true`) is never started, so an exit code 64 here is not the child's.
- An exit code of 64 also means `INVALID_RED` or `INVALID_GREEN` (see [tdd-gate.md](./tdd-gate.md)). Tell them apart by stdout: a usage error prints nothing on stdout.
- `last` is scoped to the working directory: a run driven in `node-cart` is not `last` for a drive with fixture `-` (a different directory). Drive `show` in the same fixture as the run.
- `verify.sh drive` adds `--no-jev` in front of your flags, except when the first word is a subcommand; `show` never calls Jev.
- `show` prints the log as stored, ANSI codes included; the digest's own lines are normalized, so a colored runner's log can differ from what the digest quoted.
