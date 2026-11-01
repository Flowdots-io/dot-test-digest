---
id: exit-code-transparency
title: "Return the child's exit code unchanged"
severity: guide
author: founder
applies-to: "src/**"
# enforced-by: .dotstack/checks/exit-code-transparency.sh   <- TODO(enforced-by): not written yet
---

# Return the child's exit code unchanged

Except when explicitly blocking an invalid TDD phase transition under INV-5, dot-test-digest MUST exit with the exact exit code (0..255) or signal code (128 + signal) of the child process. A failure to persist the raw log or the TDD state file MUST NOT alter that code: it is reported on stderr and the run continues.

**Source:** specs/SPEC-002-DOT-TEST-DIGEST.md, INV-3

**Status:** draft. TODO(enforced-by): the check is not written and not yet proven, so this stays `severity: guide` and no tool enforces it. To promote it, write `.dotstack/checks/exit-code-transparency.sh` (exit non-zero when the rule is broken), prove it fails on a real past violation (commit SHA or fixture path) and passes on HEAD, then add the `enforced-by:` line and only then consider `severity: hard`.
