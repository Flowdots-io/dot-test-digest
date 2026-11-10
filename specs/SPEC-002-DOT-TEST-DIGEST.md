# Specification: `dot-test-digest` (Three-Gear Test, Compiler & Build Output Compressor)

| Field | Value |
| :--- | :--- |
| **Spec ID** | `SPEC-002-DOT-TEST-DIGEST` |
| **Status** | `DRAFT` |
| **Version** | `0.1.4` |
| **Date** | 2026-11-10 |
| **Supersedes** | `0.1.3` (2026-11-01) |
| **Target Runtime** | Node.js `>= 20.x` / TypeScript `5.x` |
| **Upstream Dependency** | `zod`, TypeSafe AI Jev API (`jev-1.13.0+`) |
| **Amended by** | `specs/INTEGRITY-SPEC-002.md` — findings `F1`–`F11`, resolutions `R1`–`R15`; `specs/DELTA-SPEC-002-0.1.2.md` — deltas `Δ-1`–`Δ-5`; `openspec/changes/sharpen-weak-digest-cases/` — the `node --test` grammar (§4.2.3), the size rule and omitted-cluster listing (§4.1.1); `openspec/changes/harden-node-digest-cases/` — the omitted-cluster budget order and single byte limit (§4.1.1), error attribution, read failures and TAP/spec parity (§4.2.3) |

## 1. Normative Language & Terminology

The key words **"MUST"**, **"MUST NOT"**, **"REQUIRED"**, **"SHALL"**, **"SHALL NOT"**, **"SHOULD"**, **"SHOULD NOT"**, **"RECOMMENDED"**, **"MAY"**, and **"OPTIONAL"** in this document are to be interpreted as described in RFC 2119.

| Term | Definition |
| :--- | :--- |
| **`DigestEnvelope`** | The payload emitted to `stdout`. In `compact-md` (the default) it is bounded by `INV-1` on pass and `INV-2` on failure; in `json` it is the complete structured document of §4.1 and is not byte-bounded (§4.1.1). |
| **`FailureCluster`** | A deduplicated group of one or more failing tests or compiler diagnostics that share an identical `RootCauseFingerprint`. |
| **`RootCauseFingerprint`** | A deterministic hash `SHA256(error_kind + top_repo_frame_location + normalized_assertion_template)` used to collapse cascading failures into a single `FailureCluster`. |
| **`StackFramePruner`** | The Gear 0 filter that strips runtime internals and third-party dependency frames (`node_modules/`, `/nix/store/`, `.venv/`, stdlib) while preserving repository frames. |
| **`SignalWindow`** | A slice of repository source code read directly from disk around the top failing `file:line` frame — the failing line ± `--context-lines` lines (default 2) — with the failing line marked `>`, inlined into the `FailureCluster`. |
| **`TddPhaseGate`** | The state machine (`red`, `green`, `refactor`) that validates whether a test execution outcome satisfies the requested test-driven development phase transition. |
| **`RedGreenDelta`** | The stateful diff comparing the current test execution against the prior run's persisted state (`newly_passing`, `newly_broken_regressions`, `still_failing`). |
| **`EstimatedToken`** | The unit of every token ceiling here: `ceil(UTF-8 bytes / 4)`. It is a conservative proxy for a BPE tokenizer, not a measurement; wide characters can exceed the token intent while staying inside the byte budget. |

## 2. Purpose & System Scope

Standard test runners (`vitest`, `jest`, `pytest`, `cargo test`, `go test`, `playwright test`) and build or static-analysis tools (`tsc`, `eslint`, `ruff`, `nix build`) format their output for human terminal scrolling rather than bounded context consumption. A single test execution frequently emits ANSI escape sequences, progress spinners, thousands of lines of passing test checkmarks, verbose `console.log` debugging output, 40-frame deep `node_modules` stack traces, and 50 identical failure blocks when a single shared function throws an exception.

`dot-test-digest` SHALL operate as a drop-in, exit-code-transparent CLI wrapper (`dot-test-digest [flags] -- <command>`) that intercepts child process `stdout` and `stderr` streams and resolves them locally through a **Three-Gear Execution Hierarchy**:

1. **Gear 0 (Deterministic Grammar Parser, Stack Pruner & Deduplicator)**: Zero-token, `<15ms` local stream processing that strips ANSI/passing noise, parses structured runner outputs (`vitest`, `jest`, `pytest`, `cargo`, `go`, `tsc`), collapses cascading failures into deduplicated `FailureCluster` records, strips third-party stack frames, and inlines the 5-line `SignalWindow` from the local source file.
2. **Gear 1 (System-1 Jev Fault Classifier for Unstructured Build Logs)**: Sub-120ms discriminative log triage via the Jev API (`jev-1.13.0+`), invoked **only** when a command fails with more than 150 lines of unstructured output (such as raw `nix build`, `docker build`, C++/Rust linker dumps, or database migration crashes) that no Gear 0 grammar adapter matches.
3. **Gear 2 (Bounded Output Delivery & Raw Byte-Range Pointer)**: Emits the compact `DigestEnvelope` to `stdout` while persisting the unedited raw stream, byte for byte, to `~/.cache/dot-test-digest/logs/<run_id>.log` so callers can inspect a specific line range on demand only when deeper forensics are required. Every emitted `raw_log_lines` pointer MUST resolve to that file.

## 3. Architectural Invariants (Non-Negotiable Rules)

* **`INV-1` (Pass-State Ceiling, `compact-md`)**: When the wrapped command exits with code `0` (and satisfies the active `TddPhaseGate`), `dot-test-digest` MUST NOT write more than `160 bytes` **including the trailing newline** to `stdout` in the default `compact-md` format. All passing test names, compiler banners, deprecation warnings, and `stdout` logs MUST be suppressed. `--format=json` emits the structured envelope of §4.1 instead; it is exempt, because no conforming JSON document fits in 160 bytes (§4.1.1).
* **`INV-2` (Fail-State Ceiling & Cascade Deduplication)**: When multiple tests fail with the same `RootCauseFingerprint`, the runtime MUST collapse them into a single `FailureCluster` showing the stack trace and `SignalWindow` **at most once** (never repeated; in `compact-md` the size rule of §4.1.1 may omit them when the digest would otherwise be larger than the raw output; `--format=json` always carries them), accompanied by `affected_count` and at most 3 sample test names. In `compact-md`, total `stdout` on a failed run MUST NOT exceed `600 EstimatedTokens` (`2400 bytes`); when the budget is exhausted, or a cluster lies beyond `max_clusters`, the runtime MUST drop the lowest-ranked clusters first (rank order of §4.1.1) and append `+N more clusters (see log)` followed, while the budget allows, by one line per omitted cluster, so the omission is never silent (§4.1.1). `max_clusters` defaults to `5`.
* **`INV-3` (Strict Exit-Code Transparency)**: Except when explicitly blocking an invalid TDD phase transition under `INV-5`, `dot-test-digest` MUST exit with the exact integer exit code (`0..255`) or POSIX signal termination code (`128 + signal number`) of the underlying child process. A failure to persist the raw log or the TDD state file MUST NOT alter that code: it is reported on `stderr` and the run continues.
* **`INV-4` (Zero Third-Party Stack Pollution)**: Emitted stack traces MUST strip all frames originating from language internals or external package directories (`node:internal/*`, `node_modules/*`, `/nix/store/*`, `.venv/*`, `site-packages/*`, `/usr/lib/*`, Go/Rust stdlib) **and** all engine-only frames that name no file (`<anonymous>`, `(index N)`, `<frozen …>`), which are dropped outright and never occupy a slot. A `FailureCluster` retains at most 1 external boundary frame — the exact third-party function called by repository code, and only if it follows a repository frame — plus up to 5 repository frames, in original order: at most 6 entries.
* **`INV-5` (TDD Red-Phase Behavioral Gate)**: When invoked with `--tdd-phase=red`, the run is valid **if and only if** the child process fails (`exit_code != 0`) due to a behavioral test assertion failure or a **missing exported symbol under test** (`does not provide an export named`, `has no exported member`, `is not exported from`). If the command passes (`exit_code == 0`) OR fails due to a syntax error, broken test import path, or test-runner startup crash, `dot-test-digest` MUST emit `status: "INVALID_RED"` and exit with code `64` (`EX_USAGE`). A missing export MUST therefore be classified before the syntax tokens, even though Node reports it as a `SyntaxError`. When no grammar produced a failure block, the log itself decides: behavioral evidence in the captured text (an `AssertionError`, an `expected … to …` mismatch, a missing export, `is not a function`, `Cannot read propert`) makes the run `VALID_RED`; its absence makes it `INVALID_RED`. This keeps the gate usable for runners without a Gear 0 grammar (`--reporter=json`, junit, TAP variants).
* **`INV-6` (Strict Option Ceiling for Gear 1 Jev)**: Any unstructured log triage payload dispatched to the Jev API in Gear 1 MUST NOT exceed `255` candidate log-window options in a single `choice` question, and the serialized request MUST be budgeted to stay inside the model's 64k-token context. The option ceiling alone does not bound the request: window text is truncated and dropped by salience until it fits.

## 4. Functional Requirements & Behavioral Scenarios

### 4.1. Requirement: CLI Surface & `DigestEnvelope` Schema (`REQ-CLI-SURFACE`)

The binary SHALL accept flags preceding the `--` delimiter and pass all arguments following `--` verbatim to the spawned child process.

**Supported CLI Flags**:

| Flag | Type & Default | Description |
| :--- | :--- | :--- |
| `--tdd-phase` | `"red" \| "green" \| "refactor" \| "none"` (`"none"`) | Enforces phase transition rules (`INV-5`) and tracks `RedGreenDelta` state transitions. |
| `--format` | `"compact-md" \| "json"` (`"compact-md"`) | Output serialization format emitted to `stdout`. |
| `--max-clusters` | `integer` (`5`, max `15`) | Maximum number of distinct `FailureCluster` records in the envelope (`--format=json` carries at most this many). In `compact-md`, clusters beyond it are counted and listed, not silently dropped (§4.1.1). |
| `--context-lines` | `integer` (`2`, max `5`) | Number of source lines above and below the failing `file:line` included in `SignalWindow`. |
| `--scope-id` | `string` (auto-hashed `sha256(cwd)[0..12]`) | Scopes `state-<scope_id>.json` so concurrent runs in separate directories never collide. Explicit ids are sanitised to `[A-Za-z0-9._-]`. |
| `--no-jev` | `boolean` (`false`) | Disables Gear 1 Jev API fallback for offline execution, falling back to heuristic tail extraction. |
| `--retry-flakes` | `boolean` (`false`) | Permits one automatic re-run when Gear 1 reports the failure as transient (§4.4.3). |
| `-h`, `--help` | — | Prints usage to `stdout`; exits `0`. |
| `-v`, `--version` | — | Prints the version to `stdout`; exits `0`. |

Boolean flags also accept an explicit value (`--no-jev=false`); any value other than `true`/`false` is a usage error (`64`). Every unknown flag, missing value, out-of-range integer, or missing `--` delimiter is a usage error: diagnostic on `stderr`, exit `64`.

**`DigestEnvelope` Output Schema (`--format=json`)**:

```json
{
  "type": "object",
  "required": ["status", "exit_code", "execution_gear", "duration_ms", "summary", "raw_log_path"],
  "properties": {
    "status": {
      "type": "string",
      "enum": ["PASS", "FAIL", "VALID_RED", "INVALID_RED", "REGRESSION_DETECTED", "BUILD_ERROR"]
    },
    "tdd_phase": {
      "type": "string",
      "enum": ["red", "green", "refactor", "none"]
    },
    "exit_code": { "type": "integer" },
    "execution_gear": {
      "type": "string",
      "enum": ["GEAR_0_GRAMMAR", "GEAR_1_JEV", "GEAR_0_HEURISTIC_FALLBACK"]
    },
    "duration_ms": { "type": "integer" },
    "summary": {
      "type": "object",
      "required": ["passed", "failed", "skipped", "total_clusters"],
      "properties": {
        "passed": { "type": "integer" },
        "failed": { "type": "integer" },
        "skipped": { "type": "integer" },
        "total_clusters": { "type": "integer" }
      }
    },
    "delta": {
      "type": "object",
      "properties": {
        "newly_passing": { "type": "integer" },
        "newly_broken_regressions": { "type": "integer" },
        "still_failing": { "type": "integer" }
      }
    },
    "clusters": {
      "type": "array",
      "items": {
        "type": "object",
        "required": ["cluster_id", "fingerprint", "error_kind", "affected_count", "sample_tests", "message", "top_frame", "signal_window"],
        "properties": {
          "cluster_id": { "type": "string" },
          "fingerprint": { "type": "string" },
          "error_kind": {
            "type": "string",
            "enum": ["ASSERTION_FAILURE", "RUNTIME_EXCEPTION", "TYPE_COMPILE_ERROR", "SYNTAX_IMPORT_ERROR", "TIMEOUT_OR_CONN_REFUSED", "UNSTRUCTURED_BUILD_ERROR"]
          },
          "affected_count": { "type": "integer" },
          "sample_tests": { "type": "array", "items": { "type": "string" }, "maxItems": 3 },
          "diff": {
            "type": "object",
            "properties": {
              "expected": { "type": "string" },
              "received": { "type": "string" }
            }
          },
          "message": { "type": "string" },
          "top_frame": { "type": "string", "description": "Repository relative file:line:col" },
          "pruned_stack": { "type": "array", "items": { "type": "string" }, "maxItems": 6, "description": "At most 5 repository frames plus 1 external boundary frame (INV-4), in original order" },
          "signal_window": { "type": "string", "description": "Inlined +/-context-lines (default 2) of source code around top_frame; the failing line is marked with '>'; empty string when the file cannot be read" },
          "raw_log_lines": { "type": "string", "description": "Line range in raw_log_path (e.g., 'L412-L448')" }
        }
      }
    },
    "raw_log_path": { "type": "string" }
  }
}
```

#### 4.1.1. Output Formats & Ceiling Rules

| Format | Payload | Ceiling |
| :--- | :--- | :--- |
| `compact-md` (default) | One line on `PASS`/`VALID_RED`; one clustered body on every other status | `INV-1` (`160 bytes`) / `INV-2` (`600 EstimatedToken`) |
| `json` | The complete envelope of §4.1, pretty-printed and newline-terminated | Not byte-bounded; truncating it would break its consumer |

`INV-1` and `INV-2` bind `compact-md` only: a conforming JSON envelope cannot fit in 160 bytes, so exempting JSON is the only self-consistent reading. The raw log path is shortened to `~/…` before the pass line is measured. The status word for a satisfied green phase is `PASS` — there is no `VALID_GREEN` status.

**Cluster rank order.** `dedupeFailures` orders clusters by `affected_count` descending, then by the cluster's first raw-log line ascending (numerically, never as a string: `L5-L9` precedes `L11-L12`), then by its last raw-log line ascending, then by `cluster_id` ascending. Lower-ranked clusters are dropped first by `--max-clusters` and by `INV-2`'s budget. Before 0.1.3 the tie-break compared the `raw_log_lines` string, so `L11-…` sorted before `L5-…`; under `--max-clusters` that chose different surviving clusters in `--format=json` too (a bug fix, not a schema change).

**Omitted clusters (`compact-md`).** A cluster is *omitted* when it lies beyond `--max-clusters` or is dropped by `INV-2`'s 600-`EstimatedToken` budget. `--max-clusters` counts clusters in rank order: the first `--max-clusters` go to the envelope, the rest are passed to the formatter as omitted. At size levels 1 to 4 (below; a rendering without raw text is level 1), when at least one cluster is omitted, the body MUST end with the line `+N more clusters (see log)`, where `N` counts every omitted cluster of both kinds, followed by one line per omitted cluster in rank order: two spaces, `<cluster_id> <error_kind> x<affected_count> <top_frame> <label>`, where `<label>` is the first sample test name, or the message when there is none, with whitespace collapsed and truncated to 80 bytes (ending in `...` when cut). The budget is spent in this order. (1) Full blocks: the number of full blocks is the largest number, from the kept clusters in rank order and never fewer than one, for which the header, those blocks and the `+N more clusters (see log)` line fit; that line is reserved before the blocks are chosen, and the count is therefore the one v0.1.2 had when it printed no listing. (2) Listed lines: the lines then fill what is left, from the first omitted cluster in rank order, each line whole or not at all. (3) A cluster whose line did not fit stays counted in `N`. If the single block that is always kept is itself too large, it is cut (ending in `...`) so that the `+N more clusters (see log)` line is still the last line. One limit applies to the size decision and to the cut alike: the digest including its final newline is at most `2400` bytes (`2399` before the newline) and `600 EstimatedTokens`, so a listing that exactly fills the limit is not cut mid-line. Before 0.1.4 the block count was decided while every listed line was counted (so 30 distinct errors with `--max-clusters=5` printed 1 full block and 19 listed lines) and the size decision allowed up to `2400` bytes while the cut was at `2399`. The header's cluster count is the number of clusters rendered in full (blocks, or one-line entries at level 4). `--format=json` is unchanged: `clusters` holds at most `--max-clusters` entries and `summary.total_clusters` equals their number. Omitted clusters carry no `SignalWindow` and are never serialised.

**Stack rows.** In `compact-md`, a `pruned_stack` entry equal to the cluster's `top_frame` is not rendered as a stack row, because the cluster header row already shows it. `--format=json` keeps the entry.

**Size rule (`compact-md` failure bodies).** For every clustered body (every status except `PASS` and `VALID_RED`), the runtime MUST NOT write more than `R + H` bytes, where `R` is the UTF-8 length of every captured line (both streams, in capture order) after ANSI stripping and carriage-return collapsing, with no line dropped (the passing-noise filter is not applied) and one `\n` counted after each line, and `H` is the byte length of the header line of the candidate level including its `\n` (it can differ between levels because the cluster count it reports can differ). `INV-2`'s ceiling keeps holding as one limit: the whole output, final newline included, is at most `2400` bytes (`2399` before the newline) and `600 EstimatedTokens` (see the omitted-cluster budget above). The runtime picks the first of these five levels whose output, after `INV-2`'s budget handling, satisfies the rule with that level's own `H`:

| Level | Rendering |
| :--- | :--- |
| 1 | Full: cluster header row, message, `diff:` row, stack rows, `SignalWindow` rows, `tests:` row, `raw:` row |
| 2 | Level 1 without `SignalWindow` rows |
| 3 | Level 2 without stack rows |
| 4 | One line per cluster: `<cluster_id> <error_kind> x<affected_count> <top_frame> <raw_log_lines> <message>` (message truncated to 240 bytes) |
| 5 | The header line followed by the normalised stream verbatim (`D = H + R`; with `R = 0` the header line alone) |

The omitted-cluster footer applies, and counts toward the total, at levels 1 to 4 only. Level 5 shows every failure in the raw text, so it has neither the `+N more clusters (see log)` line nor listed lines, also when `--max-clusters` cut clusters from the envelope; its header reports the number of clusters in the envelope (at most `--max-clusters`). Level 5 is reached only when the raw text is smaller than every clustered rendering, so it serves the same goal as `INV-2`'s deduplication, omits nothing and keeps the header with its `log:` pointer; the cluster records stay complete in `--format=json`. When `R + H > 2400`, level 1 already satisfies the rule, so the ladder only engages for small raw output. The header and its `log:` pointer are present at every level, and every `raw:` range that is printed resolves to lines of that log file. `PASS` and `VALID_RED` one-liners stay governed by `INV-1` only, and the size rule MUST NOT change `--format=json` output. Without raw text (a caller that passes none) the size rule is off and the rendering is level 1.

At levels 2 to 4 a cluster is rendered without its `SignalWindow` (and at levels 3 and 4 without its stack rows), also when `affected_count > 1`: this is the amendment of `INV-2`'s "exactly once" to "at most once" stated in §3 and §7.

#### Scenario 1: Clean Green Pass (`INV-1` Enforcement)
* **GIVEN** a test suite with 240 passing tests across 32 files that emits 1,800 lines of terminal checkmarks and `console.log` output
* **WHEN** `dot-test-digest --tdd-phase=green -- vitest run` executes and all 240 tests pass
* **THEN** the runtime SHALL persist the full output to `~/.cache/dot-test-digest/logs/<run_id>.log`, exit with code `0`, and emit only a single compact line (`<= 35 tokens`) to `stdout`:
  `[PASS | GREEN] 240 passed, 0 failed (delta: +3 newly passing, 0 regressions) in 640ms | log: ~/.cache/dot-test-digest/logs/run_8f2a.log`

### 4.2. Requirement: Gear 0 Grammar Adapters, Stack Pruner & SignalWindow Inliner (`REQ-GEAR0-ENGINE`)

Before invoking any external classifier, Gear 0 SHALL strip all ANSI CSI/OSC sequences (`\x1b\[[0-9;]*[a-zA-Z]`), collapse carriage-return progress overwrites **within** a line (keeping the last segment that still has visible text, so a CRLF terminator never erases the line), and drop passing noise. Line identity is preserved 1:1 so that every `raw_log_lines` pointer stays valid. Gear 0 then parses the stream using its deterministic grammar adapters:

1. **JavaScript / TypeScript Test Runners (`vitest`, `jest`, `playwright`, `node --test`)**: Extracts `Expected` vs. `Received` diffs, assertion types, and `at <symbol> (<file>:<line>:<col>)` stack frames. TAP (`not ok N - …` with `# tests`/`# pass`/`# fail`) and Playwright's numbered `N) [browser] › …` headers are part of this grammar; `node --test` in its TAP form (YAML diagnostic blocks) and with `--test-reporter=spec` is read as specified in §4.2.3. When the child is piped — the normal case, since the wrapper always captures `stdout`/`stderr` — the compact (non-TTY) reporter forms of §4.2.1 also apply.
2. **TypeScript & Linters (`tsc`, `eslint`, `biome`)**: Parses `file(line,col): error TSXXXX: message` diagnostics and groups identical error codes occurring on the same symbol or type definition into a single `FailureCluster`.
3. **Python (`pytest`, `ruff`, `mypy`)**: Parses `E   AssertionError` diffs and `file:line: in <func>` traceback entries, stripping `.venv/` and `site-packages/` frames.
4. **Rust & Go (`cargo test`, `cargo check`, `go test`)**: Parses `thread '...' panicked at file:line:col` and `rustc` diagnostic spans (`--> file:line:col`), stripping `/rustc/` and Go runtime frames.

For every `FailureCluster` in the envelope, the `SignalWindow` Inliner SHALL read the repository file referenced in `top_frame` from disk and attach `--context-lines` lines around the target line number (default ±2, marking the exact line with `>`) to the cluster record, so `--format=json` always carries the offending source lines; `compact-md` renders the window unless the size rule of §4.1.1 omits it. Clusters omitted under §4.1.1 are rendered on one line, never show a window, and carry none.

#### 4.2.1. Piped (Non-TTY) Runner Output

When the child's `stdout`/`stderr` are pipes — the normal case for this wrapper — the JavaScript / TypeScript adapter MUST additionally recognize the compact reporter forms:

a. A file banner `❯ <file> (<n> tests | <m> failed) <duration>` is **metadata**. It MUST NOT create a `FailureCluster`, MUST NOT be recorded as a stack frame, and MUST NOT terminate the raw-line range of the failures that follow it.
b. An inline failing row `× <name> <duration>` (or `✕`/`✗`) MUST have the trailing duration removed before `<name>` is used as a test identifier. Durations are presentation, never identity.
c. A continuation row `→ <message>` MUST be stored as the failure message.
d. The `Failed Tests <n>` summary and its `FAIL <file> > <name>` rows describe failures that were already listed inline. They MUST be reconciled with the inline rows, not counted again.
e. A stack printed once for a deduplicated group of summary rows MUST be attributed to every row in that group, so each member carries the same frames for fingerprinting, pruning and `top_frame`.
f. Separators and counters (`[1/50]`, `Test Files …`, `Tests …`, `Duration …`) MUST never become frames, messages or failures.

A `Failed Suites` block (for example, a broken import) is not an inline-failure grammar; it retains the v0.1.1 grammar so that its `SYNTAX_IMPORT_ERROR` classification and failure block survive.

#### 4.2.2. Failure Reconciliation and Accounting

For a given run, after all sources in the stream have been parsed, the runtime MUST emit **at most one** failure record per canonical test identity (§4.3). Consequently:

* `affected_count` MUST count distinct tests, not parse records, and `Σ affected_count` over all deduplicated clusters MUST equal the number of distinct parsed failures — and therefore equal `summary.failed` when no cluster is dropped by `--max-clusters` or the `INV-2` budget;
* a grammar-parsed run MUST NOT report more failures than the runner's own summary (`Σ affected_count <= summary.failed` in every case);
* only actual stack-frame lines MAY enter `pruned_stack`; banners, messages, separators and counters MUST be rejected by frame validation;
* when no repository frame exists in the captured text, `top_frame` MUST be `unknown:0:0`, `signal_window` MUST be empty, and the runtime MUST report that honestly rather than invent a file or borrow the test file's name.

#### 4.2.3. `node --test` Grammar (TAP and Spec Reporters)

The JavaScript / TypeScript adapter reads node's built-in runner under both of its piped reporters. Test names are the **leaf** names (`discount 10% leaves 90%`, no suite prefix), the identity is `<file>::<leaf>` (§4.3), and counts are `failed = fail + cancelled` (node counts a timed-out test as cancelled) and `skipped = skipped + todo`. Suite rows are never failures. Reporter parity is promised for `cluster_id`, `error_kind`, `top_frame`, `message` and `sample_tests` only: the `diff` of an object value (`a: 2` under TAP, `{ a: 2 }` under spec) and the `pruned_stack` entries (an `at ` prefix under spec) may differ.

a. **Selection (TAP).** A `not ok N - <name>` entry is read as a node failure if and only if its indented YAML block (`---` … `...`) has a top-level `failureType:` key, which node writes on every failing entry. Any other block, even one with `error:`, and any `not ok` entry without a block, keeps the pre-0.1.3 grammar. A block with `failureType: 'subtestsFailed'` is a suite and produces no failure. Keys are read at the block's base indent (`|-` block scalars take the deeper lines; quoted scalars are unquoted). In a node TAP stream (one containing `# Subtest:`), `# …` comment lines never create a failure.
b. **Selection (spec).** A stream with at least two of the summary lines `ℹ tests N`, `ℹ pass N`, `ℹ fail N` is spec-reporter output (Gear 0, so a failing run is `FAIL`, not `BUILD_ERROR`). Failures come only from the `✖ failing tests:` section, one per entry (`test at <file>:<line>:<col>`, then `✖ <name> (<duration>)`, then the indented lines). Tree rows before the summary, suite rows included, create no failure when that section exists.
c. **Field mapping (both reporters).** The test file is `location:` (TAP) or `test at` (spec), made relative to the working directory. The message is the error's non-blank lines, each trimmed and joined with one space, **every remaining run of whitespace collapsed to one space**, with a ` [CODE]` tag after the error name removed (`AssertionError [ERR_ASSERTION]: …` is `AssertionError: …`); under TAP it is prefixed with the block's `name:` when the text does not already start with it; a spec message that is a single quoted string literal is unquoted. node's indented deep-equal diff lines therefore read `+ a: 1`, identically under both reporters. `diff` is `{ expected, received }` from `expected:`/`actual:`, a scalar without its surrounding quotes (`'pen'` gives `pen`). Frames are the `stack:` / `at ` lines with any `file://` URL replaced by the path it denotes. `top_frame` comes only from stack frames (`location:`/`test at` feed the identity, never `top_frame`), so a timeout keeps `unknown:0:0` and an empty `SignalWindow`. The raw-log range runs from the `not ok` / `test at` line to the entry's closing `...` / last non-blank line.
d. **Same-named failures.** When two or more failures of one test file have the same leaf name (suite rows excluded), each is named `<name> @<line>` (the 1-based line of `location:` / `test at`), for example `handles empty @4`; a leaf name unique among its file's failures is unchanged, so baselines stay stable in the common case. The suffix is applied by the adapter before deduplication, so §4.2.2 needs no change. Its limits: (1) the name becomes line-sensitive, so a collided test whose line moves between the red and green runs appears under §4.3 as a different identity (the old name as newly passing, the new one as a regression); (2) tests with the same name generated at one source line (a loop with a constant name) still share an identity and count once; (3) a spec stream cut before its failing-tests section (rule f) has no `test at` lines, so colliding names there cannot be suffixed and merge.
e. **File-level subprocess errors.** A whole test file that crashed (TAP: `error: 'test failed'` with an `exitCode:` key; spec: a `✖ <file>` entry whose message is `'test failed'`) is exactly one failure, named by its file, and takes the error line its own subprocess printed, `<Name>Error[ [CODE]]: <text>` or `Error[ [CODE]]: <text>` with the ` [CODE]` tag removed, so `Cannot find module` classifies as `SYNTAX_IMPORT_ERROR` and `does not provide an export named` as `RUNTIME_EXCEPTION` (`INV-5`), and each crashing file of a multi-file run carries its own error. **One attribution rule serves both reporters: the crash block directly above the entry.** node prints what a crashed file's subprocess wrote to stderr as one *crash block* directly above that file's own entry: a location-only line (`file:///<path>:<N>`, `node:<module>:<N>` or `/<path>:<N>`), the source line and caret when there are any, the error, its stack, and the trailer `Node.js v<version>` (measured on Node `22.23.4` for a missing module, a transitive missing module, a missing export, a syntax error, a `ReferenceError`, a `throw 42`, an `EACCES` and a CJS `require`; a file that calls `process.exit(1)` prints no block). Among the lines above the entry the adapter takes the last `Node.js v<version>` trailer line and the last location-only line before it, and the message is the first `<Name>Error[ [CODE]]: <text>` or `Error[ [CODE]]: <text>` line from that location-only line to the trailer. Nothing outside the block takes part: a setup module's `Error: config.json not found`, the log of another file or a stack frame that names another file never stands in for the file's error, whatever it contains and whether or not it names the file; a path, a position or a count of crashed files is never used to pick a line. The lines above the entry are, under TAP, the unbroken run of `# ` comment lines directly above that file's own top-level `# Subtest: <file>` line (the first line that is not a comment ends it, so a wrapper line in between cuts the block off); under the spec reporter, the lines between the previous tree row (a line starting `✔`, `✖`, `▶`, `﹣` or `ℹ`) and the file's own `✖ <file>` tree row, a row that is not directly under a `test at` line (the `✖ <name>` row under a `test at` line belongs to the failing-tests section), so a file takes the block printed directly above its own row, however many blank lines that block holds; when the same file name appears in several runs of one stream, the n-th crashed entry of that name takes the n-th such row. When there is no block, or the block has no such line (`throw 42`, `process.exit(1)`), the message stays `test failed`. A run with both a missing module and a missing export is `INVALID_RED`, because any `SYNTAX_IMPORT_ERROR` failure makes the red phase invalid. **Read failures.** A crashed file whose error is `Error: EACCES` or `Error: EPERM` and whose text contains the crashed test file's absolute path in single quotes, as in `open '/dir/file.test.js'` (node could not read the test file, so no test ran; a sibling `file.test.json` does not match) is `SYNTAX_IMPORT_ERROR` under both reporters, so `--tdd-phase=red` gives `INVALID_RED` and exit `64` (`INV-5`, runner startup crash); `ENOENT` is not in the list, because node reports a missing file before any subprocess exists. A crashed file whose own error is another runtime error (`TypeError: x is not a function` thrown at load), or a read failure of another file the test reads at load (an `EACCES` that names `secret.txt` or `cfg.test.json`, not the test file), stays `VALID_RED`/`RUNTIME_EXCEPTION`. Limit: the rule reads captured lines and assumes node relays the subprocess's stderr as one block directly above the file's own entry (node's stdout on Node `22.23.4`); verified on that version only. A layout that differs loses the block and the message stays `test failed`, which is `INVALID_RED`, the safe verdict for a startup crash.
f. **Streams cut before the failing-tests section.** A stream selected by rule (b) that has no `✖ failing tests:` line (the output was cut after the summary: a log cap, a pipe closed early) yields one failure per failing leaf tree row `✖ <name> (<duration>)` printed before the summary, with message `Unknown test failure`, no test file, no frames (`top_frame` `unknown:0:0`, `RUNTIME_EXCEPTION`), no diff, and the row's own line as its raw-log range; a `✖` row opened by an earlier `▶` row of the same name and indentation is a suite and yields none. Counts still come from the `ℹ` summary and `Σ affected_count` MUST NOT exceed `summary.failed`. A stream of tree rows with no `ℹ` summary (what node prints when the runner is stopped by a signal) is not spec-reporter output and keeps the pre-0.1.3 behavior.
g. **Parity details (0.1.4).** A TAP block with `failureType: 'testCodeFailure'` or `'hookFailed'`, a `stack:` key and no `name:` key is a plain `Error` (node prints `name:` only for `TypeError`, `AssertionError` and the like): its message is `Error: <error text>`, or `Error` when the text is empty, as under the spec reporter, so the same failure has the same message and `cluster_id` under both. A block without a `stack:` key (a thrown string or number, a failed `t.plan`) keeps its text as is, as the spec reporter prints it: `throw 42` reads `42` under both reporters. The TAP reader turns `\\` in a test name back into `\` (as it already does `\#`; other TAP escapes are not touched), and the spec reader removes the backticks of a diff value that node prints as one backtick-quoted string, as it already does single and double quotes, so a test named `back\slash`, or a failure that compares backtick strings, has the same name, baseline identity and `cluster_id` under both reporters.

Grouping remains by the shape of the error (kind, top repository frame, message template), not by its root cause.

#### Scenario 2: Cascading Failure Deduplication (`INV-2` & `INV-4` Enforcement)
* **GIVEN** a broken helper `parseToken()` in `src/auth/jwt.ts:28` causes 47 integration tests across 8 test files to throw `TypeError: token.split is not a function at parseToken (src/auth/jwt.ts:28:19)` with 35 lines of `node_modules/vitest/...` frames per test (1,900+ lines of raw output)
* **WHEN** `dot-test-digest` processes the failed stream
* **THEN** Gear 0 SHALL compute the `RootCauseFingerprint` (`SHA256("RUNTIME_EXCEPTION|src/auth/jwt.ts:28|TypeError: *.split is not a function")`), collapse all 47 failures into **1 `FailureCluster`** with `affected_count: 47`, strip all 35 `node_modules` frames per test, inline lines `26–30` of `src/auth/jwt.ts`, and emit `< 180 tokens` total to `stdout`.

### 4.3. Requirement: TDD Red-Green-Refactor Phase Gate (`REQ-TDD-GATE`)

When `--tdd-phase` is specified, `dot-test-digest` SHALL persist run state at `${DOT_TEST_DIGEST_HOME:-~/.cache/dot-test-digest}/state-<scope_id>.json`, written atomically (unique temp file, then rename) so concurrent scopes never contend, and enforce the following phase transition rules:

Baseline entries and `RedGreenDelta` MUST use a canonical identity of the form `<repo-relative test file>::<test name>`, derived from the summary-section row (which carries the file) or from the preceding file banner plus the inline row. ANSI, timing suffixes, and duplicate representations of the same test MUST be removed before comparison. `newly_passing`, `still_failing` and `newly_broken_regressions` MUST count distinct identities. A single test that appears twice in one run's text contributes one identity and one count.

| `--tdd-phase` | Child Exit Code | Error Kind Detected | Gate Verdict | Exit Code & Action |
| :--- | :--- | :--- | :--- | :--- |
| **`red`** | `0` (All Pass) | None | **`INVALID_RED`** | Exits `64`; reports: *"New test passed before implementation; expected a failing behavioral assertion."* |
| **`red`** | `!= 0` | `SYNTAX_IMPORT_ERROR` (e.g. `SyntaxError`, `Cannot find module`, `TS2307`, `Failed to load url`) | **`INVALID_RED`** | Exits `64`; reports: *"Test failed due to syntax or unresolved module import rather than a behavioral assertion."* |
| **`red`** | `!= 0` | `ASSERTION_FAILURE`, `RUNTIME_EXCEPTION`, or a missing exported symbol under test | **`VALID_RED`** | Records baseline failing test identifiers in `state-<scope_id>.json`; exits `0`. |
| **`red`** | `!= 0` | No failure block and no behavioral evidence in the log | **`INVALID_RED`** | Exits `64`; reports: *"Test run failed before any test executed (runner startup crash or no tests collected)."* |
| **`green`** | `0` (All Pass) | None | **`PASS`** | Verifies previously recorded failing test identifiers now pass; exits `0`. |
| **`green`** | `!= 0` | Any failure | **`FAIL`** | Exits with the child's exit code; `RedGreenDelta` is populated. A re-broken baseline test surfaces as `newly_broken_regressions`. |
| **`refactor`** | `0` (All Pass) | None | **`PASS`** | Exits `0`. |
| **`refactor`** | `!= 0` | Any failure | **`REGRESSION_DETECTED`** | Emits `newly_broken_regressions` diff; exits with the child process's non-zero exit code. |
| **`none`** | `0` | — | **`PASS`** | Exits `0`. |
| **`none`** | `!= 0` | A grammar adapter produced a cluster | **`FAIL`** | Exits with the child's exit code. |
| **`none`** | `!= 0` | No grammar cluster (Gear 1 or heuristic fallback) | **`BUILD_ERROR`** | Exits with the child's exit code. |

`VALID_RED` is deliberately distinct from `FAIL`: the red phase is a *successful* gate run, and collapsing the two would make the envelope ambiguous for anything reading it. `BUILD_ERROR` is the unstructured analogue — no grammar produced a cluster.

#### Scenario 3: Blocking a Broken Import During the RED Phase (`INV-5` Enforcement)
* **GIVEN** a test file `tests/discount.spec.ts` contains a typo in an import path (`import { makeCart } from './helprs'`)
* **WHEN** `dot-test-digest --tdd-phase=red -- vitest run tests/discount.spec.ts` executes and `vitest` exits with code `1` (`Error: Failed to resolve import "./helprs"`)
* **THEN** `dot-test-digest` SHALL classify `error_kind` as `SYNTAX_IMPORT_ERROR`, emit `status: "INVALID_RED"`, and exit with code `64`.

### 4.4. Requirement: Gear 1 System-1 Jev Unstructured Log Triage (`REQ-GEAR1-JEV`)

When a wrapped command exits with `exit_code != 0`, produces more than 150 lines of combined `stdout`/`stderr`, and yields zero `FailureCluster` records — **regardless of whether an adapter matched** — the runtime SHALL escalate to **Gear 1 (System-1 Jev Autopilot)**. This covers `nix build`, `docker build`, CMake/C++ linker errors, custom shell scripts, and also runners whose output a grammar matched without producing a failure block (a startup crash, an unsupported reporter). Runs of 150 lines or fewer go straight to the heuristic fallback.

1. **Candidate Window Partitioning (`INV-6`)**: The unstructured stream is partitioned into overlapping 12-line windows filtered by failure salience tokens (`error`, `fatal`, `failed`, `panic`, `undefined reference`, `permission denied`, `enoent`, `exit status`, `traceback`, `exception`). If more than 252 windows match, the runtime retains the 252 highest-salience windows plus the final 3 tail windows (`<= 255` total candidate options).
2. **Single-Pass Multi-Question Jev Request**: Dispatches a single RPC call — `POST {TYPESAFE_API_URL:-https://api.typesafe.ai}/v1/systemone`, `Authorization: Bearer $TYPESAFE_API_KEY`, body `{ "model": "jev-1.13.0", "state": …, "questions": … }` — bundling three questions. `questions` is a **map keyed by caller-chosen id**, every `type` is lowercase, and a `choice` question's `criteria` is a **map of option name → description** (at most 255 keys):
   * `root_cause_window` (`type: "choice"`, `<= 255` options): Selects the window id containing the primary root cause, ignoring downstream cascading wrapper errors such as `make: *** [all] Error 2`.
   * `error_category` (`type: "choice"`): Selects from `["COMPILE_OR_LINK_ERROR", "MISSING_DEPENDENCY_OR_PACKAGE", "ENV_OR_PORT_COLLISION", "PERMISSION_OR_SECRET_MISSING", "TRANSIENT_NETWORK_OR_TIMEOUT"]`.
   * `is_transient_flake` (`type: "noul"`): Evaluates *"Is this failure caused by a transient network timeout, port lock, or race condition that warrants one automatic retry?"* and answers with the probability that the answer is yes, in `answers.is_transient_flake.noul`. A `noul` has **no** `confidence` field.

   `state` MUST be bounded: the command line, the exit code, the total line count, and at most the last 40 lines. Candidate window text travels in `criteria`, and the serialized request MUST be budgeted to fit the 64k-token context (INV-6).
3. **Probability Gate & Auto-Retry**: If `answers.is_transient_flake.noul >= 0.80` (`FLAKE_PROBABILITY_THRESHOLD`) and `--retry-flakes` is enabled, `dot-test-digest` re-runs the command **at most once** before reporting. Otherwise it wraps the selected window plus ±10 surrounding log lines into a `FailureCluster` (`execution_gear: "GEAR_1_JEV"`, `error_kind: "UNSTRUCTURED_BUILD_ERROR"`, repository-relative `top_frame`, raw log line pointer). If the key is missing, `--no-jev` is set, the call fails, or it times out, the runtime MUST fall back to the most salient window and report `execution_gear: "GEAR_0_HEURISTIC_FALLBACK"`.

#### Scenario 4: Pinpointing Root Cause in a 3,000-Line Unstructured Build Log
* **GIVEN** `dot-test-digest -- cargo build` fails after emitting 3,200 lines of compiler and native linker output where the root error (`ld: library not found for -lpq` on line 2,840) is followed by 360 lines of cascading build-script abort messages
* **WHEN** Gear 0 finds no test-runner grammar match and passes 84 candidate error windows to Gear 1 (Jev)
* **THEN** Jev selects window `w_61` (`lines 2835–2847`) with `error_category = "MISSING_DEPENDENCY_OR_PACKAGE"`, and `dot-test-digest` emits only that window and its raw log line pointer (`L2835-L2847`) to `stdout`, after exactly one RPC call. The `< 150ms` figure in CT-4 is a property of the Jev service, not of this binary; the compliance test asserts the single round trip and the `<= 255` option count, which are what this repository controls.

## 5. Repository & Module Layout (`SPEC-LAYOUT`)

To keep the codebase modular and self-contained, the implementation SHALL follow this directory layout:

| File Path | Module Responsibility |
| :--- | :--- |
| `package.json` | Package manifest (`dot-test-digest`) with minimal runtime dependencies (`zod` and native `node:child_process`). |
| `tsconfig.json` | Strict TypeScript `5.x` compiler configuration targeting Node.js `>= 20.x`. |
| `specs/SPEC-002-DOT-TEST-DIGEST.md` | Architecture and behavioral contract specification. |
| `src/index.ts` | CLI entrypoint parsing flags, spawning child processes with pipe capture, and returning transparent exit codes (`INV-3`). |
| `src/pruner/ansi-stripper.ts` | Streaming stripper for ANSI CSI/OSC sequences, spinner carriage-returns, and passing test noise (`INV-1`). |
| `src/pruner/stack-pruner.ts` | Strips `node_modules`, `/nix/store`, `.venv`, and stdlib frames (`INV-4`) and reads ±2-line `SignalWindow` snippets from disk. |
| `src/pruner/cluster-dedup.ts` | Computes `RootCauseFingerprint` hashes, collapses cascading failures into `FailureCluster` records, ranks them (§4.1.1), and reads `SignalWindow`s for the clusters that reach the envelope (`INV-2`). |
| `src/pruner/failure-identity.ts` | Canonical test identity (normalisation, `file::name` keys, deduplication) shared by the adapters, the pruner and the TDD gate (§4.2.2, §4.3). |
| `src/adapters/js-test.ts` | The JavaScript / TypeScript grammar: vitest/jest compact and summary forms, TAP, Playwright; it also selects the `node --test` grammar (§4.2.1). |
| `src/adapters/node-test.ts` | The `node --test` grammar under the TAP and spec reporters: failure entries, counts, file-level subprocess errors, same-name labels (§4.2.3). |
| `src/adapters/node-crash-block.ts` | The crash-block rule of §4.2.3 (`crashBlockError`) and the read-failure predicate for a crashed file. |
| `src/adapters/index.ts` | Gear 0 deterministic grammar parsers for `vitest`/`jest`, `tsc`/`eslint`, `pytest`/`ruff`, and `cargo`/`go test`. |
| `src/gears/gear1-jev.ts` | Unstructured log window chunker (`<= 255` options, budgeted request `INV-6`), multi-question assembly, and transient flake retry trigger. |
| `src/state/tdd-gate.ts` | Manages `${DOT_TEST_DIGEST_HOME:-~/.cache/dot-test-digest}/state-<scope_id>.json`, enforces `INV-5` (`VALID_RED` vs `INVALID_RED`), and computes `RedGreenDelta`. |
| `src/formatters/envelope.ts` | Serializes `DigestEnvelope` into compact Markdown (`--format=compact-md`, including the size rule and omitted-cluster listing of §4.1.1) or JSON (`--format=json`). |
| `src/types/schema.ts` | Zod schemas for CLI flags, `DigestEnvelope`, `FailureCluster`, and Jev API payloads. |
| `tests/pruner.spec.ts` | Unit tests verifying ANSI stripping, stack frame pruning (`INV-4`), and `SignalWindow` source extraction. |
| `tests/dedup-and-tdd.spec.ts` | Behavioral tests verifying 50-to-1 cascade deduplication (`INV-2`) and `--tdd-phase=red` validation (`INV-5`). |
| `tests/gear1-jev.spec.ts` | Tests verifying `<= 255` candidate window partitioning (`INV-6`) and Jev unstructured build log classification. |
| `src/cli/args.ts` | Flag parsing, `USAGE`, and `UsageError` (`64`). |
| `src/adapters/common.ts` | Shared adapter types, `error_kind` classification, and count parsing. |
| `src/runner/capture.ts` | Child spawn, line-numbered tee, exit/signal mapping (`INV-3`). |
| `src/runner/raw-log.ts` | Run id, cache root (`DOT_TEST_DIGEST_HOME`), line-range formatting. |
| `src/gears/windows.ts` | 12-line window partitioner and `<= 255` selection (`INV-6`). |
| `src/gears/jev-client.ts` | Jev 1.13 HTTP client (`POST /v1/systemone`). |
| `tests/cli.spec.ts` | Exit-code transparency (`INV-3`), usage errors, and the pass-state ceiling. |
| `tests/adapters.spec.ts` | Grammar coverage across all four adapter families. |
| `tests/fixtures/**` | Generated logs and the fixture project used by CT-1…CT-3; `node-cart/`, `tsc-small/` and the recorded logs under `logs/` used by CT-7…CT-9. |
| `tests/helpers/node-cart.ts` | Shared CLI helper: copies `node-cart` to a temp directory and runs `main` against `node --test`. |
| `tests/node-test.spec.ts` | `node --test` grammar under both reporters and the red-phase guards (§4.2.3, `INV-5`). |
| `tests/size-and-omission.spec.ts` | Size rule, omitted-cluster listing and source-order ranking through the CLI (§4.1.1). |
| `vitest.config.ts`, `.env.example`, `README.md` | Test config, environment template, operator docs. |

The table is the minimum contract: every listed path MUST exist with its stated responsibility. Additive modules are permitted, provided none of the rows above loses its responsibility to them.

## 6. Acceptance Criteria & Definition of Done (`v0.1.4`)

* **Compliance Test 1 (`CT-1`: Pass-State Compression)**: Wrapping a passing test suite that emits `2,500 lines` (`~18,000 tokens`) of standard `vitest` + `console.log` output MUST emit `<= 160 bytes` **including the trailing newline** to `stdout` in `compact-md` (`>= 99.8%` token reduction) while preserving the full `2,500 lines` in `~/.cache/dot-test-digest/logs/<run_id>.log`.
* **Compliance Test 2 (`CT-2`: 50-to-1 Cascade Deduplication & Stack Pruning, end-to-end)**: Generate a fixture in which 50 tests across 10 files fail because a shared **repository** helper performs the failing operation (so the throw site is a repository frame and the printed stack may also contain external frames). Run the built binary as `dot-test-digest -- vitest run` with `stdout` piped (non-TTY). The emitted `compact-md` output MUST contain exactly `1` `FailureCluster` with `affected_count: 50`, **no** internal or third-party frames other than at most one external boundary frame (as permitted by `INV-4`), and an inlined 5-line `SignalWindow` from the helper file. Total `stdout` MUST be `<= 220 EstimatedToken`; the universal ceiling remains `INV-2`'s 600. The JSON envelope MUST report `summary.failed: 50`, `total_clusters: 1`, and `Σ affected_count = 50`. V8 prints at most 10 frames by default, so the fixture MUST place the throwing repository frame inside that window; a stack containing only `node_modules` frames does not require a `SignalWindow`, and §4.2.2's honesty rule applies instead.
* **Compliance Test 3 (`CT-3`: TDD Invalid-Red Gate Enforcement)**: Running `dot-test-digest --tdd-phase=red` against (a) a passing test file and (b) a test file containing an unresolved `import` or `SyntaxError` MUST in both cases emit `status: "INVALID_RED"` and exit with code `64`; running it against a test file that fails on `expect(actual).toBe(expected)` MUST emit `status: "VALID_RED"` and exit with code `0`.
* **Compliance Test 4 (`CT-4`: Gear 1 Jev Unstructured Build Pinpointing)**: Feeding a `3,000-line` unstructured linker failure fixture (where the actual linker error occurs 400 lines above the end of the log) with Jev (`jev-1.13.0+`) MUST send `<= 255` candidate windows in **exactly one** RPC call to `/v1/systemone` and return a `FailureCluster` containing the exact linker error window. Service latency (`< 150ms`) is a property of Jev, not of this binary, and is not asserted here.
* **Compliance Test 5 (`CT-5`: Concurrent Scope Isolation)**: Running two concurrent `dot-test-digest` processes with `--scope-id=s01` and `--scope-id=s02` (with `DOT_TEST_DIGEST_HOME` pointing at a temp directory) MUST write isolated state files (`state-s01.json`, `state-s02.json`), leave no `.tmp` residue, and show zero file lock contention or cross-run `RedGreenDelta` contamination.
* **Compliance Test 6 (`CT-6`: Exit-Code Transparency, `INV-3`)**: Wrapping a child that exits `42`, a child killed by `SIGTERM`, a command that does not exist, and an unknown flag MUST yield `42`, `143`, `127` and `64` respectively, with the digest on `stdout` and diagnostics on `stderr`.
* **Compliance Test 7 (`CT-7`: `node --test` Failures Stay Distinct)**: Running `dot-test-digest --no-jev --format=json -- node --test cart.test.js` in a copy of `tests/fixtures/node-cart/` MUST report `summary` `{ passed: 2, failed: 4, skipped: 0, total_clusters: 4 }` with four clusters (`c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a`), none at `unknown:0:0`; `--test-reporter=spec` MUST list the same ids with equal `error_kind`, `top_frame`, `message` and `sample_tests`. Two failing tests that share a leaf name in one file MUST remain two failures (`handles empty @4`, `handles empty @7`), each crashing file of a multi-file run MUST carry its own subprocess error, and the red-phase verdicts of `INV-5` MUST be unchanged.
* **Compliance Test 8 (`CT-8`: Bounded-vs-Raw Size)**: Wrapping the `tests/fixtures/tsc-small/` diagnostics (5 lines, 419 bytes, exit `2`) MUST emit the header line followed by exactly those 419 bytes in `compact-md` (level 5), with `--format=json` unchanged; `formatEnvelope` with raw text MUST pick each of the five levels at its byte threshold, and large raw output (`CT-2`) MUST keep the full form within `INV-2`'s 600 `EstimatedToken`.
* **Compliance Test 9 (`CT-9`: Omitted Clusters Are Visible)**: With `--max-clusters=2` on the `node-cart` run, `compact-md` MUST end with `+2 more clusters (see log)` and one listed line each for `c_fdff652c` and `c_53a8182a` while `--format=json` stays capped at two clusters; clusters with equal `affected_count` MUST be ranked by numeric raw-log line (`L5-L9` before `L11-L12`).

## 7. Revision History

| Version | Date | Change |
| :--- | :--- | :--- |
| `0.1.4` | 2026-11-10 | Applies `openspec/changes/harden-node-digest-cases/`, a hardening revision made after hand-driven runs of the 0.1.3 build (Node `22.23.4`, `--no-jev`) found cases the 0.1.3 text allowed or did not cover. §4.1.1: the omitted-cluster budget is spent in a fixed order (full blocks with the `+N more clusters (see log)` line reserved, then whole listed lines, unlisted clusters stay counted in `N`), which restores v0.1.2's block count (30 distinct errors with `--max-clusters=5` printed 1 full block and 19 listed lines under 0.1.3, 5 full blocks and 13 listed lines now), and there is one limit, `2400` bytes including the final newline (`2399` before it) and `600 EstimatedToken`, for the size decision and the cut. §4.2.3: one attribution rule for a crashed file under both reporters, the crash block directly above its own entry (the first error line from the last location-only line to the last `Node.js v<version>` trailer; a setup log, another file's output or a stack frame that names another file never takes part, a file with no block or a non-error throw keeps `test failed`; under the spec reporter the lines between the previous tree row and the file's own `✖` row, the n-th crashed entry of a name taking the n-th such row); an `EACCES` or `EPERM` read failure that contains the test file's absolute path in single quotes is `SYNTAX_IMPORT_ERROR` (`INVALID_RED`, exit `64`); a nameless TAP `testCodeFailure` or `hookFailed` error with a stack reads `Error: <text>`; `\\` in a TAP test name and backtick diffs under the spec reporter are unescaped. No ceiling is raised, `INV-3`'s exit codes are unchanged, `INV-5`'s verdicts move only toward what `INV-5` already says, and `--format=json` is unchanged. Limit: the spec-reporter position rule and the read-failure and attribution examples were measured on Node `22.23.4` only. |
| `0.1.3` | 2026-11-01 | Applies `openspec/changes/sharpen-weak-digest-cases/`, an additive revision made after measuring four weak cases (`node --test` under the TAP and spec reporters, a `tsc` digest larger than its raw output, `--max-clusters` dropping failures silently). Adds §4.2.3 (the `node --test` TAP and spec grammar: `failureType:` selection, message whitespace collapse, the ` @<line>` same-name suffix and its limits, file-level subprocess errors, streams cut before the failing-tests section); adds to §4.1.1 the five-level size rule (footer at levels 1 to 4 only), the cluster rank order with its numeric tie-break, and `INV-2`'s omitted-cluster listing and `--max-clusters` counting; adds `CT-7`…`CT-9` and the layout rows. No ceiling is raised (`INV-1`'s 160 bytes, `INV-2`'s 600 `EstimatedToken` / 2,400 bytes), `INV-3`'s exit codes and `INV-5`'s gate verdicts are unchanged, and `INV-2`'s "exactly once" (and the §4.2 inliner sentence) is amended to "at most once" for `compact-md`. |
| `0.1.2` | 2026-10-31 | Applies `specs/DELTA-SPEC-002-0.1.2.md` after the first acceptance run (`17 PASS / 0 FAIL / 1 SKIP`). Adds §4.2.1 (piped non-TTY runner grammar) and §4.2.2 (one failure per canonical identity, frame validation, honest `unknown:0:0`); adds canonical `file::name` identity to §4.3 so duplicate reporter sections cannot inflate `RedGreenDelta`; rewrites `CT-2` as an end-to-end piped CLI test whose repository throw site is inside V8's 10-frame window and aligns its `node_modules` wording with `INV-4`'s single boundary frame. No invariant or ceiling is relaxed. |
| `0.1.1` | 2026-10-30 | Applies the integrity review (`specs/INTEGRITY-SPEC-002.md`). `VALID_RED` added to the status enum and `VALID_GREEN` corrected to `PASS`; `--retry-flakes`, `--help`, `--version` documented; `pruned_stack` widened to 6 and engine frames excluded; the Jev wire contract corrected to `POST /v1/systemone` with lowercase types, a question map and a `criteria` map; `noul` probability replaces `confidence`; escalation widened to `clusters.length == 0` regardless of adapter match; the green failure row, `BUILD_ERROR` assignment and all `none` rows added; the red gate gains the missing-export rule and the behavioral-evidence rule; truncation policy and the `compact-md`-only scope of `INV-1`/`INV-2` stated; `state` bounded; `CT-6` added; editorial fixes (`±` notation, `Date`/`Depends on` header, layout rows completed). |
| `0.1.0` | 2026-10-30 | Initial draft. |
