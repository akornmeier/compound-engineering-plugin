# Per-metric Signal gate for dynamic-workflow conversions

The dynamic-workflows conversion program was framed as a gated probe — conversion #1
must produce the rework/churn signal before the queue is committed — but in practice
ran two conversions (ce-code-review, ce-doc-review) without ever producing that signal.
We make the gate real and scope it correctly: the **Signal gate is per-metric**,
governing only Rework/churn-justified conversions. The rework track's probe is
**work-vs-plan verification**, whose **drift rate** (read-time-derived from
`ce-compound`-captured drift learnings + session history, never stored) feeds the gate.
First read is an **absolute threshold T, pre-committed before the probe run**: drift ≥ T
continues the track; drift < T **halts and reallocates** to the (explicitly qualitative)
learnings-reuse and loop-adoption tracks. The discipline is **rework-specific**,
justified by STRATEGY.md's own asymmetry — Rework/churn is "qualitative today, not yet
instrumented," while the other two metrics name a session-history measurement path.

## Considered Options (rejected)

- **Drop the probe framing, commit the queue on qualitative judgment** — throws away the map's own theory of action.
- **Whole-program gate** (drift halts everything) — drift speaks only to Rework/churn; it has no authority over the other tracks' candidates.
- **Trend-over-N-runs first read** — reintroduces convert-while-waiting (the march) or freezes the queue.
- **Store the drift number in a metrics ledger** — reopens the out-of-scope task-ledger redesign.
- **General gate discipline** (a probe per track) — stalls the program behind instrumentation the other two tracks don't yet need.

## Consequences

- §6's "STRATEGY metric" column is **post-hoc** for the two landed conversions (justified by context-offload + pattern-proving, not measured rework) and must be retagged.
- "Reallocate on failure" means reallocating to **admittedly-qualitative** work — stated plainly so those tracks aren't mistaken for gated.
- **T must be set before the probe run**; its value is a recorded conversion-time open question.
- **§6 is restructured** from a single linear queue (rank 0–11) into **Phase 0 (pattern-proving, complete: code-review, doc-review)** + **three per-metric tracks** (Rework/churn, Learnings reuse, Loop adoption), each internally ordered and labeled with its gate. The flat queue was the structural cause of the march this ADR fixes; tracks make the gate legible and the march impossible by construction. Multi-metric candidates sit on their gating (primary) track.
