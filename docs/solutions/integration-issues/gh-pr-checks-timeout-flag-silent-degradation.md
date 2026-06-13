---
title: "gh pr checks has no --timeout flag; the invalid-flag exit silently degraded every merge"
date: 2026-06-12
category: integration-issues
module: ce-learning-sweep / stage-captures
problem_type: integration_issue
component: tooling
severity: high
symptoms:
  - "Every real merge ended in awaiting_attention even when CI checks were green"
  - "`gh pr checks --timeout N` exits non-zero with a flag-not-found error before watching any checks"
  - "No error surfaced — the flag-failure exit was indistinguishable from a legitimate checks-not-green outcome"
root_cause: wrong_api
resolution_type: code_fix
tags:
  - gh-cli
  - automation
  - silent-failure
  - flag-validation
  - subprocess-timeout
  - merge-path
---

# gh pr checks has no --timeout flag; the invalid-flag exit silently degraded every merge

## Problem

`gh pr checks` does not accept a `--timeout` flag (gh 2.94+ supports only `--watch`, `--interval`/`-i`, and `--fail-fast`). Passing it caused the subprocess to exit non-zero on every invocation, which the merge path treated identically to "checks red" — routing all real merges to `awaiting_attention` without surfacing an error.

## Symptoms

- Every automated merge ended in `awaiting_attention`, even with green CI checks.
- No error was logged: the non-zero exit from the bad flag was indistinguishable from a legitimate "checks not passing" outcome, so the bug was invisible in normal operation.
- Commit 99ad198b: "drop the nonexistent gh pr checks --timeout flag ... every real merge was degrading to awaiting_attention".

## What Didn't Work

Passing `--timeout <N>` to `gh pr checks` to bound the watch duration. The flag does not exist in gh 2.94+; the process exited 1 immediately, before watching any checks. Because the code collapses all non-zero exits into "not green" (`checks_green = watch_proc.returncode == 0`), the invalid-flag failure looked exactly like red checks.

## Solution

Drop `--timeout` from the `gh pr checks` invocation and rely on the subprocess-level `timeout=`, which already enforces the wall-clock ceiling:

```python
# Watch checks with bounded timeout.  gh pr checks does NOT support a
# --timeout flag (gh 2.94+); the subprocess-level timeout= already bounds
# wall clock.  Only --watch, --interval (-i), and --fail-fast are valid.
checks_green = False
try:
    watch_proc = run_cmd(
        ["gh", "pr", "checks", str(pr_number), "--watch"],
        timeout=checks_timeout + 30,
    )
    checks_green = watch_proc.returncode == 0
except subprocess.TimeoutExpired:
    checks_green = False
```

`--watch` is now the only flag passed. The `timeout=` argument to `run_cmd` (forwarded to `subprocess.run`) kills the process if it runs over the wall-clock limit. The `merge` subcommand's own `--timeout` flag controls this Python-level bound, not the gh invocation.

## Why This Works

The subprocess-level `timeout=` raises `subprocess.TimeoutExpired` when the ceiling is exceeded, which the `except` block maps to `checks_green = False`. A green checks run now exits 0 and proceeds to merge. The wall-clock bound is preserved without touching gh's flag surface at all.

## Prevention

- **Verify CLI flags against the installed version before relying on them.** `gh pr checks --help` lists only `--watch`, `--interval`/`-i`, and `--fail-fast` (gh 2.94+). When a subprocess-level timeout is already in place, a CLI-level timeout flag is redundant anyway.
- **When command failure and a legitimate degraded outcome share the same handling path, you cannot distinguish them — test the success path and make the test shim reject unknown flags.** The fake-`gh` shim in `tests/learning-sweep-staging.test.ts` now rejects any flag on `gh pr checks` other than the valid three, and a test exercises the full green-path merge and asserts the result is `merged`. If `--timeout` were reintroduced, the shim would exit 1, `checks_green` would be false, and the test would fail loudly instead of silently degrading.

## Related Issues

- [../skill-design/validation-gate-fail-closed-posture.md](../skill-design/validation-gate-fail-closed-posture.md) — sibling from PR #18; rule 3 (timeout on every external call) is the same mechanism applied at the subprocess level, and the silent-degradation shape is the same family
- [../skill-design/git-workflow-skills-need-explicit-state-machines.md](../skill-design/git-workflow-skills-need-explicit-state-machines.md) — the inverse principle: "model expected non-zero exits as state, not failures" — the two sides of gh-CLI exit-code ambiguity
