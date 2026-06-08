# feat: ce-verify-work live-smoke fixture plan

A seeded plan for the ce-verify-work live smoke + parse tests. Its units point at
real, stable repository files so a live classifier can reach a known verdict for
each from actual git/file state. This is a FIXTURE, not a real plan.

Ground truth (documented for the eval; the live classifier is asserted against a
range, not verbatim): U1 done, U2 remaining, U3 drifted, U4 unverifiable, U5 done.
attempted = done + drifted = 3; drift_rate = 1/3 ≈ 0.33.

## Implementation Units

### U1. Drift roll-up module exists

**Goal:** The deterministic parser + roll-up module is present and exports its contract.

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/workflows/drift-rollup.js` (new)

**Verification:** `drift-rollup.js` exists and exports both `parsePlanUnits` and `rollupVerdicts`.

---

### U2. Future helper not yet built

**Goal:** A churn-index helper that has not been started.

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/workflows/never-created-helper.js` (new)

**Verification:** the helper file exists and exports `computeChurnIndex`.

---

### U3. SKILL.md documents JSON output and a caching layer

**Goal:** Extend the skill to emit machine-readable JSON and cache prior runs.

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/SKILL.md` (modified)

**Verification:** `SKILL.md` documents a `--json` output flag and a run-caching layer keyed by plan hash.

---

### U4. Classification latency target

**Goal:** Keep classification fast under production load.

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/workflows/work-vs-plan-fanout.js` (modified)

**Verification:** end-to-end classification completes within 5ms p99 under production load.

---

### U5. Verdict schema enum is exactly four states

**Goal:** The per-unit verdict schema pins exactly the four verdicts.

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/references/verdict-schema.json` (new)

**Verification:** `verdict-schema.json` defines a verdict enum containing exactly done, remaining, drifted, unverifiable.

---

## Risk Analysis

Fixture filler section so the parser's unit-boundary stop (a level-2 heading) is exercised.
