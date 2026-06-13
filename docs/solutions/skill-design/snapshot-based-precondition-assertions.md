---
title: "Snapshot-based precondition assertions for dirty-environment workflows"
module: plugins/compound-engineering/skills/ce-learning-sweep
date: 2026-06-12
problem_type: design_pattern
component: development_workflow
severity: medium
applies_when:
  - "A workflow assertion runs in real developer environments where the checkout may have unrelated dirty files"
  - "A precondition guards write-root isolation (writes must stay inside a staging area, not the main checkout)"
  - "An absolute-state cleanliness check false-aborts on innocuous dirty files, or gets loosened to skip-on-dirty and masks real violations"
tags:
  - precondition-design
  - snapshot-baseline
  - dirty-checkout
  - write-root-isolation
  - staging-worktree
  - assertion-design
  - workflow-safety
---

# Snapshot-based precondition assertions for dirty-environment workflows

## Context

The `ce-learning-sweep` skill dispatches `ce-compound` into an isolated staging worktree to write solution docs. A safety assertion in the main checkout verifies those dispatches don't leak writes outside the worktree. But the assertion runs in real developer environments where the main checkout is routinely dirty with unrelated in-progress work — staged hunks, modified files, scratch — that predates the sweep and is irrelevant to it.

## Guidance

Use a snapshot-delta assertion, not an absolute-clean assertion. The two naive approaches each fail:

- **(a) Absolute-clean assertion** — abort when `git status --porcelain` returns any output. False-aborts whenever the developer has any unrelated dirty file; developers who hit this repeatedly disable the check.
- **(b) Skip the check when dirty** — bypass the assertion if the tree is non-clean. Masks the exact violation the assertion exists to catch (a write leaking into the main checkout), because the gate is skipped precisely when it would fire.

The fix — snapshot-delta. Before the FIRST dispatch, capture a baseline in the main checkout (not the worktree):

```bash
git status --porcelain
```

Record the full output as the baseline. After EACH dispatch, re-run and compare against the baseline; abort on any NEW entry relative to the baseline. From `staging-workflow.md`:

> "Run this in the main checkout (not the worktree) and record the output as the baseline. After EACH dispatch, re-run and compare against the baseline. Any NEW entry relative to the baseline that traces to the dispatch → run `abort` immediately. The assertion is 'no new entries since the snapshot', not 'a completely clean tree' — a developer working in a dirty checkout is the normal case and the baseline handles it."

## Why This Matters

The assertion is a safety gate: the staging flow gives `ce-compound` an explicit write root (the worktree path) and expects all writes to land there. A write to the main checkout instead lands outside the sandboxed staging branch and can corrupt the working tree.

A gate with either degraded failure mode provides no durable safety. One that false-aborts gets disabled by frustrated developers; one that skips-when-inconvenient is absent exactly when it would fire. The snapshot-delta keeps the gate both usable in dirty checkouts and sound — it cannot be fooled by pre-existing dirt, and it does not penalize developers with unrelated work in flight.

## When to Apply

Apply the snapshot-delta pattern to any precondition or safety assertion that satisfies both:

1. **Must detect changes a process introduces** — catching mutations made by a subprocess, tool invocation, or agent dispatch during a bounded operation.
2. **Runs in environments with pre-existing unrelated state** — developer checkouts, shared CI workspaces, long-lived sandboxes.

When only (1) holds (the environment is known-clean, e.g. a fresh CI runner), an absolute assertion is simpler and fine. When only (2) holds (you're checking pre-existing state, not process-introduced changes), the baseline adds no value.

## Examples

Before (naive absolute assertion) — fires on any pre-existing dirty file:

```bash
if [ -n "$(git status --porcelain)" ]; then
  echo "ERROR: checkout is not clean" && exit 1
fi
```

After (snapshot-delta) — only entries introduced after the baseline trigger the abort:

```bash
BASELINE=$(git status --porcelain)
# ... run ce-compound dispatch ...
CURRENT=$(git status --porcelain)
NEW_ENTRIES=$(comm -13 <(echo "$BASELINE" | sort) <(echo "$CURRENT" | sort))
if [ -n "$NEW_ENTRIES" ]; then
  echo "ERROR: dispatch leaked writes to main checkout:" && echo "$NEW_ENTRIES" && exit 1
fi
```

Pre-existing dirty files appear in both `BASELINE` and `CURRENT`; `comm -13` filters them out, leaving only post-baseline entries.

## Related

- [validation-gate-fail-closed-posture.md](validation-gate-fail-closed-posture.md) — PR #18 sibling; covers *how* to handle a measurement failure (hard-exit, not default-pass), where this doc covers *what* to measure (delta, not absolute state)
- [../workflow/stale-local-base-contamination.md](../workflow/stale-local-base-contamination.md) — same instinct (check the right layer, not a blunt absolute) applied to branch creation in multi-session work
- [../integration-issues/github-actions-head-ref-misleads-branch-gate.md](../integration-issues/github-actions-head-ref-misleads-branch-gate.md) — co-learning from PR #18; another "gate resolved the wrong thing" case
