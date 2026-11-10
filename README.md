# dot-test-digest

Bounded output compressor for test runs, compilers and build tools.
Implements [`specs/SPEC-002-DOT-TEST-DIGEST.md`](specs/SPEC-002-DOT-TEST-DIGEST.md).

```bash
dot-test-digest --tdd-phase=green -- vitest run
dot-test-digest --format=json -- cargo build
dot-test-digest --no-jev -- tsc --noEmit
```

- **Pass:** one line, at most 160 bytes (`[PASS | GREEN] 240 passed, 0 failed (delta: +3 newly passing, 0 regressions) in 640ms | log: …`).
- **Fail:** deduplicated failure clusters with a pruned stack and an inlined source window, at most 600 tokens.
- **Always:** the child's exit code (or `128 + signal`) is returned unchanged, and the full raw stream is kept in `~/.cache/dot-test-digest/logs/<run_id>.log`.

Gear 1 (Jev `jev-1.13.0`) is used only for unstructured failures above 150 lines and needs `TYPESAFE_API_KEY`.
Without it, the heuristic fallback still narrows the log.

**Privacy.** Gear 1 is the only part of the tool that uses the network. When `TYPESAFE_API_KEY` is set and `--no-jev`
is not passed, it sends excerpts of the failing run's log (the failure windows and the tail, bounded in size) to
`api.typesafe.ai`. Pass `--no-jev` to keep every run local. Without a key, nothing leaves your machine.

TDD state lives in `~/.cache/dot-test-digest/state-<scope_id>.json`; `--scope-id` isolates concurrent runs.
`DOT_TEST_DIGEST_HOME` relocates both caches.

## Example

The same small project run without and with the digest: a cart module with two bugs (`discount` returns the discount instead of the amount left, and `first` crashes on an empty cart) and 29 vitest tests, 5 of them failing. The project is in [`tests/fixtures/vitest-cart/`](tests/fixtures/vitest-cart). It is a recreation: the project I measured the first version of this example with was not kept, so the numbers below come from this one and are not comparable with the earlier ones. Measured on 2026-11-01 with dot-test-digest 0.1.0 (built from this tree), Node 22.23.4, vitest 2.1.9, `--no-jev`, in a fresh temporary copy of the fixture. The log path in the pasted digest is shortened to `~/.cache/...`; the byte count is of the real output, with a longer path.

```bash
vitest run                                  # raw
dot-test-digest --no-jev -- vitest run      # through the digest
```

**Raw:** 110 lines, 4,292 bytes, exit code `1` (excerpt)

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

**Digest:** 34 lines, 2,128 bytes, same exit code (`1`)

```text
[FAIL] 5 failed, 24 passed in 1326ms | 3 clusters | log: ~/.cache/dot-test-digest/logs/run_mvyffv735538e5b4.log
c_992bb564 ASSERTION_FAILURE x1 tests/cart.test.ts:7:66
  AssertionError: expected 100 to be 900 // Object.is equality
  diff: expected 900 / received 100
  5 |   it("subtotal adds up", () => expect(subtotal(items)).toBe(1500));
  6 |   it("tax is 21%", () => expect(tax(1000)).toBe(210));
  7 >   it("discount 10% leaves 90%", () => expect(discount(1000, 10)).toBe(900));
  8 |   it("discount 50% leaves half", () => expect(discount(2000, 50)).toBe(1000));
  9 |   it("total without discount", () => expect(total(items)).toBe(1815));
  tests: cart > discount 10% leaves 90%
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

Fair reading of this example: vitest already prints a one-line summary of every failure at the top, so the raw output is not hard to scan here. The digest drops the repeated per-failure detail and adds a source window around each failing line. It prints full detail for **3 of the 5 failures** (the `--max-clusters` default is 5, but the output is also capped at about 600 tokens); the other two are listed one per line after `+2 more clusters`, with their id, kind, location and test name, but no message, diff or window. The one that is not an assertion (the `TypeError` from `first`) is one of the two that only get a line. The full output is always in the log the header names.

A passing run is one line: for the same project with both bugs fixed, `[PASS] 29 passed, 0 failed in 1306ms | log: …` was 86 bytes against 249 bytes raw (10 lines).

## Where it works well, and where it does not

These are measurements from small hand-made projects, not a benchmark. Sizes are raw output against digest output; the digest bytes include the header line with its log path (a `/tmp/...` path here; the default `~/.cache/...` path is a little longer).

| Case | Raw | Digest | Verdict |
| --- | --- | --- | --- |
| vitest (non-TTY), 5 of 29 failing | 110 lines, 4,292 B | 34 lines, 2,128 B | **Good.** Distinct failures become clusters with file, line, diff and a source window. Full detail for the first 3; the others are listed one per line. |
| vitest, all passing | 10 lines, 249 B | 1 line, 86 B | **Good.** |
| `node --test` (default or `--test-reporter=tap`), 4 of 6 failing | 120 lines, 3,593 B (default); 3,591 B (tap) | 38 lines, 2,258 B (both) | **Good now.** The four failures are four clusters (three with file, line, diff and source window, the fourth listed in one line), not one merged cluster. |
| `node --test --test-reporter=spec`, 4 of 6 failing | 91 lines, 3,336 B | 38 lines, 2,258 B | **Good now.** Parsed, with the same clusters as the tap reporter; no longer reported as `BUILD_ERROR`. |
| `tsc --noEmit`, 5 errors in 2 files | 5 lines, 419 B | 6 lines, 517 B | **Not smaller.** The digest is the header line (98 B) plus the 5 raw lines unchanged: the size rule falls back to the raw text when a digest would be larger. So it costs the header and saves nothing. |

Differences from the first version of this table, so the numbers are not read as a like-for-like comparison: the `node --test` project here has 6 tests (not 26) and the `tsc` project has 5 errors (not 6), because these are the fixtures kept in `tests/fixtures/` (`node-cart`, `tsc-small`). The same-bug-in-each claim from before no longer holds; each project has its own failures.

**The TDD gate (`--tdd-phase=red`) is the most reliable part.** In every case I ran it gave the right verdict, and the exit code was `0` for `VALID_RED` and `64` for `INVALID_RED`:

| Red phase run | Status | Exit code |
| --- | --- | --- |
| vitest, an assertion fails | `VALID_RED` | `0` |
| `node --test` (default, tap or spec reporter), an assertion fails | `VALID_RED` | `0` (each of the three) |
| vitest, import of a missing module | `INVALID_RED` (`SYNTAX_IMPORT_ERROR`) | `64` |
| `node --test` (default, tap or spec reporter), import of a missing module | `INVALID_RED` (`SYNTAX_IMPORT_ERROR`) | `64` (each of the three) |
| `node --test` (default or spec reporter), a test file that exits at load time (`process.exit(1)`, no error printed) | `INVALID_RED` (`SYNTAX_IMPORT_ERROR`) | `64` (each of the two) |
| `node --test`, the test already passes | `INVALID_RED` | `64` |
| `node --test` (default, tap or spec reporter), import of an export that does not exist | `VALID_RED` | `0` (each of the three) |

The `node --test` labels are now the right ones for what I checked: with `--format=json`, an assertion failure under the spec reporter is `ASSERTION_FAILURE` (the failing `first()` call is `RUNTIME_EXCEPTION`), a missing module is `SYNTAX_IMPORT_ERROR`, and a missing export is `RUNTIME_EXCEPTION` (`The requested module './cart.js' does not provide an export named 'applyCoupon'`), which is why it counts as a valid red. I checked the JSON labels only for the spec reporter and not for default or tap, except for the file that exits at load time, which I checked with both the default and the spec reporter.

**Things to know before relying on it**

- Clusters are grouped by the shape of the error, not by root cause. One bug that produces different assertion messages makes several clusters (in the vitest example, the one bug in `discount` makes four assertion clusters, each with different expected and received values).
- Only the first 3 clusters of the vitest run above were printed in full. The output is capped at about 600 tokens, so a run with more failures than fit shows the rest as `+N more clusters (see log)`.
- The clusters that do not fit are no longer only counted: each one is listed on its own line with its id, kind, location and test name. When the digest would be larger than the raw output (the `tsc` row), the footer is not printed because the raw text already shows every failure.
- Size rule: the digest is never larger than the raw output plus its header line. By design it degrades in steps (no source windows, then no stack frames, then one line per cluster, and in the end the header plus the raw text). I observed only two outcomes: the full form (every other case here) and the last step (the `tsc` case); I did not construct runs that land on the middle steps. The cap on the full-detail form (600 tokens, 2,400 bytes) is unchanged.
- **Known limitation: with many omitted clusters the digest shows fewer full blocks than v0.1.2 did.** The size rule counts every listed line of the omitted-cluster footer while it decides how many full blocks to keep, so once roughly 20 or more clusters are omitted it drops to one full block and spends the space on the list. Measured from throwaway builds on a project with 30 distinct `tsc` errors, `--max-clusters=5` (default), `--no-jev`: v0.1.2 prints 5 full blocks (1,025 bytes, with no mention of the 25 others); this version prints the header `| 1 cluster |`, 1 full block, `+29 more clusters (see log)` and 19 listed lines (2,365 bytes, under the 2,400-byte ceiling). Byte counts move a few bytes with the length of the log path. `--format=json` still carries 5 clusters. This follows the approved spec, which drops full blocks first and listed lines second; I consider it a spec defect (keeping v0.1.2's block count first and filling the rest with listed lines would be better) and did not change it here, because that needs a spec amendment and a new review.
- Two failing tests with the same name in one file are kept as two failures, and the test name carries the line it was declared on: `handles empty @4` and `handles empty @7` in a `node --test` run (default, tap and spec reporters all printed it). The suffix is added only when a name is shared by two or more failures of the same file, and it uses the line of the test, so the same name in different files stays plain. I only checked this with `node --test`.
- The child process's exit code is passed through unchanged (observed in every run above).
- Grammars for pytest, `cargo test`, `go test`, jest, mocha, Playwright and eslint exist and are covered by fixtures in this repo's tests, but **I did not run them against real projects**. Treat them as untested in practice.
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

For the red-phase table's vitest missing-module case, a one-test project imported `../src/nope`, which does not exist. The all-passing vitest row is the cart fixture with the two bugs fixed.

## Install

Needs Node >= 20 and [pnpm](https://pnpm.io). Clone, build, and put the `dot-test-digest` bin on your `PATH`:

```bash
git clone https://github.com/OctavioSardi/dot-test-digest && cd dot-test-digest
pnpm install && pnpm build && pnpm link --global
dot-test-digest --version
```

If `dot-test-digest` is not found afterwards, run `pnpm setup` and restart your shell: it puts pnpm's global bin directory on your `PATH`.

## Develop

```bash
pnpm install
pnpm verify     # typecheck + unit tests
pnpm build      # emits dist/ with the dot-test-digest bin
```

## License

[MIT](LICENSE) © 2026 Octavio Sardi and Flowdots.
