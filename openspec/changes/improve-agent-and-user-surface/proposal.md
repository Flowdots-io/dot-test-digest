Ticket: none (request text: "create a spec for changes of the section A, B and C [of the improvements list], in an orderly manner so that it can be implemented in slices (like subspecs, self-contained and testable). Ask questions until we reach a common understanding.")

## Why

A hand-driven exploration of v0.1.x (2026-11-11, Node 22.23.4, `--no-jev`) found sharp edges in the trust contract (a closed stdout crashes the tool, a green gate accepts zero tests, skipped tests vanish from the pass line, the cache is never cleaned, 1M output lines cost 487 MB) and a gap for agents and humans: a digest cannot be re-read, replayed, produced from a CI log, configured, or reached from an MCP client. Each slice below fixes or adds one of these and can ship alone.

## What Changes

Ten slices, in this order (S1 and S6 have no prerequisite; the others are listed in `design.md`):

- **S1 Hardening.** A closed stdout keeps the child's exit code and prints no stack trace; `--tdd-phase=green|refactor` with no recognized passing test is `INVALID_GREEN` (exit 64, **BREAKING** for a gate that passed on zero tests; `--allow-no-tests` restores it); skipped and warning counts appear in the headers; an exit-0 run no grammar recognized prints `[PASS] exit 0 in <t>ms` instead of `0 passed, 0 failed`.
- **S2 Run record.** Every run writes `run_<id>.json` beside its log; subcommands arrive (`show` first); `dot-test-digest show <run|last> [range|cluster_id]` reads the raw log by range.
- **S3 Retention.** Each run prunes old logs, records and state files; `gc` prunes on demand.
- **S4 Replay and stats.** `replay` re-renders a stored run with other options without re-running it; `stats` totals bytes and tokens saved.
- **S5 Digest input.** `digest <file|->` digests an existing log or a pipe.
- **S6 Config and color.** `.dot-test-digest.json`, a user file and `DOT_TEST_DIGEST_*` env vars; `config` prints the effective settings; `--color`.
- **S7 Agent output contract.** A `next:` line under the header, `schema_version` and `run_id` in the JSON, a committed JSON Schema, `--format=ndjson`, and a `rerun:` hint per runner.
- **S8 Bounded memory and progress.** Output is read back from the log instead of held in memory; opt-in `--progress` heartbeat on stderr.
- **S9 Doctor and init.** `doctor` checks the setup and suggests the command for the detected runner; `init` writes a starter config.
- **S10 MCP server.** `dot-test-digest mcp` (stdio) with `run_tests`, `show_log`, `replay`, `list_runs` and a user-owned command allowlist.

Additive JSON changes (`schema_version`, `run_id`, `summary.warnings`, `summary.omitted_clusters`, `clusters[].rerun`) are listed in `design.md`; none removes or renames a field.

## Capabilities

### New Capabilities
- `run-hardening`: closed-stdout safety, `INVALID_GREEN`, skipped and warning counts, the no-grammar pass line (S1).
- `run-record`: the run record, run references, subcommand dispatch and `show` (S2).
- `cache-retention`: automatic pruning and `gc` (S3).
- `run-replay`: `replay` (S4).
- `usage-stats`: `stats` (S4).
- `digest-input`: `digest <file|->` (S5).
- `config-file`: project, user and environment configuration and `config` (S6).
- `terminal-color`: `--color` (S6).
- `agent-output-contract`: `next:` line, JSON contract, JSON Schema, ndjson (S7).
- `rerun-hints`: per-runner rerun commands (S7).
- `bounded-memory`: output read from the log (S8).
- `progress-output`: `--progress` (S8).
- `doctor-and-init`: `doctor` and `init` (S9).
- `mcp-server`: `dot-test-digest mcp` (S10).

### Modified Capabilities
<!-- none: every requirement is new; existing exact-output scenarios stay true because new lines and fields appear only when a run id, a runner or a nonzero count exists (see design.md "Compatibility with the archived scenarios") -->

## Impact

- Code: `src/index.ts` (dispatcher, record, prune, EPIPE), new `src/cli/` subcommand modules, `src/cli/args.ts`, `src/state/tdd-gate.ts`, `src/formatters/envelope.ts`, `src/types/schema.ts`, `src/runner/capture.ts` and `raw-log.ts` (S8), the adapters (S1 counts, S7 rerun), new `src/mcp/`.
- Dependencies: runtime adds `@modelcontextprotocol/sdk` (loaded only by `mcp`); dev adds `zod-to-json-schema` and `ajv`.
- Docs: README, `specs/SPEC-002-DOT-TEST-DIGEST.md` (new `INV-7`, §4.1, §4.3, revision `0.2.0`), `.dotstack/features/`.
- Consumers: scripts reading `summary` keys by exact equality (the feature map's JSON journey) must allow the new keys.

## Out of scope

Deferred by decision: A7 (real-world conformance suite), C2 (npm publishing), C6 (Windows), section D (diff-aware clusters, local flake detection, baseline compare, `--timeout`, slow tests), section E (new grammars). The Claude Code hook half of B5 is not specified (see `design.md` "Defaults chosen").
