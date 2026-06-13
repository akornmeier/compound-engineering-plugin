# Drift-event template

Fill-in template for the `ce-verify-work` Phase 4 capture. Copy the block below
to `docs/drift-events/<plan-basename>--<run_id>.md`, substituting each `<...>`
slot from the returned envelope. See `references/drift-event-contract.md` for
field sources and the no-rate rule.

The data block is **copied verbatim from `envelope.grouped`** plus the run
flags — do not re-derive the lists from `units[]`.

````markdown
---
date: <YYYY-MM-DD, stamped by the orchestrator>
plan: <plan-basename>
run_id: <envelope.run_id>
tags: [drift-event, work-vs-plan-verification, ce-verify-work]
---

# Drift event — <plan-basename> (<run_id>)

```yaml
# machine-read block — copied verbatim from the envelope's grouped lists.
# The aggregation reads THIS; the rate is derived, never stored.
plan_path: <envelope.plan_path>
run_id: <envelope.run_id>
low_confidence: <envelope.low_confidence — true|false>
degraded: <envelope.status === "degraded" — true|false>
drifted: <envelope.grouped.drifted, e.g. [U3] or []>
attempted: <envelope.grouped.attempted, e.g. [U1, U3, U5] or []>
remaining: <envelope.grouped.remaining, e.g. [U2] or []>
unverifiable: <envelope.grouped.unverifiable, e.g. [U4] or []>
```

## Cited evidence
- <U-ID> (drifted): <evidence from envelope.units[].evidence — both the attempt and the divergence>
- <U-ID> (done): <evidence from envelope.units[].evidence — what satisfies Verification>
````

**Never add a `drift_rate` or any precomputed rate field** (ADR 0001 — the rate
is derived from the unit lists at read time, never stored).
