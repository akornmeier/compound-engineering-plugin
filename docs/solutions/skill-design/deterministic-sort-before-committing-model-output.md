---
title: "Sort model-emitted output on a deterministic total key before writing committed artifacts"
date: 2026-06-10
category: skill-design
module: compound-engineering / ce-verify-work
problem_type: design_pattern
component: tooling
severity: medium
applies_when:
  - "A workflow or script turns model output (batch classifier, subagent fan-out) into a committed file"
  - "An output array preserves model emission order instead of a canonical document order"
  - "Committed artifacts are compared across runs (drift events, generated reports, verdict tables)"
tags:
  - determinism
  - sort-order
  - model-output
  - committed-artifacts
  - ce-verify-work
  - regression-testing
---

# Sort model-emitted output on a deterministic total key before writing committed artifacts

## Context

`ce-verify-work`'s roll-up script (`plugins/compound-engineering/skills/ce-verify-work/workflows/drift-rollup.js`) turns per-unit verdicts into a drift-event artifact that gets committed. The original `rollupVerdicts` preserved the input array's order and its docstring claimed the output was "in document order" — true for test fixtures, which were authored in plan order, but silently overstated for the real workflow path. PR #13 review caught the gap:

> "In the workflow path, verdicts come from model output (potentially out-of-order within a batch), so this can produce non-document-ordered lists and make drift-event artifacts non-stable across runs even when the underlying verdicts are the same."

The failure is invisible in tests that feed ordered fixtures: input-order preservation looks like document order until a model actually emits out of order, and then two runs over identical verdicts produce different bytes in the committed artifact.

## Guidance

Any output that flows from model emission into a committed artifact must be sorted by a **deterministic total key** before writing — never written in input-array order.

Two requirements for the key:

1. **Numeric primary key, not lexical.** IDs like `U10` must sort after `U2`. A plain string sort puts `U10` before `U2` and quietly reintroduces instability the moment a plan exceeds 9 units.
2. **String tiebreak for totality.** Non-numeric or duplicate-rank IDs need a defined order too, or the sort is only partial and engine-dependent.

The fix in `drift-rollup.js`:

```js
// Numeric order of a unit's U-id ("U3" -> 3), used to sort the roll-up output
// into the plan's unit order. A non-numeric id sorts last; the comparator
// breaks ties by u_id string so the order is total and deterministic.
function unitOrder(u_id) {
  const n = parseInt(u_id.slice(1), 10);
  return Number.isNaN(n) ? Number.POSITIVE_INFINITY : n;
}

// Order by U-number (the plan's unit order), so output does NOT depend on the
// model's verdict-emission order on the workflow path — a batch classifier may
// return verdicts out of order. This keeps the committed drift-event artifact
// byte-stable across runs of the same plan.
units.sort((a, b) => unitOrder(a.u_id) - unitOrder(b.u_id) || (a.u_id < b.u_id ? -1 : a.u_id > b.u_id ? 1 : 0));
```

Pin the behavior with a **scrambled-input regression test** that also asserts numeric (not lexical) ordering — feed IDs out of order and cross the single-digit boundary:

```ts
test("orders output by U-number even when verdicts arrive out of order (workflow emission)", () => {
  // A batch classifier may emit verdicts out of plan order; the roll-up must
  // sort to the plan's unit order so the committed artifact is run-stable.
  const scrambled = rollupVerdicts([
    { u_id: "U3", verdict: "drifted", evidence: ev("c") },
    { u_id: "U10", verdict: "done", evidence: ev("j") },
    { u_id: "U1", verdict: "done", evidence: ev("a") },
    { u_id: "U2", verdict: "remaining" },
  ])
  // U-number order (numeric, not lexical — U10 sorts after U2, not before it).
  expect(scrambled.units.map((u) => u.u_id)).toEqual(["U1", "U2", "U3", "U10"])
})
```

An ordered-fixture determinism test (same input twice → byte-identical output) is necessary but not sufficient — it passes even when the code merely preserves input order. Only a scrambled input exercises the sort.

## Why This Matters

- **Run stability is the artifact's contract.** Committed artifacts get diffed, deduped, and compared across runs. If ordering tracks model emission, two runs over identical content produce different bytes — phantom diffs, broken dedupe, noisy review.
- **Docstring claims about ordering rot silently.** "In document order" was accurate for every test fixture and false on the live path. Ordering claims need a test that feeds adversarial (scrambled) input, or they are aspirational.
- **Lexical sorting is the second bug hiding behind the first.** Reaching for `sort()` on ID strings fixes the demo and re-breaks at item 10. The regression test must cross the `U9`/`U10` boundary to pin numeric semantics.

## When to Apply

- A workflow or script turns model output (batch classifier verdicts, subagent fan-out results) into a committed file
- An output array currently preserves model emission order instead of a canonical document order
- Committed artifacts are compared across runs — drift events, generated reports, verdict tables
- A docstring or schema claims an ordering ("document order", "plan order") that no scrambled-input test enforces

## Examples

Before — preserves emission order; stable only by accident:

```js
function rollupVerdicts(verdicts) {
  const units = [];
  for (const raw of verdicts) {
    // ...validate...
    units.push({ u_id: raw.u_id, verdict: raw.verdict });
  }
  return { units }; // "in document order" — only if the model emitted it that way
}
```

After — sorted on a numeric total key with string tiebreak before any output is derived:

```js
units.sort((a, b) => unitOrder(a.u_id) - unitOrder(b.u_id) || (a.u_id < b.u_id ? -1 : a.u_id > b.u_id ? 1 : 0));
// Downstream grouped lists derive from the sorted array, so they inherit stability.
```

Derive every downstream view (grouped ID lists, tables) from the sorted array so stability propagates to the whole artifact rather than being re-solved per field.

## Related

- Review thread that caught the instability: https://github.com/akornmeier/compound-engineering-plugin/pull/13#discussion_r3382318295
- Author reply adding the scrambled-input regression test: https://github.com/akornmeier/compound-engineering-plugin/pull/13#discussion_r3382665652
- Implementation: `plugins/compound-engineering/skills/ce-verify-work/workflows/drift-rollup.js` (`unitOrder` comparator); regression test in `tests/work-vs-plan-rollup.test.ts` (commit 2b3b44e)
- `docs/solutions/skill-design/dynamic-workflow-conversion-live-boundary.md` — runtime contracts for the same module family (ce-verify-work workflows); like this pattern, the failures there are invisible to static/ordered-fixture tests
- `docs/solutions/skill-design/script-first-skill-architecture.md` — keeping bucketing/processing in a script is what makes determinism enforceable at the source at all
