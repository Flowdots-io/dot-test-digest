---
verdict: approve
reviewer_model: "opus"
author_model: "opus"
reviewer_run: "review-20261101T1600-p9wt"
author_run: "spec-20261101T1450-rev1"
spec_hash: "441a147fe9cd561c278331e691aafb67c8b77d3efa16d3dfeb85ae1048067469"
reviewed_at: "2026-11-01T14:11:13Z"
round: 3
---

## Intent

Fix the weak cases that the README's own measurements expose, so the digest is never worse than the raw output it replaces, then implement through dotstack's procedure. The cases are `node --test` failures merged into one cluster or not recognised at all, a `tsc` digest larger than the raw output, and clusters past the first few that are only counted or silently dropped.

## Reasons

1. **Mechanical gate.** `openspec validate sharpen-weak-digest-cases --strict` exits 0.
2. **Ticket intent.** Each weak case in the README's "Example" and "Where it works well" sections maps to a capability:
   - node TAP merged into one cluster: `node-tap-diagnostics`;
   - spec reporter not recognised: `node-spec-reporter`;
   - tsc digest larger than raw: `bounded-vs-raw-size`;
   - only 3 clusters shown: `omitted-cluster-visibility`;
   - weak node red-phase labels: covered by the node capabilities.

   Task 3.2 re-measures the README. Root-cause grouping and the untested grammars are named non-goals. I found no scope creep.
3. **Testability.** All 51 scenarios have concrete triggers and exact observable values at the four seams named in design.md (the CLI, `formatEnvelope`, `dedupeFailures`, `runGear0`). None could pass with a stub.
4. **Round 2 reason (fixtures only in `/tmp`) is resolved.** I rebuilt the fixtures in `/tmp/rv3/fx` from the text quoted in design.md "Fixtures" alone:
   - **Byte counts.** All 7 quoted files have the stated sizes: 355, 636, 18, 133, 162, 104 and 419 B.
   - **tsc.** Real `tsc` 5.9.3 on the quoted `src/a.ts`, `src/b.ts` and `tsconfig.json` reproduces `tsc.log` byte for byte, with exit 2.
   - **node.** `node --test` on Node 22.23.4 of the quoted cart project gives:
     - TAP `not ok` to `...` ranges of 15-39, 41-65, 67-91 and 93-111;
     - spec `test at` ranges of 18-37, 39-58, 60-79 and 81-91;
     - counts of 6, 2 and 4;
     - the stack columns 7:46, 8:41, 9:50 and cart.js:5:42.

     The total byte counts differ (3,611 and 3,347 B here). The design marks those as descriptive, so that is expected.
   - **Spec-quoted fixtures.** The spec-quoted node fixtures (`suite`, `same-name`, `string-diff`, `missing-module`, `missing-export`, `passing`) reproduce the asserted shapes:
     - `failureType` keys, including `subtestsFailed` and `testTimeoutFailure`;
     - fail 2 + cancelled 1 for the suite test;
     - `location` lines 4 and 7, with stack columns 4:36 and 7:36;
     - `expected: 'pen'`;
     - the deep-equal text;
     - the two-file subprocess blocks on stdout, with stderr empty, under both reporters, matching the position rule and the path rule.
5. **Values recomputed.**
   - **Cluster ids.** `computeFingerprint` from dist gives every asserted id: `c_9721831d`, `c_6edce10a`, `c_fdff652c`, `c_53a8182a`, `c_11eac407`, `c_42febbe1`, `c_20e326b9` and `c_0044f190`.
   - **tsc JSON on v0.1.2.** It gives `c_42a23d40` with `L1-L1` and `c_39d5c117` with `L2-L2`, and a 1,533 B digest.
   - **Level-4 bodies.** 589 B with `--max-clusters=2` and 574 B for all 5 clusters, so both runs land on level 5.
   - **Ladder thresholds.** H = 73, and the levels render 604, 283, 253, 168 and 133 B, which matches the scenario.
   - **Footer scenarios.** The footer scenario is exactly 630 B. In the 14-omitted scenario, exactly 12 listed lines fit (2,356 B, 589 tokens). In the budget scenario, 3 blocks plus the listing take 557 tokens and 4 blocks take 707.
   - **v0.1.2 baselines.** The tie order is `L1,L10,L11,L12,L2`. `boom` is printed twice, and empty output gives 1 cluster.
6. **Coverage.** The sad paths are specified:
   - empty output and a one-line output;
   - a cut spec stream and a rows-only stream;
   - a non-node TAP block;
   - suite rows, timeouts and same-name collisions;
   - one or two crashing files under each reporter;
   - large raw output (CT-2);
   - a missing raw text;
   - an over-long listing.
7. **Consistency.** I found no contradiction between the requirements, the design and SPEC-002. The INV-2 "exactly once" to "at most once" amendment is stated in four places and owned by task 3.3. Defaults chosen records every product call I found.
8. **Principles.** `spec-is-the-contract` holds. Three repo principles were checked against the work:
   - `exit-code-transparency`: passthrough scenarios under both reporters, and the tsc and empty-output runs keep exit codes 2 and 3.
   - `pass-state-ceiling`: one-line PASS and VALID_RED scenarios with a 160 B limit; the size rule excludes PASS and VALID_RED.
   - `invalid-red-exits-64`: missing-module, already-passing and two-file red runs exit 64 under both reporters.
9. **Blast radius.** I grepped `formatEnvelope`, `renderFailBody`, `dedupeFailures`, `more clusters`, `localeCompare`, `ℹ` and `✖` across `src`, `tests` and `scripts`:
   - The only production caller is `src/index.ts`.
   - The `tests/envelope.spec.ts` cases pass no context, so they render at level 1.
   - The CT-3 broken-import run measured 399 B of digest against 770 B of raw output, so it stays at level 1 and keeps `SYNTAX_IMPORT_ERROR`.
   - The `tests/cli.spec.ts` red test asserts only `INVALID_RED` and stderr.
   - The `dedupeFailures` signature is kept.
10. **Tasks.** The graph is well formed:
    - every task has a `blocked-by` line and every referenced id exists;
    - there are no cycles, and the roots are 1.1 and 2.1;
    - all 51 scenarios are owned exactly once (checked by diff);
    - tasks that share a file are serialised within their lane, and 3.1 depends on 2.3 because both write `tests/size-and-omission.spec.ts`.
11. **Principle proof.** Not applicable: no file under `.dotstack/principles/` and no check is added or edited.

## Notes

- **Stale provenance wording.** One clause of the round 2 fix list is still undone. `specs/node-tap-diagnostics/spec.md` (requirement "One failure per failing node test...", last paragraph) still says the fixture is "copied byte for byte from the README measurement project (`/tmp/dtd-work/nodetest/`)". The proposal and design correctly say these projects are smaller than the README's. Tasks 1.1 ("from `raw-default.txt` / `raw-spec.txt`") and 2.3 ("copied from `/tmp/dtd-work/tscproj/`") also still point at `/tmp`.

  This is non-blocking: design.md declares the quoted bytes authoritative, and I confirmed the `/tmp` files are byte-identical to the quoted text, so no test outcome depends on which source is used. Still, the next spec edit should replace that sentence with "with the exact contents quoted in `design.md` 'Fixtures'". The two task lines should say to regenerate with the commands in design.md.
- **Truncated-log GIVEN.** It quotes "348 bytes" and specific row durations. Both depend on the recorded log, not on the contract, so a regenerated log will differ (I got 352 B). Tests should assert the 14 lines and the row names, not the byte count.
- **Level 5 in compact-md for tiny INVALID_RED runs.** A very small INVALID_RED raw output could reach level 5, which shows the header and the raw text but not the `SYNTAX_IMPORT_ERROR` label. INV-5 requires only the status, the exit code and the stderr diagnosis, which stay. No scenario covers this. It could go in SPEC-002 0.1.3 as a known trade-off.
- **Design formatting.** design.md line 122 has stray backticks around the `tsc.log` heading. This is cosmetic, but it makes the heading harder to extract mechanically.
