---
id: pass-state-ceiling
title: "A passing run writes at most 160 bytes to stdout in compact-md"
severity: guide
author: founder
applies-to: "src/**"
# enforced-by: .dotstack/checks/pass-state-ceiling.sh   <- TODO(enforced-by): not written yet
---

# A passing run writes at most 160 bytes to stdout in compact-md

When the wrapped command exits 0 (and satisfies the active TddPhaseGate), dot-test-digest MUST NOT write more than 160 bytes including the trailing newline to stdout in the default compact-md format. The --format=json envelope is exempt.

**Source:** specs/SPEC-002-DOT-TEST-DIGEST.md, INV-1

**Status:** draft. TODO(enforced-by): the check is not written and not yet proven, so this stays `severity: guide` and no tool enforces it. To promote it, write `.dotstack/checks/pass-state-ceiling.sh` (exit non-zero when the rule is broken), prove it fails on a real past violation (commit SHA or fixture path) and passes on HEAD, then add the `enforced-by:` line and only then consider `severity: hard`.
