---
title: "Capture gate for per-run readings: avoid selection bias in deferred aggregation"
date: 2026-06-11
category: skill-design
module: compound-engineering / ce-verify-work
problem_type: design_pattern
component: documentation
severity: medium
applies_when:
  - A skill or workflow persists per-run readings that a future aggregation will consume
  - Designing the write gate for drift events, probe records, run telemetry, or any committed per-run signal
  - Deciding whether to drop a low-confidence or degraded run rather than capture it
tags:
  - capture-gate
  - selection-bias
  - aggregation
  - drift-events
  - low-confidence
  - degraded
  - ce-verify-work
  - measurement-loop
---

# Capture gate for per-run readings: avoid selection bias in deferred aggregation

## Context

`ce-verify-work` produces one committed drift-event file per qualifying run. These events feed a deferred aggregation that computes a drift rate across many runs over time. When writing the write-gate rule (which runs to persist, which to skip), there is a temptation to filter out "noisy" runs — dropping a run where `low_confidence` is true because the attempted set was small, or dropping a `degraded` run because some classifier batches failed.

PR #13 established the gate rule explicitly and added an eval assertion that enforces it. The commits surfaced why silently dropping flagged runs is wrong: it introduces selection bias that the reader of the aggregate has no way to detect.

## Guidance

Gate on a **non-empty denominator**, not on quality flags.

**Skip** a run when `counts.attempted == 0` — drift rate is null (no denominator), so there is nothing to aggregate. These carry no rate signal regardless of quality.

**Capture every other run**, including `low_confidence` and `degraded` runs — but **with their flags intact**. The flags let the reader down-weight those runs at aggregation time. Silently dropping them instead biases the aggregate toward high-confidence, non-degraded runs and ships that bias invisibly.

From `ce-verify-work` SKILL.md Phase 4:

> `counts.attempted > 0` → write exactly one drift event (capture **every** such run, `low_confidence` and `degraded` included — flagged, not dropped, so the aggregation can weight them).

The write-gate test is therefore:

```
if counts.attempted == 0:
    skip — print "No drift event written — 0 attempted units (no denominator)."
else:
    write — always, regardless of low_confidence or degraded
```

**Assert the flags are present in the artifact**, not just computed. An eval or test should check that a low-confidence or degraded run produces a captured artifact that carries the flag. Without this assertion, a dropped or mis-set flag ships unnoticed — the artifact looks like a normal run, and the aggregation has no way to down-weight it.

From commit f93e379d (PR #13):

> "eval now asserts low_confidence (and degraded) are present in the data block — a dropped flag would otherwise ship unnoticed"

## Why This Matters

**Selection bias corrupts the aggregate.** If only high-confidence runs are captured, the computed drift rate looks cleaner than reality — precisely when the plan being verified had sparse or unreliable signal. The bias is not random noise; it tilts in the direction of "things look better than they are."

**The reader cannot detect a silently dropped run.** The aggregation reads a corpus of artifacts. A missing artifact looks identical to "this run didn't happen" — there is no tombstone, no flag, no warning. The reader's only defense is knowing the capture gate captured everything that carried signal.

**Flags survive as down-weighting handles.** `low_confidence: true` in a captured event tells the aggregation "this run's denominator was small; weight it less." That handle is only useful if the event exists. An event dropped because of low confidence gives the aggregation no handle at all.

**The zero-denominator case is the only principled skip.** A zero denominator means the run produced no signal (all units were `remaining` or `unverifiable`) — there is genuinely nothing to contribute to a rate. Every other quality dimension — confidence level, batch failure rate, completeness of the unit list — is information the aggregation should receive and weigh, not a reason to exclude the run.

## When to Apply

- Any skill or workflow that commits per-run readings consumed by a deferred aggregation (drift rates, reliability scores, pipeline health metrics)
- Reviewing a write-gate rule for a new class of committed per-run artifact
- Adding a new quality flag to a per-run artifact — check whether the capture gate silently drops runs carrying that flag

## Examples

Wrong — drops flagged runs, biases the aggregate:

```
if counts.attempted == 0 or low_confidence:
    skip   # silently excludes small-denominator runs from the corpus
```

```
if counts.attempted == 0 or status == "degraded":
    skip   # silently excludes partial-batch runs from the corpus
```

Right — skips only the zero-denominator case, captures everything else with flags:

```
if counts.attempted == 0:
    skip — print "No drift event written — 0 attempted units (no denominator)."
else:
    write artifact with low_confidence and degraded flags verbatim from the envelope
```

Assert the flags are present, not just that the artifact was written:

```ts
// From tests/work-vs-plan-rollup.test.ts (commit f93e379d)
// A low-confidence run must produce an artifact that carries the flag —
// a silently dropped flag biases future aggregation without any signal
expect(artifact.data.low_confidence).toBe(true)
expect(artifact.data.degraded).toBe(false)
```

## Related

- `plugins/compound-engineering/skills/ce-verify-work/SKILL.md` Phase 4 — the "When to write" gate that encodes this rule
- `docs/solutions/skill-design/machine-telemetry-outside-human-learnings-corpus.md` — adjacent concern: where per-run telemetry lives (outside the human-learnings corpus); this doc is about which runs to capture
- `docs/solutions/skill-design/deterministic-sort-before-committing-model-output.md` — sibling concern from the same PR: sort stability of drift-event artifacts
- `docs/adr/0001-per-metric-signal-gate.md` — why drift events store cited unit lists and never a precomputed rate (the ADR that makes deferred aggregation the only path)
- Introduced in PR #13 (commit f93e379d)
