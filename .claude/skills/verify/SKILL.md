---
name: verify
description: Drive dot-test-digest (a one-shot CLI that wraps a test, compiler or build command and prints a bounded digest) through its real built binary, in an isolated cache and fixture copy, and capture proof. Use when proving a change to src/, the README's claims, or a spec scenario; before `dotstack:verify` or `dotstack:ship`.
---

# Verify dot-test-digest

The surface is a **CLI**: `dot-test-digest [flags] -- <command>`. There is no server, so "launch" means build the commit under test once, and every drive is its own short process. Do not use the globally linked `dot-test-digest` (its `dist/` is rebuilt by hand and is often stale) and never run `pnpm build` in the repo root for verification: the helper builds into a scratch directory.

Feature map: `.dotstack/features/README.md` (read it first, then open the matching feature file). Repo commands (`pnpm run verify` = typecheck + unit tests) are in `.dotstack/surfaces.yaml`; this skill proves behavior on the real binary, which the unit tests do not.

All commands run from the repo root. `V=.claude/skills/verify/verify.sh`. Needs Node >= 20 on `PATH` (the map's numbers were measured on Node 22.23.4).

## Launch

```bash
V=.claude/skills/verify/verify.sh
RUN=$($V launch)        # builds HEAD into .acceptance/verify/$RUN/build, copies the fixtures, prints the run id
```

`launch` creates, under `.acceptance/verify/$RUN/` (git-ignored): `build/` (compiled binary), `schema/` (a copy of the repo's, where `dot-test-digest schema` looks for it), `home/` (used as `DOT_TEST_DIGEST_HOME`, so the user's `~/.cache/dot-test-digest` is never touched), `xdg/` (used as `XDG_CONFIG_HOME` by `drive`, so the user's `~/.config/dot-test-digest/config.json` is never read; created only when a journey writes a user config there), `evidence/`, and a fixture copy in a `mktemp` directory **outside the repo** (`tests/fixtures/node-cart`, `tsc-small`, `vitest-cart`; outside because vitest walks up looking for a config and would pick up the repo's own). Ready means `launch` printed a run id and exited 0. It builds the working tree, so a dirty tree is recorded in `$RUN/commit`.

## Doctor

```bash
$V doctor $RUN
```

Read-only. Shows the commit built, the current `HEAD`, the Node version, the cache home and the binary's `--version`. Run it first whenever anything looks off. If it prints `WARNING: build is not the current HEAD`, clean up and launch again: you would be proving the wrong code.

## Drive

```bash
$V drive $RUN <label> <fixture|-> [digest flags] -- <command ...>
```

- `<fixture>` is `node-cart`, `tsc-small`, `vitest-cart`, or `-` for the fixture root (use `-` for commands that need no project, such as `sh -c 'exit 42'`).
- The helper runs the built binary with `--no-jev` added before your flags (Gear 1 is the only network use), except when the first word is a subcommand (`show`, `replay`, ...), which must stay first (a `digest` drive gets `--no-jev` appended after its arguments instead, since `digest` can reach Gear 1), `DOT_TEST_DIGEST_HOME` set to the run's `home/`, and `node_modules/.bin` on `PATH` (so `tsc` and `vitest` are the repo's). It prints stdout and stderr and stores `command.txt`, `stdout.txt`, `stderr.txt` and `exit.txt` in `evidence/<label>/`. The exit code is the digest's, which is the contract under test.
- Give every TDD journey its own `--scope-id=<name>`: state is otherwise keyed by working directory, so earlier drives in the same fixture leak into the `delta`.
- To change a fixture (for example write a new test file), edit the copy at `$(cat .acceptance/verify/$RUN/workdir)`, never the repo's `tests/fixtures/`.

Handles are literal: header lines (`[PASS]`, `[FAIL] 4 failed, 2 passed ... | 2 clusters | log: ...`), the `next: dot-test-digest show <run> <cluster>` line under a failure header, cluster ids (`c_9721831d`), `rerun:` and `raw: L<n>-L<m>` rows, the `+N more clusters (see log)` line, exit codes, and the files under `home/` (`logs/run_*.log`, `state-<scope>.json`). Each feature file in `.dotstack/features/` has the exact commands and expected results.

## Journeys

One feature file per surface in `.dotstack/features/`; each journey is a bold label in its "Driving it with verify.sh" section, with the exact command and expected result. A release run drives the main journeys of every file:

| Feature file | Main journeys |
| --- | --- |
| `cli-surface.md` | Help, Version, Unknown flag, Missing delimiter, Help lists subcommands, A program called show, No run yet, Range, Cluster, Bad selectors, References, Removed log |
| `exit-codes.md` | Arbitrary code, Signal, Missing command, Test runner failure, Closed stdout |
| `pass-digest.md` | node --test, vitest, Skipped and todo, eslint warnings, Log keeps everything |
| `failure-digest.md` | node --test, The next step works, Same under the spec reporter, Raw pointer, Fewer clusters, vitest, tsc fallback, Unstructured |
| `digest-input.md` | Compiler log, Inferred exit, Foreign TAP log, Read back, stdin, Errors |
| `replay-stats.md` | Same digest, Every cluster, Red verdict, No record, Log removed, Stats, Empty |
| `tdd-gate.md` | Valid red, Invalid red (passing test, broken import), Missing export is a valid red, Full cycle, Refactor, Green that ran nothing, Opt out |
| `json-envelope.md` | Failing run, Rerun works, Cluster cap, ndjson, Schema |
| `cache.md` | gc dry-run, gc, Bad value, Auto prune, Switched off, One hour, Missing cache |
| `progress.md` | Heartbeats, Off by default, Fast child, Small heap, Failure in the middle |
| `config.md` | Defaults, Project file, Env beats file, flag beats env, User file, Strict, Retention trust, MCP trust, Color always, Auto in a pipe |
| `doctor-init.md` | Vitest project, JSON, Key hidden, Bad config, Init, Init again, Symlink |
| `mcp.md` | Session, Read the runs, Default refuses, Prefix and cwd, Project file ignored, Timeout, Client snippet |

`verify.sh` needs no command per feature: subcommands are driven with `drive` like any other invocation, and an MCP session is JSON-RPC lines piped into `drive` (see `mcp.md`).

## Evidence

Proof is the stored `command.txt`, `stdout.txt`, `stderr.txt` and `exit.txt` of each drive, plus, where the feature says so, a second read-only view: the raw log file the header names (does `raw: L15-L39` resolve to those lines?), `home/state-<scope>.json` (does the baseline hold the failing test?), `wc -c` of stdout (is the ceiling met?). Standards:

- Exercise the real binary on a real child process. Do not call `main()` or a formatter from a script, and do not hand-write the log the tool should have produced.
- Capture the action and the resulting state: stdout and the exit code, and the file the tool wrote.
- The exit code is part of every proof. A digest that reads right with the wrong exit code fails.
- Report what was not run (for example Gear 1, which needs `TYPESAFE_API_KEY` and the network, and Node versions other than the one in `doctor`).

## Cleanup

```bash
$V cleanup $RUN        # removes build/, schema/, home/ and the fixture copy; keeps .acceptance/verify/$RUN/evidence/
```

Run it after a failed attempt too. It removes only what `launch` created for this run id, never anything by process name. Evidence survives; copy it somewhere permanent if a PR needs it.

## Isolation

Two runs side by side are safe: each has its own run id, cache home, build and fixture directory. The user's global install and `~/.cache/dot-test-digest` are never read or written.
