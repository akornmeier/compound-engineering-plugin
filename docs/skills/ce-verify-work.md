# `ce-verify-work`

> Read a plan, classify each Implementation Unit against the actual repo state, and report a per-unit verdict table plus a per-plan drift rate — done vs remaining vs drifted, never read from checkboxes.

`ce-verify-work` is a **probe**: a standalone analytical pass you run against any plan, independent of an execution session. It reads one plan document, classifies each `### U<n>.` Implementation Unit against the **actual repo state** — git history plus file/behavior state — and returns a per-unit verdict table and a **drift rate**. It is report-only: it never edits the plan or the repo.

It formalizes the ad-hoc "is this unit already done?" check `ce-work` does inline on resume — but as a backgrounded fan-out that returns only a structured verdict envelope, and that distinguishes **drift** (a unit attempted where the repo diverged — rework-shaped) from mere **remaining** progress.

---

## TL;DR

| Question | Answer |
|----------|--------|
| What does it do? | Classifies each plan unit as `done` / `remaining` / `drifted` / `unverifiable` against repo state and reports a drift rate |
| When to use it | Before resuming work on a plan; to read what is done vs remaining vs drifted; to spot rework-shaped churn |
| What it produces | A per-unit verdict table (U-ID, verdict, cited evidence) + a drift rate + a `low_confidence` flag |
| What's next | Resume with `/ce-work`, or investigate drifted units |
| Distinguishing | Four-verdict classification, drift rate over *attempted* units only, evidence-cited verdicts, context-offloaded fan-out |

---

## The Problem

Across the loop (ideate → brainstorm → plan → work) there is no reliable read on what is done vs. remaining, which produces rework and re-discovery. The naive checks all fail:

- **Plan checkboxes lie** — plans deliberately omit `- [ ]`/`- [x]` state; execution progress lives in git, not the plan body.
- **"Recently changed" is not "done"** — recency says nothing about whether the claimed artifact exists and satisfies its Verification.
- **"Done vs remaining" hides rework** — a unit that was attempted and then diverged is *redo-shaped churn*, not progress. Counting it as "remaining" or "done" both mislead.

## What Makes It Novel

- **Four verdicts, drift separated from progress.** `done`, `remaining`, `drifted`, `unverifiable`. `drifted` (attempted but the repo diverged) is the rework signal; `remaining` (never attempted) is progress. The fourth state, `unverifiable`, is the highest bar — reserved for intrinsically behavioral/runtime Verification a static probe cannot settle (e.g. "improves latency"). Ambiguity never escapes to `unverifiable`; a borderline but statically-checkable unit takes the conservative `done`/`drifted` call.
- **Drift rate over *attempted* units.** `drift_rate = drifted / (done + drifted)`. Never-started and not-statically-settleable units are counted but excluded from the denominator, so the rate measures rework rather than how far along the plan is. An early probe doesn't read near-zero drift just because most units haven't started.
- **Evidence-cited verdicts.** Every `done`/`drifted` verdict carries cited artifacts (commit SHAs, file paths, diff hunks); the deterministic roll-up recomputes the rate from cited verdicts only.
- **Small-N and confidence guards.** Excluding `remaining` shrinks the denominator, so a `low_confidence` flag fires when the attempted set is tiny or mostly `unverifiable` — the rate should not be trusted as a gate input unexamined.
- **Context-offloaded fan-out.** On Claude Code the classification runs as a dynamic workflow, so the per-unit reasoning stays in the workflow runtime and only the final envelope enters the caller's context. On other platforms a guarded prose fallback runs the same rubric and the same deterministic roll-up.

## Probe, not gate

The per-plan drift rate is a single diagnostic **reading**, not a threshold decision. The program-level Signal gate consumes an *aggregate* across runs (built from `ce-compound`-captured drift learnings); this probe produces the per-plan readings that would feed that aggregate. The first cut ships the standalone reading — closing the drift→capture loop and the gate aggregation are follow-up work.

## Quick Example

```text
/ce-verify-work docs/plans/2026-06-07-001-feat-...-plan.md

Drift rate: 0.33 (1 of 3 attempted units drifted)
done 2 · remaining 1 · drifted 1 · unverifiable 1 · attempted 3

| U-ID | verdict      | evidence                                  |
|------|--------------|-------------------------------------------|
| U1   | done         | src/a.js exists; tests/a.test.ts green    |
| U2   | done         | merge module landed in <sha>              |
| U3   | remaining    | no commit touched its declared paths      |
| U4   | drifted      | <sha> touched config; Verification unmet  |
| U5   | unverifiable | "improves latency" — runtime-only         |

A per-plan diagnostic reading, not a gate decision.
```

## Coverage caveat (first cut)

Detection is git-only. A unit reworked without a commit touching its declared paths (uncommitted or squashed-away rework) reads as `remaining` and falls out of the denominator — a coverage gap, not a rate bias. Session-history "claimed done" signals are deferred.
