---
id: invalid-red-exits-64
title: "A red phase that fails for a non-behavioral reason is INVALID_RED, exit 64"
severity: guide
author: founder
applies-to: "src/**"
# enforced-by: .dotstack/checks/invalid-red-exits-64.sh   <- TODO(enforced-by): not written yet
---

# A red phase that fails for a non-behavioral reason is INVALID_RED, exit 64

With --tdd-phase=red the run is valid only if the child fails on a behavioral assertion or a missing exported symbol. A passing child, a syntax error, a broken import path, or a runner startup crash MUST emit status INVALID_RED and exit 64 (EX_USAGE). A missing export is classified before the syntax tokens.

**Source:** specs/SPEC-002-DOT-TEST-DIGEST.md, INV-5

**Status:** draft. TODO(enforced-by): the check is not written and not yet proven, so this stays `severity: guide` and no tool enforces it. To promote it, write `.dotstack/checks/invalid-red-exits-64.sh` (exit non-zero when the rule is broken), prove it fails on a real past violation (commit SHA or fixture path) and passes on HEAD, then add the `enforced-by:` line and only then consider `severity: hard`.
