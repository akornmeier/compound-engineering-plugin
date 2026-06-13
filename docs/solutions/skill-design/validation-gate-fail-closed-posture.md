---
title: "Validation gates must fail closed: hard exit on measurement failure, timeout on external calls"
date: 2026-06-12
category: skill-design
module: compound-engineering / validate-staged-keepers
problem_type: best_practice
component: development_workflow
severity: high
applies_when:
  - Writing a validation gate that calls external tools (git, gh, shell subprocesses)
  - A gate measurement can fail silently and produce a default value that allows the guarded action
  - Running gates in CI environments with shallow clones or constrained network/process limits
tags:
  - validation-gate
  - fail-closed
  - subprocess-failures
  - timeout
  - ci-safety
  - shallow-clone
  - hard-exit
---

# Validation gates must fail closed: hard exit on measurement failure, timeout on external calls

## Context

A review round on PR #18's capture-PR validation gate (`validate-staged-keepers.py`) found three default-to-pass holes with the same shape: a failed subprocess measurement silently returned a benign value, letting the gate pass when it should have blocked.

> "get_entry_diff_size() ignores git failures (bad base ref, pathspec issues, etc.) and would treat them as a 0-byte diff. That can silently bypass the size caps and make the gate produce false passes." (Copilot review, PR #18)

## Guidance

Gates fail closed. Three rules:

**1. Hard exit on measurement failure.** Any subprocess whose output feeds a pass/fail decision must exit non-zero when the subprocess fails — never return a default value.

```python
# Anti-pattern: failure masquerades as an empty measurement
proc = run_git(["diff", f"{base_ref}...HEAD", "--", file_path], cwd=repo_root)
if proc.returncode != 0:
    return 0  # size cap never fires

# Fix: the gate refuses to measure rather than measuring wrong
if proc.returncode != 0:
    sys.stderr.write(f"validate-staged-keepers: git diff failed for '{file_path}': {proc.stderr}\n")
    sys.exit(2)
```

A helper may return a sentinel (e.g. `get_merge_base()` returning `""`) only when its caller unconditionally converts the sentinel into a hard exit — never when any caller could read it as "no changes."

**2. Hard exit on missing dependency.** A validator module, staging worktree, or other structural dependency the gate needs must be a hard failure when absent, never a silent skip. `scan_corpus_module()` exits 2 when `scan-corpus.py` cannot load — the gate refuses to validate rather than degrading. The merge path in `stage-captures.py` treats a missing validator script or missing staging worktree as `validation_failed` — it never merges unvalidated.

**3. Timeout on every external call.** Any subprocess that can hang gets a bounded timeout, and the timeout is itself a hard failure:

```python
except subprocess.TimeoutExpired:
    sys.stderr.write(f"validate-staged-keepers: git {' '.join(args)!r} timed out after {GIT_TIMEOUT_SECONDS}s\n")
    sys.exit(2)
```

## Why This Matters

Each hole had a concrete exploit or failure path:

- **Size-cap bypass:** a bad base ref makes `git diff` fail; reading that as 0 bytes lets an oversized capture doc pass the per-entry and per-PR caps without ever being measured.
- **Shallow-clone vacuous pass:** CI runners default to `fetch-depth: 1`, where `git merge-base HEAD origin/main` fails because the common ancestor is absent. Reading the empty merge-base as "no changes on main" turned the staleness gate into a no-op on the most common CI configuration ("merge-base failure is a hard exit-2 (shallow-clone vacuous pass eliminated)" — commit 99ad198b).
- **Silent hang:** a stalled git call (locked index, network fetch, corrupt pack) blocks the gate indefinitely; the CI job looks like it is running, not failing. A 60s subprocess timeout converts the silent hang into an explicit exit-2 with a diagnostic.

The common error is semantic: conflating "measurement unavailable" with "measurement is zero/empty." For a gate, a failed measurement and a passing measurement must never be the same value.

## When to Apply

- Any validator or gate whose pass/fail decision depends on subprocess output, especially threshold comparisons (size caps, staleness, counts) where a wrong measurement produces a wrong verdict rather than missing data
- Gates that run in CI — shallow clones, missing tools, and environment differences are the norm there
- Gates controlling merge, deploy, or commit decisions
- Beyond git: linters, scanners, schema validators — any subprocess feeding a gate is a potential failure source, not a reliable data source

## Examples

Before/after for `get_entry_diff_size` — see Guidance rule 1 above. The before code fails open (a measurement error produces a passing measurement); the after code fails closed (a measurement error stops the gate with a diagnostic naming the file and the git error).

## Related

- [capture-gate-avoid-selection-bias.md](capture-gate-avoid-selection-bias.md) — sibling gate-semantics rule: skip only on a zero denominator, never on quality flags; both docs are about silent elision corrupting downstream signal
- [../best-practices/prefer-python-over-bash-for-pipeline-scripts.md](../best-practices/prefer-python-over-bash-for-pipeline-scripts.md) — adjacent layer: Python's explicit returncode model is the implementation vehicle for these hard-exit rules
- [../test-failures/git-fixture-branch-init-defaultbranch.md](../test-failures/git-fixture-branch-init-defaultbranch.md) — co-located learning from the same PR (#18)
