---
title: "GITHUB_HEAD_REF names the source PR's head ref — not the worktree branch — and silently skips a branch-activated gate"
date: 2026-06-12
category: integration-issues
module: ce-learning-sweep / validate-staged-keepers
problem_type: integration_issue
component: development_workflow
severity: high
symptoms:
  - "A branch-prefix-activated gate silently skips validation when invoked from a pull_request Actions workflow"
  - "`GITHUB_HEAD_REF` resolves to the source PR's head ref, not the operative worktree's branch"
  - "Validator passes locally (git fallback resolves the real branch) but no-ops in CI"
root_cause: wrong_api
resolution_type: code_fix
tags:
  - github-actions
  - ci
  - branch-detection
  - env-var
  - worktree
  - gate-bypass
  - pull-request-context
---

# GITHUB_HEAD_REF names the source PR's head ref — not the worktree branch — and silently skips a branch-activated gate

## Problem

`validate-staged-keepers.py`'s `detect_branch()` falls back to `GITHUB_HEAD_REF` when no `--branch` arg is passed. In a `pull_request` GitHub Actions context, `GITHUB_HEAD_REF` names the *triggering* PR's head ref — not the branch checked out inside a script-created worktree — so the validator's activation check (`branch.startswith(BRANCH_PREFIX)`) compares the wrong branch name and silently skips the gate.

## Symptoms

- The validator no-ops on a capture PR when invoked from Actions, even though the worktree's branch starts with `learning-capture/` and should trigger enforcement.
- Locally, `GITHUB_HEAD_REF` is unset, so `detect_branch()` falls through to `git branch --show-current`, resolves the real branch, and the gate activates — the bug is CI-only and silent (no error, just a skipped check).

## What Didn't Work

Relying on the `GITHUB_HEAD_REF` env-var fallback for branch detection inside a worktree-scoped script. The precedence chain is:

```python
def detect_branch(branch_arg: str | None, repo_root: str) -> str:
    """Return the current branch name. Prefer CLI arg, then env, then git."""
    if branch_arg:
        return branch_arg
    env_ref = os.environ.get("GITHUB_HEAD_REF", "").strip()
    if env_ref:
        return env_ref
    proc = run_git(["branch", "--show-current"], cwd=repo_root)
    return proc.stdout.strip()
```

When `GITHUB_HEAD_REF` is set — as it always is in a `pull_request` Actions job — the correct `git branch --show-current` fallback is never reached. The env var wins and supplies the source PR's branch, which does not start with the capture prefix, so the gate's activation check fails and it skips.

## Solution

Resolve the branch with `git branch --show-current` *inside the target worktree* and pass it explicitly via `--branch`. Because `detect_branch()` checks the CLI arg first, the explicit value wins over `GITHUB_HEAD_REF`:

```python
# Resolve the worktree's actual branch so the validator is not misled by
# GITHUB_HEAD_REF (which, inside a pull_request Actions context, points to
# the SOURCE PR's head ref, not the capture branch).
branch_proc = run_cmd(["git", "branch", "--show-current"], cwd=wt_dir)
wt_branch = branch_proc.stdout.strip() if branch_proc.returncode == 0 else ""

val_cmd = ["python3", str(validator_path), "--repo", str(wt_dir)]
if wt_branch:
    val_cmd += ["--branch", wt_branch]
```

The CLI-arg-first precedence makes the worktree-resolved branch authoritative; the misleading env var is never consulted.

## Why This Works

GitHub Actions sets `GITHUB_HEAD_REF` for the *triggering* PR — a property of the workflow trigger event, not of any filesystem object. A script-created worktree has its own branch, unrelated to the triggering PR's ref. `git branch --show-current` run with `cwd=wt_dir` queries git's HEAD for that worktree — the only authoritative source. Passing it via `--branch` makes it the first-priority input in `detect_branch()`, so the env var is bypassed.

## Prevention

- Branch- or path-activated gates must resolve their activation key from the artifact they operate on (the worktree, the file, the commit), never from ambient CI env vars. CI env vars describe the triggering event, which may be unrelated to the thing being validated.
- Keep CLI-arg-first precedence in any branch-detection function so callers can supply an authoritative override.
- When a gate conditionally activates on a key (branch prefix, path pattern, label), write a test that asserts the gate *activates* — not just that it passes — on the correct input. A gate that silently skips is indistinguishable from one that passes; activation must be verified independently.

## Related Issues

- [../skill-design/validation-gate-fail-closed-posture.md](../skill-design/validation-gate-fail-closed-posture.md) — sibling from PR #18; another class of silent gate skip (subprocess measurement failure). Both document ways a gate passes when it should block
- [../skill-design/git-workflow-skills-need-explicit-state-machines.md](../skill-design/git-workflow-skills-need-explicit-state-machines.md) — shares the "`git branch --show-current` at the point of decision" principle; that doc covers in-session staleness, this one covers ambient-env-var confusion
- [../skill-design/probe-dedup-guaranteed-identity-signal.md](../skill-design/probe-dedup-guaranteed-identity-signal.md) — `GITHUB_HEAD_REF` is a context-dependent signal for worktree branch identity; `git branch --show-current` is the guaranteed one
- [../test-failures/git-fixture-branch-init-defaultbranch.md](../test-failures/git-fixture-branch-init-defaultbranch.md) — co-located PR #18 learning; another case where ambient environment makes a branch assumption wrong
