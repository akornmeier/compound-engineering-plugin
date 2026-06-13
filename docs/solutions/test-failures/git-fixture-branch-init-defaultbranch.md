---
title: Git test fixtures must pin the initial branch with `git init -b` — never rely on init.defaultBranch
date: 2026-06-12
category: test-failures
module: test-fixtures
problem_type: test_failure
component: testing_framework
symptoms:
  - "`git checkout main` fails inside a test fixture with `error: pathspec 'main' did not match any file(s) known to git`"
  - "Tests pass on machines where init.defaultBranch is main but fail on CI images or machines where the default is master"
root_cause: config_error
resolution_type: test_fix
severity: medium
tags:
  - git
  - test-fixtures
  - init-defaultbranch
  - branch-naming
  - ci-portability
  - test-isolation
---

# Git test fixtures must pin the initial branch with `git init -b` — never rely on init.defaultBranch

## Problem

Test fixtures that create git repositories without pinning the initial branch name inherit whatever `init.defaultBranch` is configured in the runner's environment — commonly `master` on older git installations and CI images. Tests that later run `git checkout main` then fail because no local `main` branch exists.

Surfaced by Copilot review on PR #18 against `createFixture()` in `tests/learning-sweep-revalidation.test.ts`:

> "createFixture() relies on whatever the environment's default initial branch name is (often `master`). Several tests later do `git checkout main`, so this fixture can fail depending on git/global config."

## Symptoms

- `git checkout main` inside a fixture returns `error: pathspec 'main' did not match any file(s) known to git`
- Failure is machine-dependent: passes on developer machines with `init.defaultBranch = main`, fails on CI images or machines where the default is still `master`
- Affects any test that creates a repo via the fixture and then switches branches by name

## What Didn't Work

The pre-fix fixture shape — implicit default branch plus a separate upstream call:

```typescript
// Before: implicit default branch name
await Bun.spawn(["git", "init", "--bare", "-q", origin]).exited
await Bun.spawn(["git", "init", "-q", clone]).exited
// ...
await g(["push", "-q", "origin", "HEAD:main"])
await g(["branch", "-q", "-u", "origin/main"])
```

This is fragile for two reasons:

1. `git init` without `-b` creates the local branch under whatever name `init.defaultBranch` resolves to. The `push ... HEAD:main` creates a remote `main` ref, but the local branch is still `master` (or whatever the environment default is).
2. `git branch -u origin/main` only sets the upstream tracking ref on the current local branch — it does not rename or create a local `main`, so `git checkout main` still fails.

## Solution

Pin the branch name explicitly at `git init` time for both the bare origin and the clone, and set the upstream via `push -u` in one step:

```typescript
// After: pinned — works regardless of global git config
await Bun.spawn(["git", "init", "--bare", "-q", "-b", "main", origin]).exited
await Bun.spawn(["git", "init", "-q", "-b", "main", clone]).exited
// ...
await g(["push", "-q", "-u", "origin", "HEAD:main"])
// No separate `git branch -u` needed — push -u sets the upstream atomically
```

This is the fixed shape in `tests/learning-sweep-revalidation.test.ts` (commit 47740694: "revalidation fixture pins initial branch to main (init -b main, push -u) regardless of init.defaultBranch").

## Why This Works

`init.defaultBranch` is per-environment global git config. `GIT_CONFIG_NOSYSTEM=1` suppresses system config, but `HOME`-based user config still applies unless `HOME` is overridden — so an "isolated" fixture is still environment-sensitive. The `-b main` flag bypasses the config lookup entirely and names the branch at creation time, making the fixture deterministic across all environments. Using `push -u` instead of a separate `git branch -u` wires the local branch and remote tracking ref in one atomic step.

## Prevention

- Always pass `-b <branch>` to both `git init` and `git init --bare` in test fixtures.
- Set the upstream tracking ref via `push -u origin HEAD:<branch>`, not a separate `git branch -u` call.
- Never call `git checkout <branch>` in a test without having pinned that branch name at init time.
- When auditing, search `tests/` for `git init` calls missing `-b`: as of 2026-06-12, `tests/learning-sweep-staging.test.ts` (`setupFixtureRepo()`) and two fixtures in `tests/cli.test.ts` still omit `-b`. They do not currently `checkout` by name, so they pass — but they carry the same latent defect.

## Related Issues

- [skill-design/git-workflow-skills-need-explicit-state-machines.md](../skill-design/git-workflow-skills-need-explicit-state-machines.md) — the runtime-skill analog: git branch-naming assumptions also fail in workflow skills (its checklist covers non-`main` default branch names like `develop` or `trunk`)
- [workflow/stale-local-base-contamination.md](../workflow/stale-local-base-contamination.md) — same family of "environment state silently diverges from assumed git state" problems
