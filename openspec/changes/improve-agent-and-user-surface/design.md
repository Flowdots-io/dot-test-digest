## Context

v0.1.x is a one-shot wrapper: `dot-test-digest [flags] -- <command>` spawns the child, keeps every captured line in an array, runs the adapters, prints a bounded digest and writes `logs/run_<id>.log` plus an optional `state-<scope>.json` under `DOT_TEST_DIGEST_HOME` (default `~/.cache/dot-test-digest`). Nothing records what a run was (the log holds raw lines only: no command, exit code or options), nothing deletes old runs, and a bare word before `--` is a usage error. The constraints of the archived changes stay: INV-1 (pass line at most 160 bytes), INV-2 (failure digest at most 2,400 bytes and 600 EstimatedTokens), INV-3 (the child's exit code passes through), INV-5 (red gate), INV-6 (Gear 1 limits), runtime dependency `zod` only (relaxed for S10, below).

Measured on 2026-11-11 (Node 22.23.4, `--no-jev`, build of `origin/main`): `... | head -3` printed an unhandled `EPIPE` trace; `--tdd-phase=green -- true` printed `[PASS | GREEN] 0 passed, 0 failed`; a node run with 1 pass, 1 skip and 1 todo printed `1 passed, 0 failed` and `summary.skipped` was 2; 400,000 lines of output used 240 MB RSS and died with `exit 134` under `node --max-old-space-size=96`; the cache held 768 logs and 193 state files; the 4-failure `node --test` fixture needs 3 full blocks within 2,380 bytes with a short fixture path (2 with a longer one).

## Goals / Non-Goals

**Goals:**
- Each slice is self-contained: its own capability spec, its own tests, and a green `pnpm run verify` when merged alone after its prerequisites.
- No existing exit code, status or byte ceiling changes except where a requirement says so (the single **BREAKING** item is `INVALID_GREEN`).
- Every new surface is bounded (exit codes, sizes) and testable from the CLI.

**Non-Goals:**
- Section D and E of the improvement list, A7, C2 and C6 (see `proposal.md`).
- A Claude Code hook (see "Defaults chosen").
- Changing any grammar's clustering or the `compact-md` block layout.

## Slice map

| Slice | Capabilities | Prerequisite | Touches |
| --- | --- | --- | --- |
| S1 | `run-hardening` | none | `index.ts`, `tdd-gate.ts`, `envelope.ts`, `args.ts`, `tsc-eslint.ts` |
| S2 | `run-record` | none | `index.ts`, new `src/cli/`, `raw-log.ts`, `args.ts` |
| S3 | `cache-retention` | S2 | new `src/cache/prune.ts`, `src/cli/gc.ts` |
| S4 | `run-replay`, `usage-stats` | S2 | new `src/cli/replay.ts`, `stats.ts`; the run pipeline is extracted from `index.ts` |
| S5 | `digest-input` | S2, S4's extracted pipeline | new `src/cli/digest.ts` |
| S6 | `config-file`, `terminal-color` | none (S3 and S8 read its keys when present) | new `src/config/`, `args.ts`, `envelope.ts` |
| S7 | `agent-output-contract`, `rerun-hints` | S2 (the `next:` line uses `show`) | `envelope.ts`, `schema.ts`, adapters, `schema/` |
| S8 | `bounded-memory`, `progress-output` | S2 (record `raw_lines`) | `capture.ts`, `raw-log.ts`, all adapters' input type |
| S9 | `doctor-and-init` | S6 | new `src/cli/doctor.ts`, `init.ts` |
| S10 | `mcp-server` | S2, S4, S6, S7 | new `src/mcp/`, `package.json` |

Order of implementation: S1, S2, S6, S3, S4, S5, S7, S8, S9, S10. S1 and S6 can run in parallel with S2.

## Decisions

- **One run pipeline, many entry points.** `run`, `replay` and `digest` all end in the same function (adapters, dedupe, phase decision, envelope, format). S4 extracts it from `main()` as `digestRun(input): Promise<DigestOutcome>`; `run` feeds it a live capture, `replay` the stored log, `digest` a file. This keeps one place for the size rule and the status logic. (Rejected: three copies of the post-processing, which is how the 0.1.x reporters drifted.)
- **The run record is a sidecar JSON, not a header in the log.** `run_<id>.json` beside `run_<id>.log`, written atomically (unique temp file, then rename) after the digest is rendered, so it can hold `digest_bytes`. The log stays raw lines only, so every `raw: L<a>-L<b>` pointer still resolves to the same lines. (Rejected: a metadata first line in the log, which would shift every line number and break the pointer contract; a single index file, which needs a lock for concurrent runs.)
- **Subcommands are the first bare word.** If `argv[0]` is one of `show replay gc stats digest doctor init mcp config schema`, the subcommand runs. Any other bare first word keeps today's `missing -- delimiter before "<word>"` error, and `-- show` still runs a program called `show`. The wrapper grammar `[flags] -- <command>` is untouched. (Rejected: a `run` subcommand and a flag-style `--show`, which mix the two grammars.)
- **Exit codes of subcommands.** `0` success, `64` usage error (existing `EX_USAGE`), `66` a run, record, log or input file that does not exist (`EX_NOINPUT`), `70` internal error (existing `EX_SOFTWARE`), `1` for `doctor` when a check fails. `replay` and `digest` return the exit code the original run returned or the one the caller supplied (the tool is transparent for what it digests); nothing else returns a child code.
- **Run references.** A reference is `last`, a full run id, or a unique prefix of at least 6 characters. `last` is the newest record whose `cwd` equals the current directory (agents in several repos must not see each other's runs). Newest means greatest `created_at`, ties broken by run id.
- **Pruning rule.** Keep the newest 50 runs; among the rest delete those older than 14 days; never the current run; never a file modified in the last hour (another process may be writing it). State files untouched for 90 days are deleted. A pair `.log` and `.json` is one run; a log without a record uses its mtime as `created_at`; a record without a log is deleted. All defaults are configuration keys (S6). (Rejected: size-based quotas, which depend on the disk; deleting by age alone, which removes the runs of a quiet repository the user still wants.)
- **`INVALID_GREEN` mirrors `INVALID_RED`.** `--tdd-phase=green|refactor`, child exit 0, and `passed === 0 && failed === 0` (skipped tests do not count) is `INVALID_GREEN`, exit 64, with a one-line stderr message. `--allow-no-tests` is the explicit opt-out for runners without a grammar. The state file is not written. (Rejected: a warning only, which a loop that reads exit codes never sees; strictness behind a flag, which leaves the unsafe default.)
- **Warnings are not skipped tests.** `tsc-eslint` stores warnings in `skipped` today, so showing `skipped` in the header would call eslint warnings skipped tests. S1 adds `summary.warnings` (present only when nonzero) and moves the adapter's warning count there; `skipped` then means skipped or todo tests for every grammar.
- **`next:` is line 2, only with a run id.** The line sits under the header, is reserved by the size budget before the full blocks (like the `+N more clusters` line), and exists only at size levels 1 to 4 and only when the envelope carries a `run_id` (the CLI always does). A hand-built envelope without a run id renders exactly as before.
- **`rerun:` appears on the first full block only,** at levels 1 and 2, and on every cluster in JSON. One line per block would cost about 70 bytes each of a 2,400-byte budget; one agent step needs one test.
- **Spill the output to the log (S8).** Adapters keep their `(lines: readonly CapturedLine[])` access pattern, but the argument becomes a `LineSource` (`count`, `at(n)`, `slice(from, to)`, iteration) that is backed by memory up to 4 MiB of output and by the log file, read through a cache of at most 8 MiB of chunks, above that. The raw text for size level 5 is only built when the output is at most 2,400 bytes. (Rejected: keeping the head and tail only, which silently loses a failure printed in the middle; rewriting the grammars as streaming parsers, which is far larger than the problem.)
- **Config is JSON validated strictly** (small per-kind checkers rather than zod, so the messages are exactly the ones the spec names). An unknown key, a wrong type or an out-of-range value is a usage error that names the file and the key. One project file is used (the nearest one found walking up to the first directory that contains `.git`, never above the user's home directory, and not at all outside home without a `.git`); it is not merged with parent directories.
- **Allowlist trust (S10).** `mcp.allow` is read from the user file and from `--allow` arguments only. A project file that contains an `mcp` key is ignored for that key and the server prints a warning on stderr.
- **MCP uses the official SDK, loaded lazily.** `import("@modelcontextprotocol/sdk/...")` runs only inside the `mcp` subcommand, so the startup cost and the dependency list of a normal run do not change.

## Compatibility with the archived scenarios

The archived scenarios (`openspec/specs/`) assert exact bytes for envelopes built without a run id and clusters built without a rerun hint. They stay true because: `next:` needs a `run_id`; `rerun:` needs `cluster.rerun`; `summary.warnings` and `summary.omitted_clusters` are present only when nonzero; the skipped and warning segments of a header appear only when nonzero. The CLI-level scenarios that quote a fixed digest size (the 30-error `tsc` example in the README) are re-measured by the S7 task and the README numbers updated. Tests that compare a whole JSON envelope with `toEqual` gain `schema_version` and `run_id`; the S7 task updates them.

## Scenario conventions

Every scenario runs `dot-test-digest` through `main(argv, deps)` unless it says "spawned". Terms used in the specs:

- **the cart**: the working directory is a fresh copy of `tests/fixtures/node-cart/`. `cart.test.js` has 6 tests, 2 pass and 4 fail (cluster ids `c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a`); `passing.test.js` has 1 passing test; `missing-module.test.js` imports a module that does not exist.
- **a fresh home**: `DOT_TEST_DIGEST_HOME` is an empty temp directory, so `logs/` and `state-*.json` are the only things in it.
- **`--no-jev`** is always passed or implied (`MainDeps.client` is a stub that fails the test if called).
- `<t>` stands for a duration in milliseconds, matched by `\d+`; `<run>` for a run id matched by `run_[0-9a-z]{9,}`; a header is the first stdout line.
- "the log" is `logs/<run>.log`, "the record" is `logs/<run>.json`.

## Exit codes and ids used across slices

| Situation | Exit |
| --- | --- |
| usage error in any subcommand | 64 |
| run, record, log or input file not found | 66 |
| `INVALID_RED`, `INVALID_GREEN` | 64 |
| internal error | 70 |
| `doctor` with a failed check | 1 |
| `replay`, `digest` | the original or supplied code |
| a run id looks like `run_<base36 time><8 hex>`; a cluster id like `c_<8 hex>` | |

## Test seams

- **CLI through `main(argv, deps)`** (in process, in a temp copy of `tests/fixtures/node-cart/`, with `DOT_TEST_DIGEST_HOME` set to a temp directory): every scenario about exit codes, headers, files written, subcommand output and configuration. This is the highest seam that sees the behavior, and `MainDeps` already exists as the injection point; S1 and S6 add `isTTY`, `now`, `writeRecord` and `env` to it for the failure and TTY scenarios.
- **Spawned process** (`node dist/index.js`, `stdio: pipe`): only where a real file descriptor matters: closed stdout (S1), stdin for `digest -` (S5), memory under `--max-old-space-size` (S8), heartbeat timing (S8) and the MCP server over stdio (S10, using the SDK's own client).
- **`formatEnvelope(envelope, format, context)`**: byte-exact rendering of the `next:` line, the `rerun:` row, the skipped and warning segments, colors and ndjson.
- **`jsTestAdapter.parse`, `pythonAdapter.parse`, `rustGoAdapter.parse`, `tscEslintAdapter.parse`** over fixture logs: rerun hints and warning counts per grammar.
- **`pruneCache(dir, options, now)`**: retention arithmetic with synthetic run pairs whose mtimes are set with `fs.utimesSync`; `gc` and the automatic prune both call it.
- New seams proposed: none besides the two function seams above (`pruneCache`, `LineSource`), because the CLI cannot choose a clock or a 4 MiB threshold.

## Defaults chosen

- **Hook half of B5 not specified.** Claude Code's hook semantics for rewriting a Bash command were not verified here, so S10 covers the MCP server and `init --print-mcp-config`; the hook is a follow-up once its contract is read from the product docs. Change by: say "add the hook" and give or approve the hook contract.
- **`--allow-no-tests`** as the opt-out name and the stderr text of `INVALID_GREEN`. Change by: naming another flag.
- **`last` is scoped to the current directory.** Change by: asking for a global `last`.
- **Replay never writes** (no state, no record, no new log) and never calls the network. Change by: asking replay to record.
- **`digest` omits `in <t>ms`** from the header (there was no run to time) and infers exit 1 when it parsed a failure, else 0. Change by: asking for a fixed `0ms` or for a required `--exit-code`.
- **`next:` is line 2 of the digest.** Change by: asking for the last line (it would then replace the "ends with `+N more clusters`" rule of the archived change).
- **`color` applies to the status word of the header only.** Change by: asking for colored cluster ids or diffs.
- **Prune constants** (50 runs, 14 days, 90 days for state, 1 hour untouchable). Change by: giving other numbers; they are configuration keys.
- **`gc`, `stats` and `show` output formats** are exact text lines (given in the specs); change by: asking for another layout.
- **The version becomes `0.2.0`** with SPEC-002 revision `0.2.0` (new subcommands and one breaking verdict). Change by: asking for `0.1.5`.
- **`doctor` detects eight runners** (vitest, jest, `node --test`, pytest, cargo, go, tsc, eslint) and warns about mocha, which has no grammar. Change by: naming others.

## Risks / Trade-offs

- [`INVALID_GREEN` blocks a green loop on a runner without a grammar] -> `--allow-no-tests`, and `doctor` names the runners without a grammar.
- [A `next:` line plus a `rerun:` row cost about 130 bytes, so the 4-failure fixture shows 2 full blocks where it showed 3] -> the lost block moves to the listed lines; nothing is dropped, and S7 re-measures the README numbers. The size ladder is unchanged.
- [S8 changes the input type of every adapter] -> `LineSource` is array-compatible (`at`, `slice`, `length`) so grammars change type annotations, not logic; the gate is the 296 existing tests passing unmodified before any new scenario.
- [Auto-prune deletes the user's files] -> only inside the cache directory, only runs older than 14 days beyond the newest 50, never the current run or anything modified in the last hour; `DOT_TEST_DIGEST_PRUNE=0` disables it.
- [The MCP SDK pins a zod major] -> checked in the S10 install task; if it needs a different zod the task stops and reports it before any code.
- [Rerun hints for jest, pytest, cargo, go and eslint are tested against fixtures only, never against the real tools (A7 is deferred)] -> the README and `.dotstack/features/` mark them unverified, as for the grammars themselves.
- [Windows is not covered (C6 deferred)] -> shell quoting in `rerun:` is POSIX only; stated in the README.
