# Work-vs-plan verdict rubric

Classify each Implementation Unit against the **actual repo state** — git history plus file/behavior state — never against plan checkboxes (plans deliberately omit them) and never against session history (out of the first cut). Emit one verdict object per unit matching `verdict-schema.json`.

## The four verdicts

**`done`** — the unit's declared `**Files:**` are present and its `**Verification:**` is satisfied by the current repo state.
- Evidence: **required, non-empty.** Cite the artifacts that prove it — repo-relative file paths that exist, the commit(s) that landed them, the code/test that satisfies Verification.

**`remaining`** — there is no git evidence the unit was ever attempted: no commit touched any of its declared `**Files:**` paths.
- This is **progress, not rework** — it is excluded from the drift-rate denominator. A never-started unit is not drift.
- Inferred from the *absence* of an attempt, never from "not recently touched". Evidence optional.

**`drifted`** — git evidence shows the unit *was* attempted (a commit touched its declared `**Files:**` paths) **but** the repo diverged: Verification is unmet, or the declared Files are partial/deleted/inconsistent with the unit's intent.
- This is **rework-shaped** — it is the numerator of the drift rate.
- Evidence: **required, non-empty.** Cite **both** the attempt (the commit/diff that touched the paths) **and** the divergence (the missing/changed artifact, the unmet Verification).

**`unverifiable`** — **the highest bar.** The unit's `**Verification:**` is *intrinsically* behavioral or runtime and cannot be settled from static repo state — e.g. "improves latency", "handles concurrent writes", "feels responsive".
- Reported separately and **excluded from the denominator**; a high `unverifiable` fraction flags the whole run as low-confidence.
- A unit with concrete Files and a statically-checkable Verification is **never** `unverifiable`. The fourth state is reserved for genuinely runtime criteria, not for "I'm unsure".

## Decision rules

- **Git + file state only.** The attempt signal is "a commit touched the unit's declared `**Files:**` paths". The repo has no U-ID-in-commit convention, so a commit *naming* the unit is not required and not expected.
- **Ambiguity does not route to `unverifiable`.** When a unit is statically checkable but the done-vs-drifted call is borderline, make the **conservative** call: lean `drifted` over a false `done` (a false `done` hides rework). Escaping a checkable unit to `unverifiable` would shrink the denominator and skew the rate — do not do it.
- **Shared paths.** When a touched path could belong to more than one unit, adjudicate by the unit's own `**Verification:**`, conservatively.
- **"Recently changed" is not a done-proxy.** The signal is whether the claimed artifact exists and satisfies Verification — not whether something nearby was edited.
- **Never read legacy `- [ ]` / `- [x]` marks** as done/remaining state. They are not evidence.

## Coverage caveat (first cut)

Detection is git-only. A unit reworked without a commit touching its declared paths (uncommitted or squashed-away rework) reads as `remaining` and falls out of the `done + drifted` denominator entirely — a coverage gap, not a rate bias. Session-history "claimed done" signals are deferred.
