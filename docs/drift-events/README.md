# Drift events

This directory holds **machine-read drift telemetry** — one committed file per
qualifying `ce-verify-work` probe run. Each file records a single per-plan
reading: which Implementation Units drifted, which were attempted, with cited
evidence, named by `<plan-basename>--<run_id>.md`.

It is the **capture half** of the rework/churn measurement loop. A future
Signal-gate aggregation will glob these events (plus session history) and
derive an aggregate drift rate across runs — the input the gate reads. That
aggregation, the gate, and its threshold are deferred follow-up work; this
directory only produces their inputs.

**These are not human-authored learnings.** They are per-run telemetry, not
institutional knowledge. They deliberately live outside `docs/solutions/` so
that `ce-learnings-researcher` does not surface them as "past learnings" in
pre-work research and `ce-compound-refresh` does not audit them as
keep/update/delete candidates — neither skill searches or sweeps this
directory.

**The rate is never stored here.** Per [ADR 0001](../adr/0001-per-metric-signal-gate.md),
each event records the cited unit lists only; the drift rate is derived from
them at read time (`|drifted| / |attempted|`), never written as a number. See
`plugins/compound-engineering/skills/ce-verify-work/references/drift-event-contract.md`
for the full document contract.

Per-run files are small. A retention/pruning policy is a named follow-up if the
directory grows large over time.
