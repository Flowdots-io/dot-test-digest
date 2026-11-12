# dot-test-digest

**A wrapper that turns the noisy output of a test run, compiler or build into a short, bounded digest, and passes the child's exit code through unchanged.**

You put `dot-test-digest [flags] --` in front of the command you already run. A passing run becomes one line. A failing run becomes a few deduplicated failure clusters, each with a pruned stack and the source lines around the failure, capped at about 600 tokens. The full raw output is always saved to a log file, so nothing is lost.

```bash
dot-test-digest -- vitest run                       # test run: one line on pass, clusters on failure
dot-test-digest --no-jev -- tsc --noEmit            # compiler, fully offline
dot-test-digest --format=json -- cargo build        # structured JSON for another program to read
dot-test-digest --tdd-phase=red -- node --test      # check that a new test fails for the right reason
```

Implements [`specs/SPEC-002-DOT-TEST-DIGEST.md`](specs/SPEC-002-DOT-TEST-DIGEST.md).

## What problem it solves

A test run prints hundreds of lines (passing test names, banners, deprecation warnings, repeated stack traces through `node_modules`). Whoever reads that output, a person or an AI coding agent, pays for every line in time or in context window, and the one useful fact (which test failed, where, and why) is buried in it. One bug in a shared helper can also fail 50 tests and print the same stack 50 times.

`dot-test-digest` keeps the useful part and bounds the size:

- **Pass:** one line, at most 160 bytes: `[PASS] 240 passed, 0 failed in 640ms | log: …` (with `--tdd-phase=green` it reads `[PASS | GREEN] … (delta: +3 newly passing, 0 regressions) …`). Skipped tests and lint or compiler warnings are added when there are any (`240 passed, 0 failed, 2 skipped, 3 warnings`). When no grammar recognised the output there is nothing to count, and the line says only `[PASS] exit 0 in 12ms | log: …`.
- **Fail:** failures with the same root cause are collapsed into one *cluster* (shown once, with a count and up to 3 sample test names). Each cluster has the error, a diff when there is one, a stack with the `node_modules` and runtime frames removed, and a source window around the failing line. The whole digest is at most 600 estimated tokens (2,400 bytes). Clusters that do not fit are listed one per line after `+N more clusters (see log)`, so nothing is dropped silently.
- **Always:** the child's exit code (or `128 + signal`) is returned unchanged, and the complete raw stream is kept in `~/.cache/dot-test-digest/logs/<run_id>.log`. Every cluster has a `raw:` line range that points into that log.

## When to use it

Use it when:

- an **AI coding agent** (or a CI log reader) runs your tests and you want it to see the failure, not 4,000 bytes of scaffolding around it;
- one cause makes **many tests fail** and you want to see the cause once;
- you work **test first** and want a tool to say whether a new test failed for the *right* reason (an assertion, not a typo in an import). See [the TDD gate](#the-tdd-gate);
- you want **machine-readable** results from a runner that has no JSON reporter (`--format=json`).

Do not expect much from it when:

- the raw output is already short. The digest never prints more than the raw output plus its header line, but on a 5-line `tsc` run it saves nothing (see [the table below](#where-it-works-well-and-where-it-does-not));
- the tool has no grammar here and prints no recognisable failure block. You still get the exit code and the log, with a heuristic tail instead of clusters;
- you need every passing test name or every warning. The digest hides them on purpose (the log has them).

## Install

Needs Node >= 20 and [pnpm](https://pnpm.io). Clone, build, and put the `dot-test-digest` bin on your `PATH`:

```bash
git clone https://github.com/OctavioSardi/dot-test-digest && cd dot-test-digest
pnpm install && pnpm build && pnpm link --global
dot-test-digest --version
```

If `dot-test-digest` is not found afterwards, run `pnpm setup` and restart your shell: it puts pnpm's global bin directory on your `PATH`. After you pull new commits, run `pnpm build` again: the linked binary is `dist/index.js`, and it does not rebuild itself.

## How to use it

Put the flags before `--` and the command you would normally run after it. Everything after `--` is passed to the command untouched, and a missing `--` is a usage error (exit `64`). The one other form is a subcommand as the first word (`dot-test-digest show last`, see [Looking back at a run](#looking-back-at-a-run)); `-- show` still runs a program called `show`.

```bash
dot-test-digest -- pnpm test                         # no flags: digest only
dot-test-digest --no-jev -- pytest -q                # never touch the network
dot-test-digest --max-clusters=10 -- vitest run      # show more clusters (1 to 15, default 5)
dot-test-digest --context-lines=4 -- vitest run      # larger source window (0 to 5, default 2)
dot-test-digest --format=json -- vitest run | jq .   # the full structured envelope
dot-test-digest --format=ndjson -- vitest run        # the same, one JSON object per line
dot-test-digest schema                               # the JSON Schema of the envelope
```

| Flag | Default | What it does |
| --- | --- | --- |
| `--tdd-phase <red\|green\|refactor\|none>` | `none` | Turns on the [TDD gate](#the-tdd-gate) and the newly-passing / regression counts. |
| `--format <compact-md\|json\|ndjson>` | `compact-md` | `compact-md` is the bounded text digest. `json` is the complete structured document (not size-capped, see [For programs and agents](#for-programs-and-agents)). `ndjson` is the same content one JSON object per line. |
| `--max-clusters <1..15>` | `5` | How many clusters go into the envelope. In `compact-md` the rest are counted and listed, not hidden. |
| `--context-lines <0..5>` | `2` | Lines above and below the failing line in each source window. |
| `--scope-id <string>` | hash of the working directory | Names the TDD state file, so concurrent runs in different projects (or worktrees) do not share state. |
| `--no-jev` | off | Never call the Jev API. Use this to keep every run local. |
| `--retry-flakes` | off | Re-run once when Gear 1 is at least 80% sure the failure was a flake. |
| `--allow-no-tests` | off | Accept a `green` or `refactor` run that exited `0` without any recognised test (a runner with no grammar). Without it such a run is `INVALID_GREEN`. |
| `--color <auto\|always\|never>` | `auto` | Color the status word of the header (green for `PASS` and `VALID_RED`, red for every other status). `auto` colors only when stdout is a terminal, `NO_COLOR` is unset or empty and `TERM` is not `dumb`; `always` ignores `NO_COLOR`. Sizes are measured on the uncolored text, and `--format=json` and `ndjson` are never colored. |
| `-h`, `--help` / `-v`, `--version` | | Print usage / version and exit `0`. |

Environment: `TYPESAFE_API_KEY` (enables Gear 1), `TYPESAFE_API_URL` (override, see `.env.example`), `DOT_TEST_DIGEST_HOME` (moves logs and TDD state; default `~/.cache/dot-test-digest`), `NO_COLOR` (see `--color`), and the `DOT_TEST_DIGEST_*` settings below.

### Configuration

Most flags can also be set once, so every run gets them without typing. Each setting takes the first value found in this order: the flag, an environment variable, the project file, the user file, the built-in default.

- **Project file:** `.dot-test-digest.json`, the nearest one found walking up from the working directory to the first directory that contains `.git` (that directory included), never above your home directory (compared by real path, so a symlinked home still stops it). Outside your home directory a file is used only when a `.git` above the working directory bounds the walk, so a file left in a shared directory such as `/tmp` never configures your run. Only that one file is read; files in parent directories are not merged in.
- **User file:** `$XDG_CONFIG_HOME/dot-test-digest/config.json` (default `~/.config/dot-test-digest/config.json`).

```json
{ "maxClusters": 3, "noJev": true, "retention": { "keepRuns": 100 } }
```

(`retention.keepRuns` in that example takes effect only in the user file; see below.)

| Key | Values | Default | Environment variable |
| --- | --- | --- | --- |
| `maxClusters` | integer `1` to `15` | `5` | `DOT_TEST_DIGEST_MAX_CLUSTERS` |
| `contextLines` | integer `0` to `5` | `2` | `DOT_TEST_DIGEST_CONTEXT_LINES` |
| `format` | `compact-md`, `json`, `ndjson` | `compact-md` | `DOT_TEST_DIGEST_FORMAT` |
| `noJev` | boolean | `false` | `DOT_TEST_DIGEST_NO_JEV` |
| `retryFlakes` | boolean | `false` | `DOT_TEST_DIGEST_RETRY_FLAKES` |
| `color` | `auto`, `always`, `never` | `auto` | `DOT_TEST_DIGEST_COLOR` |
| `progress` | boolean | `false` | `DOT_TEST_DIGEST_PROGRESS` |
| `retention.auto` | boolean | `true` | `DOT_TEST_DIGEST_PRUNE` (`0` turns pruning off) |
| `retention.keepRuns` | integer `0` or more | `50` | none; user file only |
| `retention.maxAgeDays` | integer `0` or more | `14` | none; user file only |
| `retention.stateMaxAgeDays` | integer `0` or more | `90` | none; user file only |
| `mcp.allow` | list of argv prefixes, e.g. `[["pnpm", "test"]]` | empty | none; user file only |

Booleans accept `true`, `false`, `1` and `0` (in a file, also as JSON `true`/`false`); an empty environment variable counts as unset. `--tdd-phase`, `--scope-id` and `--allow-no-tests` are per-run and stay flags. `progress` is read by the feature that uses it; the `retention.*` keys drive the cache prune and `gc` (see [The cache and what is deleted](#the-cache-and-what-is-deleted)). The configuration is strict: an unknown key (`<path>: unknown key "maxCluster"`), a wrong value (`<path>: maxClusters must be between 1 and 15, got 99`, `DOT_TEST_DIGEST_MAX_CLUSTERS must be an integer between 1 and 15, got abc`) or a file that is not valid JSON (`<path>: invalid JSON: …`) is a usage error, exit `64`, before the command is started. A project file may not set `mcp`: the key is ignored and `dot-test-digest: ignoring "mcp" in <path>: the command allowlist is read from the user config only` is printed on `stderr`, so a repository you cloned cannot widen what the MCP server runs. For the same reason a project file may not set the retention limits (`retention.keepRuns`, `retention.maxAgeDays`, `retention.stateMaxAgeDays`), which decide what is deleted across the whole cache: such a key is ignored, `config` keeps showing the value from the user file or the default, and `dot-test-digest: ignoring retention.<key> in <path>: retention limits are read from the user config only` is printed on `stderr`. A project file may still set `"retention": { "auto": false }`, which only deletes less.

`dot-test-digest config` prints the effective value of every setting and where it came from, one line each (flags play no part):

```text
maxClusters = 3 (project /home/me/app/.dot-test-digest.json)
contextLines = 2 (default)
format = json (env DOT_TEST_DIGEST_FORMAT)
...
retention.stateMaxAgeDays = 90 (default)
```

The source is `default`, `user <path>`, `project <path>` or `env <NAME>`; `mcp.allow` is printed only when the user file sets it.

### What you get back

The first line of every digest is a header: `[<STATUS>] <passed> passed, <failed> failed in <time> | <n> clusters | log: <path>` (`[<STATUS> | <PHASE>]` when `--tdd-phase` is set; the cluster count appears only when there are clusters; `, <n> skipped` and `, <n> warnings` follow the counts only when nonzero; a pass whose output no grammar recognised reads `exit 0` instead of the counts). Skipped counts skipped and todo tests; warnings are lint and compiler warnings, which are counted (`summary.warnings` in the JSON, present only when nonzero) and become failure clusters only when the command failed with no error to show (a linter run with `--max-warnings=0`). The status is one of:

| Status | Meaning |
| --- | --- |
| `PASS` | The command exited `0` (and, with `--tdd-phase`, the phase was satisfied). |
| `FAIL` | The command failed and a grammar found failure clusters. |
| `BUILD_ERROR` | The command failed but no grammar recognised the output (compile errors from an unknown tool, a crash). The digest shows a narrowed tail of the log. |
| `VALID_RED` | `--tdd-phase=red` and the test failed for a behavioural reason. A *successful* gate run: exit `0`. |
| `INVALID_RED` | `--tdd-phase=red` and the test passed, or failed for a non-behavioural reason (syntax error, broken import, runner crash). Exit `64`. |
| `INVALID_GREEN` | `--tdd-phase=green` or `refactor`, the command exited `0`, but no passed or failed test was recognised (skipped tests do not count). Exit `64`, a one-line message on `stderr`, and the TDD state is left as it was. `--allow-no-tests` turns it back into `PASS`. |
| `REGRESSION_DETECTED` | `--tdd-phase=refactor` and something that passed before now fails. |

**The next step and the rerun command.** Line 2 of a failure digest names what to look at next: `next: dot-test-digest show <run> <cluster>`, where `<cluster>` is the first cluster that did not get a full block (the first of the listed lines, when it fits), or the first cluster when every one is shown. Run it as printed: `show` prints that cluster's lines from the log. The first full block also has a `rerun:` row, a shell command that runs only that block's first test, when the command you wrapped names a test runner:

```text
[FAIL] 4 failed, 2 passed in 282ms | 2 clusters | log: ~/.cache/dot-test-digest/logs/run_mwe2svamacd7d77d.log
next: dot-test-digest show run_mwe2svamacd7d77d c_fdff652c
c_9721831d ASSERTION_FAILURE x1 cart.test.js:7:46
  …
  tests: discount 10% leaves 90%
  rerun: node --test --test-name-pattern '^discount 10% leaves 90%$' cart.test.js
  raw: L15-L39
```

The `next:` line is not printed on a pass, when the digest falls back to the raw text (the small `tsc` case), or for an envelope a program builds without a `run_id`. Both lines count toward the 2,400-byte limit (together about 130 bytes), so a digest can show one full block fewer than before; the clusters that lose their block are listed or counted, as always.

**Exit codes.** The wrapper exits with exactly the child's exit code (`0..255`), or `128 + signal` when the child was killed (`143` for `SIGTERM`). The only exception is the TDD gate: `64` (`EX_USAGE`) means an invalid red phase (`INVALID_RED`), a green or refactor run that ran no test (`INVALID_GREEN`), or a usage error in the flags. Subcommands never return a child's code: `0` on success, `64` for a usage error, `66` (`EX_NOINPUT`) when the run, its record or its log does not exist. A failure to write the log or the state file is reported on `stderr` and never changes the exit code, and neither does a reader that closes stdout early (`dot-test-digest -- … | head -1`): the digest is dropped, the log is still written and no `EPIPE` trace is printed.

### For programs and agents

`--format=json` prints one JSON document. Its top-level keys are `status`, `tdd_phase`, `exit_code`, `signal`, `execution_gear`, `duration_ms`, `summary`, `delta` (with a TDD phase), `clusters` (when there are any), `raw_log_path`, `schema_version` and `run_id`. `schema_version` is `1`, and stays `1` as long as a change only adds optional keys; `run_id` is the run's id in the cache (`show <run_id>`, `replay <run_id>`). `summary` holds `passed`, `failed`, `skipped`, `total_clusters` (the clusters in `clusters`, at most `--max-clusters`), `warnings` (only when nonzero) and `omitted_clusters` (the clusters beyond `--max-clusters`, only when nonzero). Each cluster has `cluster_id`, `fingerprint`, `error_kind`, `affected_count`, `sample_tests`, `diff` (when there is one), `message`, `top_frame`, `pruned_stack`, `signal_window`, `raw_log_lines` and `rerun` (below).

The [JSON Schema](schema/digest-envelope.schema.json) (draft 2020-12) of this document is generated from the code (`pnpm run schema`), shipped in the package and printed by `dot-test-digest schema`. A test fails when the committed file is out of date and validates real envelopes against it. The schema does not allow undeclared keys, so validate output with the schema of the same version.

`--format=ndjson` prints the same content one object per line: a `{"type":"summary",...}` line with every top-level key except `clusters`, one `{"type":"cluster",...}` line per cluster, then one `{"type":"omitted","cluster_id":...,"error_kind":...,"affected_count":...,"top_frame":...,"label":...,"raw_log_lines":...}` line per cluster beyond `--max-clusters` (with `rerun` when it has one; `label` is the first test name, or the message). A pass is one line. It works wherever `json` does (`--format`, the `format` setting, `replay`, `digest`).

**`rerun`.** A cluster carries `rerun`, a shell command that runs its first test alone, when the command after `--` contains a known runner. The command is copied up to the runner word, then the runner's own way of picking one test is added:

| Runner | `rerun` | Checked |
| --- | --- | --- |
| `node --test` | `node --test --test-name-pattern '^<test>$' <file>` | run: it reports `# tests 1` |
| `vitest` | `<prefix> run <file> -t '<test>'` (`npx vitest run ...` for `-- npx vitest run`) | run: `1 failed \| 28 skipped (29)` in the example project |
| `jest` | `<prefix> <file> -t '<test>'` | fixture logs only |
| `pytest` (also `python -m pytest`) | `<prefix> <file>::<test>` (other options such as `-q` are dropped) | fixture logs only |
| `cargo` | `cargo test <test> -- --exact` | fixture logs only |
| `go` | `go test -run '^<test>$' ./...` | fixture logs only |
| `eslint` | `eslint <file>` | fixture logs only |

The test name is the last part of the name (after the last ` > `), with regular-expression characters escaped for the runners that take a pattern. Every word is quoted for a POSIX shell (`sh`, `bash`, `zsh`; Windows shells are not covered). There is no `rerun` for a command without a runner word (`pnpm test`, `npm test`, `make test`: the tool cannot see what the script runs), for `tsc`, or when the output did not name the test or file the runner needs. The jest, pytest, cargo, go and eslint forms were checked against the grammars' fixture logs, not by running those tools.

### Looking back at a run

Every run that gets as far as a digest leaves two files in `~/.cache/dot-test-digest/logs/` (or `$DOT_TEST_DIGEST_HOME/logs/`): `<run>.log`, the raw output line for line (every `raw: L<a>-L<b>` pointer in a digest refers to it), and `<run>.json`, the **run record**. The record is written atomically after the digest is printed and holds what the log cannot: `run_id`, `version`, `created_at`, `cwd`, `command`, `exit_code` (what the tool returned) and `child_exit_code`, `signal`, `duration_ms`, `phase`, `scope_id`, `status`, `execution_gear`, `format`, `options`, `summary`, the size of the log (`raw_lines`, `raw_bytes`), the bytes of the digest (`digest_bytes`) and every cluster, shown or omitted, with its `raw_log_lines` range. A failure to write it prints `dot-test-digest: could not write the run record: <reason>` on `stderr` and never changes the exit code. A run that ends before a digest, because the command could not be started (exit `127`) or the tool hit an internal error (exit `70`), leaves its log and no record.

`show` prints a run's raw lines exactly as stored, so you can open the part of the log a digest pointed at without knowing its path:

```bash
dot-test-digest show last                  # the whole log of the newest run in this directory
dot-test-digest show last L15-L39          # a range (also 15-39, or L15 for one line)
dot-test-digest show last c_9721831d       # the lines of one cluster, from the record
dot-test-digest show run_mwdh6m L15-L16 --numbers   # "15<TAB>..." per line
dot-test-digest show last --record         # the record file itself
```

A `<run>` is `last` (the newest record whose `cwd` is the current directory, so runs in other repositories never answer), a full run id, or a unique prefix of at least 6 characters. A range running past the end is clamped. Errors are one line on `stderr`: `no run recorded for this directory` and `no such run: <ref>` exit `66`; `log of <run> was removed` and `record of <run> is missing or unreadable` (a log from before records existed) exit `66`; an ambiguous or too-short prefix, a range that starts past the end (`the log has <N> lines`), a reversed range (`invalid range: L9-L3`) or an unknown cluster id (`no cluster <id> in <run>`) exit `64`.

`replay` prints the digest of a recorded run again, from its record and its log, without running anything:

```bash
dot-test-digest replay last                                   # the same digest (see below for when it is byte for byte)
dot-test-digest replay last --format=json --max-clusters=15   # every cluster, as JSON
dot-test-digest replay last --context-lines=0                 # only the failing source line
```

It reads the stored lines through the same pipeline as a run, with the stored `phase`, `command`, `child_exit_code`, `duration_ms` and options, unless `--format`, `--max-clusters` or `--context-lines` overrides one of them, and exits with the record's `exit_code` (a replayed `INVALID_RED` exits `64` and prints its message on `stderr` again). The size rules are those of a run, so `--format=json` is how to see more than the compact budget allows. The digest is byte for byte the original only for a run whose digest came from Gear 0 (a grammar or the heuristic fallback) and that was not retried: a Gear 1 (Jev) digest is replayed through the heuristic instead, and a `--retry-flakes` run is replayed from its whole log, both attempts, where the live digest used the second only. Replay never starts a process, never calls the network (Gear 1 is off), never reads or writes a TDD state file and never writes a log or a record, so no `(delta: ...)` is printed. A log from before records existed exits `66` with `<run> has no record (written by an older version); replay needs one`; a record whose log was pruned exits `66` with `log of <run> was removed`. A source window is read from the run's directory as it is now, so an edited file shows its new lines.

`stats` totals what the recorded runs of every directory saved:

```bash
dot-test-digest stats            # runs: 3 / raw bytes: 16000 / digest bytes: 1850 /
                                 # saved: 14150 bytes (88.4%), about 3538 tokens / status: FAIL 1, PASS 2
dot-test-digest stats --last 20  # only the 20 newest runs (by created_at)
dot-test-digest stats --json     # {"runs":3,"raw_bytes":16000,"digest_bytes":1850,"saved_bytes":14150,
                                 #  "saved_percent":88.4,"estimated_tokens_saved":3538,"statuses":{"FAIL":1,"PASS":2}}
```

`raw bytes` is the size of the logs and `digest bytes` what the runs printed on stdout (both from the records); the percentage is rounded to one decimal, and the tokens use the tool's own estimate (4 bytes a token, rounded up), `0` when a digest was larger than its output. Statuses are sorted by name. With no records it prints `runs: 0`. It reads only, and exits `0`; a `--last` that is not a positive integer exits `64`. Runs without a record (older logs) are not counted.

### Digesting a log you already have

`digest` reads a log that was written without the tool, a CI job's output or a log someone pasted, and prints the same digest a wrapped run would:

```bash
dot-test-digest digest test.log                   # exit 1 when a grammar found a failure, else 0
dot-test-digest digest build.log --exit-code 2    # exit with the code the original command returned
some-job | dot-test-digest digest -               # read stdin
dot-test-digest digest test.log --format=json     # also --max-clusters, --context-lines, --no-jev[=true|false]
dot-test-digest digest -- -odd-name.log           # -- ends the flags, for a name starting with -
```

The lines are copied unchanged into a new log under the cache, so every `raw: L<a>-L<b>` pointer is a line number of the input, and the run is recorded like any other (`source: "digest"`, `command: []`, `input: "<path>"` or `"-"`): `show last`, `replay last` (the same digest again) and `stats` work on it, and the cache is pruned afterwards as after a run. The pipeline is a run's (adapters, clusters, size rules); the header leaves out `in <t>ms`, because no process was timed, and the JSON envelope has `duration_ms: 0`. Source windows are read from the working directory and are left out when a file the log names does not exist here, so a log from another machine still gives its clusters, without windows. Because the log did not come from the tool, a window is also left out when its file is outside the working directory (an absolute path, `../`, or a symbolic link that points out, judged by real path), so a crafted log cannot make `digest` or `replay` print another file; the cluster itself stays. The input is decoded as UTF-8 like a live run's output, so invalid bytes become U+FFFD in the copied log and `raw_bytes` in the record can differ from the input's size. There is no TDD gate (`--tdd-phase` exits `64`). An empty input exits `64` with `input is empty`, a file that cannot be read exits `66` with `cannot read <path>: <reason>` (`ENOENT`, `EISDIR`, ...), `digest -` with a terminal on stdin exits `64` with `no input: pipe a log into "digest -"`, and `--exit-code` outside 0 to 255 exits `64`.

Gear 1 can run here: when the exit code is non-zero, no grammar recognised a failure and the log has more than 150 lines, a digest asks Jev exactly as a run would (with `TYPESAFE_API_KEY` set). Without `--exit-code` that never happens, because the inferred code is `1` only when a grammar found a failure. Pass `--no-jev` (or set `noJev`) to stay local.

In CI, run the tests as usual, keep the full log as an artifact, and print only the digest, with the tests' own exit code:

```bash
set -o pipefail
pnpm test 2>&1 | tee test.log > /dev/null && status=0 || status=$?   # also under bash -e
npx dot-test-digest digest test.log --exit-code "$status" --no-jev
```

The cache of a CI job is usually thrown away with the job; set `DOT_TEST_DIGEST_HOME` to a path you upload if you want the copied log and its record too.

`--help` also lists `config` (see [Configuration](#configuration)), `gc` (see [The cache and what is deleted](#the-cache-and-what-is-deleted)), `schema` (see [For programs and agents](#for-programs-and-agents)) and `doctor`, `init` and `mcp`. Those last three are reserved names: in this version each one exits `64` with `<name> is not available in this version`.

### The cache and what is deleted

Everything the tool writes lives in one directory, `~/.cache/dot-test-digest/` (or `$DOT_TEST_DIGEST_HOME`): runs in `logs/` (`<run>.log` and `<run>.json`, a pair counts as one run) and TDD state in `state-<scope_id>.json`. Nothing else in it, and nothing outside it, is ever deleted.

After each run has printed its digest, the tool prunes the cache:

- It keeps the newest 50 runs (`retention.keepRuns`; the run that just finished is one of them) whatever their age.
- Among the older ones it deletes those created more than 14 days ago (`retention.maxAgeDays`). A log from before run records existed counts by its modification time; a record whose log is gone is deleted.
- It deletes `state-*.json` files not modified for 90 days (`retention.stateMaxAgeDays`), never the current scope's.
- It never deletes the current run, a file modified in the last hour (another run may be writing it), a symbolic link, or a file that is not named like a run (`run_<id>.log`, `run_<id>.json`) or a state file.
- It deletes at most 200 files per run, oldest first; the rest goes on the next runs.

A failure while pruning prints `dot-test-digest: could not prune the cache: <reason>` on `stderr` and never changes the exit code. `DOT_TEST_DIGEST_PRUNE=0` or `"retention": { "auto": false }` (in either file) turns the automatic prune off; the three limits are read from the user file only (see [Configuration](#configuration)). A cache directory that is a symbolic link is followed once, to the directory it names.

`gc` runs the same rule on demand, without the 200-file cap, and says what it did:

```bash
dot-test-digest gc                                  # removed 10 runs (0 state files), kept 50 runs
dot-test-digest gc --keep 10 --max-age-days 2       # stricter numbers for this call
dot-test-digest gc --state-max-age-days 30
dot-test-digest gc --dry-run                        # would remove 10 runs (0 state files), keeping 50 runs
```

Its defaults are the `retention.*` limits of the user file (50, 14 and 90 unless set there). A value that is not a non-negative integer exits `64` with `--keep must be a non-negative integer, got -1`. On a cache that does not exist it prints `removed 0 runs (0 state files), kept 0 runs`, exits `0` and creates nothing. The one-hour protection applies to `gc` too.

## The TDD gate

`--tdd-phase` makes the tool check that a test-first loop is honest. State lives in `~/.cache/dot-test-digest/state-<scope_id>.json`.

| Phase | When you run it | Result |
| --- | --- | --- |
| `red` | After writing a new test, before the code | `VALID_RED` (exit `0`) only if the test fails on a behavioural assertion or a missing export under test; the failing tests are recorded as the baseline. `INVALID_RED` (exit `64`) if it passes, or fails on a syntax error, an unresolved import or a runner startup crash. |
| `green` | After writing the code | `PASS` when the command exits `0` and at least one test was recognised, with the count of baseline tests that now pass. `INVALID_GREEN` (exit `64`, state unchanged) when it exits `0` but no passed or failed test was recognised; pass `--allow-no-tests` for a runner without a grammar. `FAIL` (the child's exit code) otherwise, with any re-broken baseline test listed as a regression. |
| `refactor` | While restructuring | `PASS`, `INVALID_GREEN` as for `green`, or `REGRESSION_DETECTED` with the newly broken tests. |
| `none` | Everything else | Plain digest, no state. |

This is what stops an agent (or a tired human) from calling a test "red" when it fails only because of a typo in its own import.

## What it understands

The digest picks a grammar from the shape of the output (no flag needed):

| Output from | Grammar | Checked against real projects? |
| --- | --- | --- |
| vitest | `js-test` | Yes (see the example below) |
| `node --test` (default, `tap` and `spec` reporters) | `js-test` | Yes, on Node 22.23.4 only |
| `tsc` | `tsc-eslint` | Yes, small projects |
| jest, Playwright, eslint | `js-test`, `tsc-eslint` | Fixtures only |
| pytest | `python` | Fixtures only |
| `cargo test`, `cargo build`, `go test` | `rust-go` | Fixtures only |
| Anything else | Gear 1 / heuristic tail | No grammar: you get a narrowed log tail, status `BUILD_ERROR` |

The three gears: **Gear 0** is the local grammars above (no network). **Gear 1** is optional: for an *unstructured* failure above 150 lines it asks Jev (`jev-1.13.0`) to pick the relevant windows of the log, and needs `TYPESAFE_API_KEY`. Without a key, or with `--no-jev`, it falls back to a local heuristic. See [Things to know](#where-it-works-well-and-where-it-does-not) for what was and was not measured.

**Privacy.** Gear 1 is the only part of the tool that uses the network. When `TYPESAFE_API_KEY` is set and `--no-jev` is not passed, it sends excerpts of the failing run's log (the failure windows and the tail, bounded in size) to `api.typesafe.ai`. Pass `--no-jev` to keep every run local. Without a key, nothing leaves your machine.

## Example

The same small project run without and with the digest: a cart module with two bugs (`discount` returns the discount instead of the amount left, and `first` crashes on an empty cart) and 29 vitest tests, 5 of them failing. The project is in [`tests/fixtures/vitest-cart/`](tests/fixtures/vitest-cart). It is a recreation: the project I measured the first version of this example with was not kept, so the numbers below come from this one and are not comparable with the earlier ones. First measured on 2026-11-01; re-measured on 2026-11-12 from a throwaway build of this tree (`846620d`, the version that added the `next:` line and the `rerun:` row), Node 22.23.4, vitest 2.1.9, `--no-jev`, in a fresh temporary copy of the fixture. The log path in the pasted digest is shortened to `~/.cache/...`; the byte count is of the real output, with a `/tmp/...` cache path. The raw excerpt is from the first measurement; the raw size moves by a few bytes with the directory name vitest prints on its `RUN` line and with the timings.

```bash
vitest run                                  # raw
dot-test-digest --no-jev -- vitest run      # through the digest
```

**Raw:** 110 lines, 4,317 bytes, exit code `1` (excerpt)

```text
 RUN  v2.1.9 /tmp/m/vc

 ❯ tests/cart.test.ts (29 tests | 5 failed) 48ms
   × cart > discount 10% leaves 90% 20ms
     → expected 100 to be 900 // Object.is equality
   × cart > total without discount 3ms
     → expected +0 to be 1815 // Object.is equality
   × cart > total with 10% off 3ms
     → expected 182 to be 1634 // Object.is equality
   × cart > total with 100% off is free 2ms
     → expected 1815 to be +0 // Object.is equality
   × cart > first of an empty cart is undefined 3ms
     → Cannot read properties of undefined (reading 'name')

⎯⎯⎯⎯⎯⎯⎯ Failed Tests 5 ⎯⎯⎯⎯⎯⎯⎯

… (per-failure diffs and stack traces, omitted here)
 Test Files  1 failed (1)
      Tests  5 failed | 24 passed (29)
   Start at  22:54:05
   Duration  787ms (transform 98ms, setup 0ms, collect 77ms, tests 48ms, environment 0ms, prepare 144ms)
```

**Digest:** 36 lines, 2,265 bytes, same exit code (`1`)

```text
[FAIL] 5 failed, 24 passed in 1489ms | 3 clusters | log: ~/.cache/dot-test-digest/logs/run_mwe2u35s31f1a107.log
next: dot-test-digest show run_mwe2u35s31f1a107 c_c7823024
c_992bb564 ASSERTION_FAILURE x1 tests/cart.test.ts:7:66
  AssertionError: expected 100 to be 900 // Object.is equality
  diff: expected 900 / received 100
  5 |   it("subtotal adds up", () => expect(subtotal(items)).toBe(1500));
  6 |   it("tax is 21%", () => expect(tax(1000)).toBe(210));
  7 >   it("discount 10% leaves 90%", () => expect(discount(1000, 10)).toBe(900));
  8 |   it("discount 50% leaves half", () => expect(discount(2000, 50)).toBe(1000));
  9 |   it("total without discount", () => expect(total(items)).toBe(1815));
  tests: cart > discount 10% leaves 90%
  rerun: vitest run tests/cart.test.ts -t 'discount 10% leaves 90%'
  raw: L5-L27
c_95e904e3 ASSERTION_FAILURE x1 tests/cart.test.ts:9:59
  AssertionError: expected +0 to be 1815 // Object.is equality
  diff: expected 1815 / received 0
   7 |   it("discount 10% leaves 90%", () => expect(discount(1000, 10)).toBe(900));
   8 |   it("discount 50% leaves half", () => expect(discount(2000, 50)).toBe(1000));
   9 >   it("total without discount", () => expect(total(items)).toBe(1815));
  10 |   it("total with 10% off", () => expect(total(items, 10)).toBe(1634));
  11 |   it("total with 100% off is free", () => expect(total(items, 100)).toBe(0));
  tests: cart > total without discount
  raw: L7-L46
c_cf012b19 ASSERTION_FAILURE x1 tests/cart.test.ts:10:59
  AssertionError: expected 182 to be 1634 // Object.is equality
  diff: expected 1634 / received 182
   8 |   it("discount 50% leaves half", () => expect(discount(2000, 50)).toBe(1000));
   9 |   it("total without discount", () => expect(total(items)).toBe(1815));
  10 >   it("total with 10% off", () => expect(total(items, 10)).toBe(1634));
  11 |   it("total with 100% off is free", () => expect(total(items, 100)).toBe(0));
  12 |   it("first item name", () => expect(first(items)).toBe("pen"));
  tests: cart > total with 10% off
  raw: L9-L65
+2 more clusters (see log)
  c_c7823024 ASSERTION_FAILURE x1 tests/cart.test.ts:11:69 cart > total with 100% off is free
  c_8bdc37b0 RUNTIME_EXCEPTION x1 src/cart.ts:10:50 cart > first of an empty cart is undefined
```

Fair reading of this example: vitest already prints a one-line summary of every failure at the top, so the raw output is not hard to scan here. The digest drops the repeated per-failure detail and adds a source window around each failing line. It prints full detail for **3 of the 5 failures** (the `--max-clusters` default is 5, but the output is also capped at about 600 tokens); the other two are listed one per line after `+2 more clusters`, with their id, kind, location and test name, but no message, diff or window. Line 2 points at the first of those two (`show <run> c_c7823024` prints its lines from the log), and the first block's `rerun:` row is a command that runs only `discount 10% leaves 90%`. The one that is not an assertion (the `TypeError` from `first`) is one of the two that only get a line. The full output is always in the log the header names.

A passing run is one line: for the same project with both bugs fixed, `[PASS] 29 passed, 0 failed in 1306ms | log: …` was 86 bytes against 249 bytes raw (10 lines).

## Where it works well, and where it does not

These are measurements from small hand-made projects, not a benchmark. Sizes are raw output against digest output; the digest bytes include the header line with its log path (a `/tmp/...` path here; the default `~/.cache/...` path is a little longer). The failing rows were re-measured on 2026-11-12 from a throwaway build of `846620d`, which added the `next:` line and the first block's `rerun:` row (about 130 bytes); the passing vitest row is from 2026-11-01 (a pass line did not change).

| Case | Raw | Digest | Verdict |
| --- | --- | --- | --- |
| vitest (non-TTY), 5 of 29 failing | 110 lines, 4,317 B | 36 lines, 2,265 B | **Good.** Distinct failures become clusters with file, line, diff and a source window. Full detail for the first 3; the others are listed one per line. |
| vitest, all passing | 10 lines, 249 B | 1 line, 86 B | **Good.** |
| `node --test` (default or `--test-reporter=tap`), 4 of 6 failing | 120 lines, 3,797 B (default); 3,800 B (tap) | 39 lines, 2,395 B (both) | **Good.** The four failures are four clusters (three with file, line, diff and source window), not one merged cluster. The fourth is counted in `+1 more clusters (see log)` and named on the `next:` line; its listed line no longer fits (with a longer cache path only 2 blocks fit, and the other two are listed). |
| `node --test --test-reporter=spec`, 4 of 6 failing | 91 lines, 3,448 B | 39 lines, 2,395 B | **Good.** Parsed, with the same clusters as the tap reporter; no longer reported as `BUILD_ERROR`. |
| `tsc --noEmit`, 5 errors in 2 files | 5 lines, 419 B | 6 lines, 527 B | **Not smaller.** The digest is the header line (108 B with this cache path) plus the 5 raw lines unchanged: the size rule falls back to the raw text when a digest would be larger. So it costs the header and saves nothing, and has no `next:` line. |

Differences from the first version of this table, so the numbers are not read as a like-for-like comparison: the `node --test` project here has 6 tests (not 26) and the `tsc` project has 5 errors (not 6), because these are the fixtures kept in `tests/fixtures/` (`node-cart`, `tsc-small`). The same-bug-in-each claim from before no longer holds; each project has its own failures.

**The TDD gate (`--tdd-phase=red`) is the most reliable part.** In every case I ran it gave the right verdict, and the exit code was `0` for `VALID_RED` and `64` for `INVALID_RED`:

| Red phase run | Status | Exit code |
| --- | --- | --- |
| vitest, an assertion fails | `VALID_RED` | `0` |
| `node --test` (default, tap or spec reporter), an assertion fails | `VALID_RED` | `0` (each of the three) |
| vitest, import of a missing module | `INVALID_RED` (`SYNTAX_IMPORT_ERROR`) | `64` |
| `node --test` (default, tap or spec reporter), import of a missing module | `INVALID_RED` (`SYNTAX_IMPORT_ERROR`) | `64` (each of the three) |
| `node --test` (default or spec reporter), a test file that exits at load time (`process.exit(1)`, no error printed) | `INVALID_RED` (`SYNTAX_IMPORT_ERROR`) | `64` (each of the two) |
| `node --test` (default, tap or spec reporter), a test file the runner cannot read (`chmod 000`, `Error: EACCES: permission denied, open '<path>'` naming the test file) | `INVALID_RED` (`SYNTAX_IMPORT_ERROR`) | `64` (each of the three) |
| `node --test` (default, tap or spec reporter), a test that reads another unreadable file at load (`fs.readFileSync` of a `chmod 000` `secret.txt`; the `EACCES` error names `secret.txt`, not the test file) | `VALID_RED` (`RUNTIME_EXCEPTION`) | `0` (each of the two I ran: tap and spec) |
| `node --test`, the test already passes | `INVALID_RED` | `64` |
| `node --test` (default, tap or spec reporter), import of an export that does not exist | `VALID_RED` | `0` (each of the three) |

The `node --test` labels are now the right ones for what I checked: with `--format=json`, an assertion failure under the spec reporter is `ASSERTION_FAILURE` (the failing `first()` call is `RUNTIME_EXCEPTION`), a missing module is `SYNTAX_IMPORT_ERROR`, and a missing export is `RUNTIME_EXCEPTION` (`The requested module './cart.js' does not provide an export named 'applyCoupon'`), which is why it counts as a valid red. I checked the JSON labels only for the spec reporter and not for default or tap, except for the file that exits at load time, which I checked with both the default and the spec reporter, and the unreadable file, which I checked with default, tap and spec (all three: `SYNTAX_IMPORT_ERROR`, message `Error: EACCES: permission denied, open '<path>'`; the build before this change gave `VALID_RED`, exit `0`, `RUNTIME_EXCEPTION` under each of the three). Only a read failure of the test file itself counts: the error must be `Error: EACCES` or `Error: EPERM` and its text must contain the crashed test file's absolute path in single quotes (`open '<path>'`). Measured with `cfg.test.js` reading an unreadable `cfg.test.json` at load: the build before this change gave `INVALID_RED`, exit `64`, `SYNTAX_IMPORT_ERROR` under tap and spec (the old check looked for the path without its quotes, and `/dir/cfg.test.json` contains `/dir/cfg.test.js`), this version gives `VALID_RED`, exit `0`, `RUNTIME_EXCEPTION` under both. The two rows about a file with mode `000` need a user who is not root, because root can read such a file; I ran them as a normal user. I did not try `EPERM`, and `EISDIR` is no longer in the list.

**Things to know before relying on it**

- Clusters are grouped by the shape of the error, not by root cause. One bug that produces different assertion messages makes several clusters (in the vitest example, the one bug in `discount` makes four assertion clusters, each with different expected and received values).
- Only the first 3 clusters of the vitest run above were printed in full (the same 3 with and without the `next:` and `rerun:` lines). The output is capped at about 600 tokens, so a run with more failures than fit shows the rest as `+N more clusters (see log)`.
- The clusters that do not fit are no longer only counted: each one is listed on its own line with its id, kind, location and test name. When the digest would be larger than the raw output (the `tsc` row), the footer is not printed because the raw text already shows every failure.
- Size rule: the digest is never larger than the raw output plus its header line. By design it degrades in steps (no source windows, then no stack frames, then one line per cluster, and in the end the header plus the raw text). I observed only two outcomes: the full form (every other case here) and the last step (the `tsc` case); I did not construct runs that land on the middle steps. The cap on the full-detail form is unchanged at 600 tokens and 2,400 bytes, counted with the final newline.
- With many omitted clusters the digest keeps the full blocks the user asked for and lists what fits after them. The budget is spent in this order: first the full blocks (as many of the kept clusters as fit together with the header and the `+N more clusters (see log)` line, at least one), then as many whole listed lines as fit in what is left; clusters whose line does not fit stay counted in `N`. Measured on 2026-11-10 from throwaway builds on a project with 30 files `src/m1.ts` ... `src/m30.ts`, each `export const vN: number = "text N";` (30 distinct `tsc` errors, 2,451 bytes of raw output), run as `--no-jev --max-clusters=5 -- npx tsc --noEmit` (exit code `2` in all three):

  | Build | Header cluster count | Full blocks | `+N` line | Listed lines | Bytes |
  | --- | --- | --- | --- | --- | --- |
  | v0.1.2 (`4f540a8`) | 5 | 5 | none | 0 | 1,026 |
  | previous shipped rule (`2e2613a`) | 1 | 1 | `+29 more clusters (see log)` | 19 | 2,366 |
  | 0.1.4 rule (`c240b9b`) | 5 | 5 | `+25 more clusters (see log)` | 13 | 2,377 |
  | this version, with `next:` (`846620d`, 2026-11-12) | 5 | 5 | `+25 more clusters (see log)` | 12 | 2,330 |

  So the 0.1.4 rule prints the same 5 full blocks as v0.1.2, then the `+25` line, then 13 of the 25 omitted clusters on a line each; the other 12 are only counted in the 25. This version adds the `next:` line (reserved before the blocks, like the `+25` line; `tsc` clusters have no `rerun:` row), keeps the 5 full blocks and lists 12 (35 lines; the byte count is with a shorter `/tmp` cache path than the older rows, so compare lines, not bytes). Bytes move by a few with the length of the log path (the previous README said 1,025 and 2,365 for the same two older builds, with a shorter path). I did not search for the number of omitted clusters at which the listing stops; I only ran 30 files. The vitest example above gives the same result with the 0.1.4 rule as before: 3 full blocks, `+2 more clusters (see log)` and the 2 listed lines (34 lines, 2,136 bytes with a long `/tmp` log path; 36 lines with `next:` and `rerun:`). `--format=json` still carries 5 clusters (`--max-clusters`).
- A `node --test` file that crashes at load (missing module, syntax error, a throw) takes its error from the crash block node printed directly above its own entry, under both the tap and the spec reporter, and from nothing else. A block starts at a line that holds only a location, which is any line that is not indented, is not an error line, ends in `:<N>` and is followed, before the block's trailer, by an error line (so a message that continues on a line ending in a number, `/etc/app/config.json:12`, is not the location) (`file:///...:3`, `node:internal/...:275`, `/dir with a space/x.test.cjs:3`, `<anonymous_script>:1` for `eval` code, or the same text glued after a partial stdout line), runs through the source line, the error and its stack, and ends at `Node.js v22.23.4`; the digest uses the first `<Name>Error: <text>` line of it. When several blocks sit above the entry (a server a setup module started crashed after the file did), the first block whose error is an import or syntax error wins, so a broken import is never hidden, and otherwise the last block does. A line printed outside the block (a setup module's log, another file's output) never stands in for the file's error, whether or not it names the file, and a crash block that names another file (`Cannot find module '.../missing-dep.js' imported from .../helper.js`, thrown from a helper the test imports) is still the test's error. When the block has no such line (`throw 42`) or there is no block (`process.exit(1)` at load), the message stays `test failed`, which is `INVALID_RED`. Measured on Node 22.23.4 with a setup module (`--import data:text/javascript,console.log("Error: config.json not found, using defaults")`), `--no-jev --tdd-phase=red`, in a copy of `tests/fixtures/node-cart/` (a throwaway build of origin/main `74208cc`, then this version; each cell is one measured run, the cluster message trimmed):

  | Case | Reporter | Before | Now |
  | --- | --- | --- | --- |
  | setup log, then `missing-module.test.js` | tap | `VALID_RED`, exit `0`, `Error: config.json not found, using defaults` | `INVALID_RED`, exit `64`, `Cannot find module '.../missing.js' imported from ...` |
  | the same | spec | `INVALID_RED`, exit `64`, `Cannot find module` | same |
  | setup log, then `deep.test.js` importing `helper.js`, which imports a missing `missing-dep.js` | tap, spec | `VALID_RED`, exit `0`, `Error: config.json not found, using defaults` | `INVALID_RED`, exit `64`, `Cannot find module '.../missing-dep.js' imported from .../helper.js` |
  | setup log, then `throw42.test.js` (`throw 42;`) | tap, spec | `VALID_RED`, exit `0`, the setup line | `INVALID_RED`, exit `64`, `test failed` |
  | `logc.test.js` (logs `TypeError: cfg.get is not a function (handled)`, passes) next to `exitload.test.js` (`process.exit(1);`), in both file orders | tap | `INVALID_RED`, exit `64`, `test failed` | same |
  | the same two runs | spec | `VALID_RED`, exit `0`, the logged `TypeError` | `INVALID_RED`, exit `64`, `test failed` |
  | a load-time `TypeError` in a `.cjs` file in a directory whose name has a space, in `eval("null.x")` code, or after a partial stdout line (`process.stdout.write("partial line no newline")`) | tap, spec | `VALID_RED`, exit `0`, `TypeError: ...` | same (kept as a pin: a location rule that does not accept a space or `<anonymous_script>:1` would make these `INVALID_RED`) |
  | `asyncfail.test.js`: a test that passes and a `setTimeout` it leaves behind that throws later | tap | `VALID_RED`, exit `0`, `Error: Test "calls impl" at asyncfail.test.js:3:1 generated asynchronous activity after the test ended. ...` | same |
  | the same | spec | `INVALID_RED`, exit `64`, `test failed` | `VALID_RED`, exit `0`, the same `Error: Test "calls impl" ...` |
  | `cart.test.js` (four failing tests) next to `latethrow.test.js` (a passing test and a file-level `setTimeout` that throws a `TypeError` after 50 ms) | tap, spec | spec `INVALID_RED`, exit `64`; tap `VALID_RED`, exit `0` | `VALID_RED`, exit `0` under both |
  | an unreadable (`chmod 000`) test file run through a symlinked directory | tap, spec | `VALID_RED`, exit `0` | `INVALID_RED`, exit `64` |
  | an `uncaughtException` from a timer, `setTimeout(() => { throw new Error("u"); }, 5)` | tap | message `u` | `Error: u`, same `cluster_id` as the spec reporter |
  | `--import ./setup-dev.mjs` starts a server (`server.js`, stdio inherited) that throws `TypeError: app.listen is not a function` once the process that started it is gone, then `missing-module.test.js` | tap, spec | `INVALID_RED`, exit `64`, `Cannot find module '.../missing.js' imported from ...` | same (both blocks sit above the entry; the commit before this rule, `1940583`, exited `0` here) |
  | `multiline.test.js`: `throw new TypeError("config invalid at\n/etc/app/config.json:12")` | tap, spec | `VALID_RED`, exit `0`, `TypeError: config invalid at` | same (the commit before this rule, `1940583`, exited `64` here) |

  A file whose tests ran and then failed on a late error takes node's diagnostic `Error: ... generated asynchronous activity after the test ended.` (found among the lines above its entry when there is no crash block) as its message, under both reporters. The spec reporter prints it on an `ℹ` row; the lines above a file's `✖` row run back to the previous test row (`✔`, `✖`, `▶`, `﹣`), so `ℹ` rows belong to them.

  The earlier measurements still hold: a `syntax-error.test.js` run next to `missing-module.test.js` under the spec reporter reads `SyntaxError: Unexpected end of input`. A stream with several node runs (a wrapper that runs `node --test` once per file) gives each crashed entry the block above its own `✖` row, so the same file crashing in two runs keeps each run's own error (checked at the adapter, on the real stream of `node wrap.mjs spec twice.test.js twice.test.js`: `TypeError: first run`, then `RangeError: second run`). This rule reads where node relays the subprocess's output (node's stdout on 22.23.4) and the layout of that version's reporters; I did not run other Node versions, and I did not run a wrapper that sends the subprocess's stderr somewhere else.
- Two failing tests with the same name in one file are kept as two failures, and the test name carries the line it was declared on: `handles empty @4` and `handles empty @7` in a `node --test` run (default, tap and spec reporters all printed it). The suffix is added only when a name is shared by two or more failures of the same file, and it uses the line of the test, so the same name in different files stays plain. I only checked this with `node --test`.
- The child process's exit code is passed through unchanged (observed in every run above).
- Grammars for pytest, `cargo test`, `go test`, jest, Playwright and eslint exist and are covered by fixtures in this repo's tests, but **I did not run them against real projects**. Treat them as untested in practice. The same holds for their `rerun` commands (jest, pytest, cargo, go, eslint): checked against fixture logs only, never run. Only the `node --test` and `vitest` rerun commands were executed.
- `rerun` commands are quoted for a POSIX shell only; Windows was not tried.
- Gear 1 (the optional Jev call) was not exercised: every measurement used `--no-jev`.

**How these were measured.** Each project was copied to a fresh temporary directory (the vitest and tsc copies use this repo's `node_modules`), then each command was run twice with stdout and stderr redirected to a file, so vitest ran non-TTY: once raw and once through the digest, with `DOT_TEST_DIGEST_HOME` pointing at a temporary directory. Lines and bytes are `wc -l` and `wc -c`. Commands, with `D` standing for `node dist/index.js --no-jev`:

```bash
vitest run                                  # in tests/fixtures/vitest-cart, and D -- vitest run
tsc --noEmit                                # in tests/fixtures/tsc-small, and D -- tsc --noEmit
node --test cart.test.js                    # in tests/fixtures/node-cart, and D -- node --test cart.test.js
node --test --test-reporter=tap cart.test.js
node --test --test-reporter=spec cart.test.js
D --tdd-phase=red --scope-id <id> -- <the same commands>   # red-phase table; missing module: missing-module.test.js,
                                                           # missing export: missing-export.test.js, already passing: passing.test.js
```

The many-omitted-clusters bullet was measured on 2026-11-10 from three throwaway builds, and its last row on 2026-11-12 from a build of `846620d` made by `.claude/skills/verify/verify.sh launch`, (worktrees at `4f540a8`, `2e2613a` and `c240b9b`, each built with `npx tsc -p . --outDir dist`), on a project of 30 files `src/m1.ts` ... `src/m30.ts` (`export const vN: number = "text N";`) with the `tsconfig.json` of `tests/fixtures/tsc-small/`, command `D --max-clusters=5 -- npx tsc --noEmit`. The unreadable-file and crashed-file rows ran in a copy of `tests/fixtures/node-cart/` with `noread.test.js` (`import test from "node:test"; test("x", () => {});`, mode `000`) added. The crash-block table ran on 2026-11-10 from two throwaway builds (the base `9cae136` and this branch, each built with `npx tsc -p . --outDir dist`), in copies of the same fixture with `helper.js`, `deep.test.js`, `throw42.test.js`, `exitload.test.js`, `logc.test.js`, `cfg.test.js` and `cfg.test.json` (mode `000`, run as a user who is not root) added, as `node dist/index.js --no-jev --format=json --tdd-phase=red -- node --test [--test-reporter=spec] <files>`.

For the red-phase table's vitest missing-module case, a one-test project imported `../src/nope`, which does not exist. The all-passing vitest row is the cart fixture with the two bugs fixed.

## Develop

```bash
pnpm install
pnpm verify     # typecheck + unit tests
pnpm build      # emits dist/ with the dot-test-digest bin
pnpm run schema # regenerates schema/digest-envelope.schema.json from src/types/schema.ts (commit it with any envelope change)
```

To prove a change on the real binary (not just the unit tests), use the verification skill: `.claude/skills/verify/verify.sh launch | doctor | drive | cleanup`. It builds the current commit into a scratch directory, runs it against copies of the fixtures with an isolated cache, and keeps the evidence. The journeys it should cover are in [`.dotstack/features/`](.dotstack/features/README.md).

## License

[MIT](LICENSE) © 2026 Octavio Sardi and Flowdots.
