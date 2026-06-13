---
title: "Anchor probe deduplication on guaranteed identity signals, not best-effort ones"
module: ce-compound / ce-learning-sweep
date: 2026-06-12
problem_type: design_pattern
component: development_workflow
severity: medium
applies_when:
  - "designing a probe that must detect prior work or deduplicate capture records"
  - "one detection signal is guaranteed (e.g., a head-branch prefix) and another is best-effort (e.g., a label whose application is a warning-only step)"
  - "a docstring and its corresponding code disagree — determining which side is wrong before patching"
tags:
  - probe-design
  - deduplication
  - identity-signal
  - best-effort
  - label-application
  - head-branch
  - skill-design
---

# Anchor probe deduplication on guaranteed identity signals, not best-effort ones

## Context

A Copilot reviewer on PR #18 suggested tightening the dedup probe in `probe_capture_pr()` by adding `label:learning-capture` to the `gh pr list --search` query to "reduce false positives." The suggestion was declined, and the docstring was updated to document why. The correct rejection surfaces a general principle: when multiple signals could identify an artifact, require only the ones guaranteed to exist; signals applied in a separate, best-effort step are not safe gates.

## Guidance

Classify each identity signal before using it in a detection or dedup query as either **guaranteed** (created atomically with the artifact, cannot be absent on a legitimate match) or **best-effort** (applied in a separate step whose failure is tolerated). Detection and dedup queries may *require* only guaranteed signals. Best-effort signals may narrow or rank results; they must never gate.

The test: "If the step that applies this signal fails, does the system treat it as a warning or as a failure?" If a warning, the signal is best-effort and cannot be required.

The probe anchors on the guaranteed signal — the head-branch prefix — and excludes the label:

```python
ok, payload = gh_json([
    "pr", "list", "--repo", f"{owner}/{repo}",
    "--search", f"head:{CAPTURE_BRANCH_PREFIX}pr-{source_pr}-",
    "--state", "all", "--json", "number,state,url,headRefName", "--limit", "5",
])
```

GitHub's `head:` qualifier is a text match, not exact, so results are re-filtered in code on the exact prefix:

```python
expected_prefix = f"{CAPTURE_BRANCH_PREFIX}pr-{source_pr}-"
for item in payload:
    if n and s and u and head.startswith(expected_prefix):
        return {"number": n, "state": s, "url": u}
```

The label is confirmed best-effort in `cmd_finalize()` (`stage-captures.py`): `ensure_label()` returns a warning dict on failure, the caller appends it to `warnings` and continues, and the PR is created and emits `pr_open` regardless of whether the label applied.

**Corollary — docstring/code mismatch:** when a reviewer flags a discrepancy between a docstring and code behavior, determine which side is wrong before changing either. Here the code was correct and the docstring was missing the rationale, so the docstring was fixed — not the query. Once a behavior is deliberate, write the rationale *into* the docstring so the next reviewer cannot re-raise the same suggestion as if the omission were an oversight.

## Why This Matters

The probe backs an already-swept short-circuit: if it returns a match, the sweep skips that source PR. A false negative — returning `None` when a capture PR does exist — causes the sweep to run again and create a duplicate capture PR. In unattended runs (automated trigger, no human in the loop), that duplication is silent. Requiring a best-effort signal in the probe query would reintroduce the exact failure the probe was written to prevent.

## When to Apply

Anywhere a query decides whether to create something:

- Dedup probes ("does this artifact already exist?")
- Already-processed checks ("was this PR already handled?")
- Idempotency guards in automation pipelines
- Any short-circuit that avoids re-creating work

Wherever "the query returned nothing" triggers creation, a false negative from a best-effort signal in the query causes unwanted duplication.

## Examples

The false-positive vs false-negative asymmetry is the point:

- **False positive** (query matches something it should not): the `head:` text match could in principle match a similarly-prefixed unrelated branch. This is rare — branches are named deterministically from source PR number and run id — and benign: the in-code `head.startswith(expected_prefix)` re-filter catches it before returning.
- **False negative** (query misses a legitimate match because `label:` was required but the label was never applied): this is routine. Any transient label-application failure leaves a valid capture PR unlabeled; the probe returns `None`, the sweep re-runs, and a duplicate capture PR is created.

The cost of a false positive is a wasted re-filter call; the cost of a false negative is silent duplication in an unattended run. Require the signal whose absence is impossible, not the one whose absence is merely unlikely.

## Related

- [git-workflow-skills-need-explicit-state-machines.md](git-workflow-skills-need-explicit-state-machines.md) — the false-positive side of weak PR-identity signals: `gh pr view` (current-branch-aware) beats `gh pr list --head <branch>` (name-only) in multi-fork repos; this doc covers the complementary false-negative side
- [validation-gate-fail-closed-posture.md](validation-gate-fail-closed-posture.md) — sibling from PR #18: a tolerated/soft signal causing a gate or probe to behave incorrectly
- [capture-gate-avoid-selection-bias.md](capture-gate-avoid-selection-bias.md) — same structural failure of soft elision corrupting downstream output
