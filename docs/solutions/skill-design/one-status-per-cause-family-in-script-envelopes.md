---
title: "One status per cause family in script JSON status vocabularies"
module: plugins/compound-engineering/skills/ce-learning-sweep
date: 2026-06-12
problem_type: convention
component: tooling
severity: medium
applies_when:
  - A script emits a JSON status envelope with multiple terminal statuses
  - A caller (SKILL.md or references branch table) routes recovery behavior on status values
  - A new failure path is being added to an existing status-envelope script
  - Reviewing a PR that touches a script's exit-status taxonomy
tags:
  - status-envelope
  - script-seams
  - taxonomy
  - error-handling
  - json-status
  - skill-design
  - branch-tables
---

# One status per cause family in script JSON status vocabularies

## Context

`stage-captures.py` is a status-envelope script — a JSON state-machine seam between a bundled script and the orchestrating skill. Each subcommand emits one JSON envelope and exits 0; the skill branches on the `status` field to pick recovery logic.

Before the fix, `cmd_finalize()` emitted `no_forge` on both `git commit` and `git push` failures. But `no_forge`'s documented meaning is "gh CLI absent or not authenticated" — a forge-access error, not a git-mechanics error. A reviewer caught it:

> "`no_forge` is documented as 'gh CLI absent or not authenticated', but this branch is triggered by `git commit` failure (which can be unrelated to forge auth, e.g. missing git identity, empty index, hooks). Using `staging_error` here makes the status taxonomy match the actual failure source and keeps `no_forge` meaningful for callers." (Copilot review, PR #18)

## Guidance

**One terminal status per cause family. A status's documented meaning is a contract callers route on.**

1. **Map each cause family to its own status.** Forge-access failures (`gh` absent/unauthenticated) → `no_forge`. Git-operation failures (`git commit`, `git push`, `git fetch`) → `staging_error`. Never reuse one to cover the other.
2. **Carry the raw error in `detail`, not in a new status.** `detail` is for humans and logs; `status` is for machines. Distinct error messages within the same cause family do not justify distinct statuses.
3. **Reuse an existing same-family status rather than proliferating.** `staging_error` already covered `git fetch`/`git worktree add` failures in `cmd_open()`; `cmd_finalize()` reuses it for `git commit`/`git push` ("Kept the existing `staging_error` status rather than adding a new one to keep the taxonomy minimal").
4. **Update every consumer branch table in the same change.** SKILL.md and `references/staging-workflow.md` both document each status's meaning and recovery. If code changes but docs don't, the divergence yields misleading recovery instructions and no reader can tell which is authoritative.

After the fix, the git error paths emit `staging_error` with stderr in `detail`, and `no_forge` appears only at the gh-availability gate. The docs match: `staging-workflow.md` states "`staging_error` — git operation failed; detail names the failure (open: fetch/worktree-add; finalize: commit/push)" and "`no_forge` — gh absent or unauthenticated (open/finalize/merge)".

## Why This Matters

Callers branch on `status` to pick recovery:

- `no_forge` → "forge lost; a PR may exist on the remote and waits; treat as `awaiting_attention`"
- `staging_error` → "the git layer failed; nothing is on the remote; report `detail` and abort"

A `git commit` failure emitting `no_forge` routes to "PR exists and waits" — but no PR exists (the commit never happened), so the recovery is nonsensical. The operator also sees `no_forge` in logs and checks gh authentication, when the real cause is something like a pre-commit hook rejection or an index lock. The mislabeled status sends both the machine and the human down the wrong path.

## When to Apply

Any script that emits a machine-readable status envelope consumed by another layer (skills, CI, orchestrators, test harnesses), whenever:

- A consumer branches on the status value to pick recovery or next action
- Multiple distinct cause families could produce a failure at the same code location
- A status has a documented meaning that callers have been written against

## Examples

Before — `git commit` failure emits `no_forge` (misleading):

```python
if commit_proc.returncode != 0:
    emit({"status": "no_forge", "detail": "gh CLI unavailable or not authenticated"})
    # Caller routes: "PR exists and waits" — wrong; no PR was ever created
```

After — git failures emit `staging_error` with actual stderr; `no_forge` is reserved for the gh gate:

```python
if commit_proc.returncode != 0:
    emit({"status": "staging_error", "detail": commit_proc.stderr.strip()[:300] or "git commit failed"})
    # Caller routes: "report git failure, abort" — correct
```

## Related

- [git-workflow-skills-need-explicit-state-machines.md](git-workflow-skills-need-explicit-state-machines.md) — the mirror principle (rule 4: "model expected non-zero exits as state transitions, not generic failures"); that doc is about modeling states, this one is about naming them unambiguously
- [validation-gate-fail-closed-posture.md](validation-gate-fail-closed-posture.md) — sibling from the same PR #18 review round on `stage-captures.py`
- [../integration-issues/gh-pr-checks-timeout-flag-silent-degradation.md](../integration-issues/gh-pr-checks-timeout-flag-silent-degradation.md) — same family: a wrong terminal status (`awaiting_attention`) silently routing recovery down the wrong path
