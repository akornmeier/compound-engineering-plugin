---
title: "Copy pre-computed grouped projections verbatim — never re-derive from the flat source"
date: 2026-06-11
category: skill-design
module: compound-engineering / ce-verify-work
problem_type: design_pattern
component: tooling
severity: high
applies_when:
  - An LLM orchestrator persists structured data into a durable artifact
  - A script produces a grouped or projected view of raw data for the orchestrator to write
  - The artifact's downstream consumers (aggregations, comparisons, rate calculations) depend on the grouping being correct
tags:
  - determinism
  - verbatim-copy
  - grouping
  - script-first
  - correctness
  - ce-verify-work
  - misbucketing
---

# Copy pre-computed grouped projections verbatim — never re-derive from the flat source

## Context

`ce-verify-work` Phase 4 writes a committed drift-event artifact that contains verdict-grouped unit-ID lists (`drifted`, `attempted`, `remaining`, `unverifiable`). The grouping is computed by `drift-rollup.js` (`rollupVerdicts`), which returns these lists in an `envelope.grouped` field. When writing the artifact, the orchestrator has two options: copy `envelope.grouped` verbatim, or re-group the flat `envelope.units[]` array by verdict itself.

PR #13 made the instruction explicit after a review observation noted the risk:

> "Copy the lists verbatim from the returned envelope — do not re-group the flat `units[]` array yourself. `envelope.grouped` was computed deterministically by the shared `rollupVerdicts`; re-grouping by hand invites misbucketing that would poison the aggregate."

The correctness claim in the drift-event contract — that grouped lists accurately reflect the classification — is only real if the grouping happened in one place. An LLM that re-groups from the flat source introduces a second, non-deterministic grouping step that can silently misbucket any unit.

## Guidance

When a script computes a grouped or projected view of data for a durable artifact, the orchestrator must **copy that view verbatim** — never re-derive it from the raw data.

From `ce-verify-work` SKILL.md Phase 4:

> "Copy the lists verbatim from the returned envelope — do not re-group the flat `units[]` array yourself."

And from the `drift-rollup.js` comment on the grouped projection:

> "The drift-event capture (ce-verify-work Phase 4) copies these VERBATIM into the artifact's data block, so an LLM never buckets a unit — the determinism is real at the source."

The pattern has two parts:

1. **Script owns the grouping.** The script computes all grouped views from the authoritative sorted array and returns them as named fields in its output envelope. Classification logic is in one place.

2. **Orchestrator copies, does not re-derive.** The orchestrator writes `envelope.grouped.drifted`, `envelope.grouped.attempted`, etc. directly into the artifact. It does not inspect `envelope.units[]` and re-filter by verdict.

This is a **correctness-motivated** complement to the token-motivated "script produces, model presents" pattern (`script-first-skill-architecture.md`). The token argument says: offload mechanics to a script to avoid paying model tokens to re-parse. The correctness argument says: once the script has grouped the data, re-grouping by the model introduces a second, unreliable classification step — even when the orchestrator "just copies" the grouping, it may misread a verdict string, apply a different bucketing rule, or omit an edge case the script handled. Determinism claimed at the artifact level is only real if it is real at the source.

## Why This Matters

**A misbucketed unit poisons every downstream aggregate.** Drift events feed a deferred drift-rate calculation. If a unit is misbucketed — incorrectly placed in `attempted` when it belongs in `remaining` — the denominator is wrong for that event, and every aggregate that includes it is wrong. Because the artifact is committed and diffed, not recomputed, there is no self-correcting mechanism.

**Silent errors are the danger, not loud ones.** An LLM re-grouping from a flat array will usually produce the same result as the script. The failure mode is the rare case where it does not — a verdict edge case, an unusual U-ID, an off-by-one in counting logic. Because the normal case is correct, the bug goes undetected across many runs before a subtle aggregate anomaly surfaces it.

**Verbatim copy is the only proof the grouping is deterministic.** A claim that the artifact is "in document order" or "correctly grouped by verdict" is aspirational until a scrambled-input test enforces it. Copying `envelope.grouped` directly makes the proof structural: the artifact's grouping is exactly what the script produced, with no intervening LLM step.

## When to Apply

- A script computes any grouped, filtered, bucketed, or projected view of data — not just a sorted order
- The orchestrator needs to write that view into a committed artifact
- Downstream consumers (aggregations, comparisons, analytics) treat the grouping as authoritative
- The grouped view is more stable than requiring the orchestrator to re-derive it from the flat source

## Examples

Wrong — orchestrator re-groups from the flat array:

```
# Phase 4: Assemble drift event
# ... compute drifted_ids, attempted_ids, etc. from envelope.units[] ...
drifted_ids = [u.u_id for u in envelope.units if u.verdict == "drifted"]
attempted_ids = [u.u_id for u in envelope.units if u.verdict in ("done", "drifted")]
# LLM re-bucketing: may misread a verdict, miss an edge case, or apply slightly
# different logic than rollupVerdicts — silently poisons any downstream aggregate
```

Right — orchestrator copies the pre-computed grouped projection verbatim:

```
# Phase 4: Assemble drift event
# Copy the lists verbatim from the returned envelope — do not re-group the
# flat `units[]` array yourself. `envelope.grouped` was computed deterministically
# by the shared `rollupVerdicts`; re-grouping by hand invites misbucketing that
# would poison the aggregate.
drifted_ids = envelope.grouped.drifted    # verbatim copy
attempted_ids = envelope.grouped.attempted  # verbatim copy
remaining_ids = envelope.grouped.remaining  # verbatim copy
unverifiable_ids = envelope.grouped.unverifiable  # verbatim copy
```

In the script (`drift-rollup.js`), the grouped projection is computed once from the authoritative sorted array before being returned:

```js
// Verdict-grouped unit-ID lists derived from the ordered units. The drift-event
// capture (ce-verify-work Phase 4) copies these VERBATIM into the artifact's
// data block, so an LLM never buckets a unit — the determinism is real at the
// source.
const grouped = {
  drifted: units.filter((u) => u.verdict === "drifted").map((u) => u.u_id),
  attempted: units.filter((u) => u.verdict === "done" || u.verdict === "drifted").map((u) => u.u_id),
  remaining: units.filter((u) => u.verdict === "remaining").map((u) => u.u_id),
  unverifiable: units.filter((u) => u.verdict === "unverifiable").map((u) => u.u_id),
};
return { drift_rate, low_confidence, counts, units, unverifiable, grouped };
```

## Related

- `docs/solutions/skill-design/script-first-skill-architecture.md` — the token-efficiency motivation for the same direction: script produces all mechanical output, model presents. This doc is the correctness-motivated sibling: even when token cost is acceptable, re-deriving a grouped view from a flat source introduces misbucketing risk.
- `docs/solutions/skill-design/deterministic-sort-before-committing-model-output.md` — sibling concern from the same PR (#13): sort stability of committed artifacts. Sorting before grouping is what makes `envelope.grouped` stable; this doc is about what to do with that stable grouped result once computed.
- Implementation: `plugins/compound-engineering/skills/ce-verify-work/workflows/drift-rollup.js` (grouped projection comment); `plugins/compound-engineering/skills/ce-verify-work/SKILL.md` Phase 4 (verbatim copy instruction) — commits f34d26e and 22674e8
