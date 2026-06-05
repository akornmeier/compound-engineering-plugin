# Produce the Dynamic Workflows Opportunity Map

Created: 2026-06-04
Origin: `docs/brainstorms/2026-06-04-dynamic-workflows-opportunity-map-requirements.md`

## Goal

Author the prioritized **opportunity map + reusable selection criteria** the brainstorm specified — a standalone markdown artifact a downstream planner can pick up to start the first conversion without re-deriving which skills qualify, which pattern each uses, or why one ranks first. The conversions themselves stay downstream and out of scope.

## Scope

**In:** the map document — selection criteria (R1–R3), pattern taxonomy (R4), the memory-loop spine with per-candidate classification (R5–R13), prioritization + first-vs-highest-leverage recommendation (R7), design-constraint section (R14–R15), and the open questions recorded per candidate.

**Out:** any skill rewrite or workflow `.js` authoring; retiring non-CC targets; a task-ledger / durable-state redesign; a workflow-authoring meta-skill or converter changes. The map *records* downstream questions; it does not *resolve* them.

## What the brainstorm already settled (don't re-derive)

- **Criteria framework** R1–R3, **taxonomy** R4, **spine** R5, **candidate list with patterns** R8–R13 — all specified. The map's job is to *apply* them accurately, not reinvent them.
- **First conversion = `ce-code-review`'s report-only fan-out sub-step** (its `mode:agent` persona-fanout + merge/dedup path), excluding the interactive apply/commit/test stage. Key Decision, already made.
- **Highest leverage = high-recall retrieval (R9)**, but **threshold-triggered** — ranked below present-pain candidates until a recall complaint or store-size trigger fires.
- **R2 baseline is marginal-over-existing-headless/agent-mode**, not over interactive mode. Several candidates already fan out non-interactively to disk.
- **CC-only is accepted** (R15); rework/churn is the **qualitative proxy** impact axis (R3), uninstrumented.

## Target artifact structure (the map's outline — R5/R6)

1. **Summary + how to read** — spine + criteria + first-conversion call.
2. **Reusable selection criteria** — the hard gate (R1), candidacy axes (R2), prioritization formula (R3). Written so a *future* skill can be scored without re-litigating (Success Criterion 3).
3. **Pattern taxonomy** (R4) — the pattern vocabulary + compositional variants, each with a one-line definition and a pointer to the worked example workflow.
4. **The spine** (R5): **Capture → Retrieve → Maintain → Understand**, with the **review/optimization branch** nested as a Retrieve-consumer / Capture-producer.
5. **Per-candidate rows** (R6) under each phase — schema below.
6. **Prioritization & sequencing** (R3/R7) — ranked list + first-conversion vs highest-leverage split, each ranking's rationale tracing to a STRATEGY.md metric.
7. **Design constraints** (R14 loose-coupling, R15 CC-only) stated concretely enough to *reject* a violating conversion (Success Criterion 4).
8. **Open questions** — the brainstorm's deferred items, attached to the candidates they affect.

### Per-candidate row schema (R6)

| Field | Content |
|---|---|
| Loop phase | Capture / Retrieve / Maintain / Understand / Review-branch |
| Skill | existing (+ path) or net-new |
| Pattern(s) | dominant orchestration pattern(s) from R4 |
| Criteria assessment (R2) | non-interactive gate (pass / split-and-convert-substep); fan-out volume; context-offload value *marginal over current headless/agent mode*; rigor upside; repeatability; structured-output contract |
| Impact | qualitative rating + one-line rationale tracing to loop-adoption / learnings-reuse / rework-churn |
| Conversion mode | wholesale vs sub-step inside an interactive shell |

## Work plan (sequenced)

### Step 1 — Per-candidate codebase research

For each candidate below, read the skill/agent source and extract the R2 facts grounded in *actual current behavior* — especially the existing headless/agent baseline (R2's stated comparison point). This is what makes the assessments trustworthy rather than asserted.

| Phase | Candidate | Source to read | Verify in source |
|---|---|---|---|
| Capture | batch-learning-capture (net-new, behind `ce-compound`) | `plugins/compound-engineering/skills/ce-compound/` | current trigger (confirm one-at-a-time bottleneck), worth-keeping gate, write path + dedup against `docs/solutions/` |
| Retrieve | `ce-learnings-researcher` (agent seam) | `plugins/compound-engineering/agents/ce-learnings-researcher.md` | current search modes (grep/frontmatter), whether it verifies against live code; note R9 threshold-trigger + ~30-file store |
| Maintain | `ce-compound-refresh` | `plugins/compound-engineering/skills/ce-compound-refresh/` | interactive ambiguity gate, **existing headless "mark stale, never destructive" rule** (R10 safety invariant), current selective-narrow scope |
| Understand | CONCEPTS.md refresh (net-new) | `CONCEPTS.md` + how it's seeded today | current incremental per-learning seeding it would replace |
| Review | `ce-code-review` **(first conversion)** | `plugins/compound-engineering/skills/ce-code-review/` | `mode:agent` path, per-persona `/tmp` JSON staging, merge/dedup, structured-output contract |
| Review | `ce-optimize` | `plugins/compound-engineering/skills/ce-optimize/` | loop-until-done + judge-panel surface |
| Review | `ce-doc-review` | `plugins/compound-engineering/skills/ce-doc-review/` | persona fan-out, headless mode, safe_auto rubric |
| Review | `ce-plan` deepening (sub-step) | `plugins/compound-engineering/skills/ce-plan/references/deepening-workflow.md` | the 5.3 deepening fan-out; non-interactive sub-step boundary |
| Review | `ce-ideate` evaluate (sub-step) | `plugins/compound-engineering/skills/ce-ideate/` | generate-and-filter + tournament evaluate half |
| Review | `ce-resolve-pr-feedback` | `plugins/compound-engineering/skills/ce-resolve-pr-feedback/` | parallel thread-eval, classify-and-act shape |
| Review | `ce-simplify-code` | `plugins/compound-engineering/skills/ce-simplify-code/` | fan-out-synthesize surface |
| Net-new | work-vs-plan verification | relates to `ce-work` + plan/git state | classify each plan task done/remaining/drifted vs repo |
| Net-new | tournament plan drafter | relates to `ce-plan` | draft-from-N-angles → judge → synthesize |

### Step 2 — Write criteria + taxonomy (R1–R4)

Lift the framework from the brainstorm into reusable, standalone form. The gate (R1) and axes (R2) must be applicable to a *new* skill cold — a reader scoring a future candidate should not need the brainstorm open.

### Step 3 — Build the spine + rows (R5–R13)

Place each researched candidate under its phase using the row schema. Nest the review/optimization branch inside the spine (it consumes Retrieve, produces into Capture). Carry R10's safety invariant and R9's threshold-trigger **verbatim** into their rows.

### Step 4 — Prioritize (R3/R7)

Rank by impact × fan-out × rigor, gated by R1, with each ranking's one-line qualitative rationale tied to a STRATEGY metric. State first-conversion (`ce-code-review` sub-step) and highest-leverage (R9, threshold-conditional) as the **two distinct** answers R7 requires.

### Step 5 — Constraints + open questions (R14/R15 + deferred)

Write loose-coupling and CC-only as reject-test-able rules. Attach each deferred brainstorm question to its candidate **as a recorded open question, not a resolution** (they're conversion-time, hence downstream):

| Brainstorm deferred question | Where it lands in the map |
|---|---|
| First-conversion sequencing (R7, user decision) | Resolved by Key Decision → stated as the recommendation, not left open |
| Batch-capture trigger + write-time dedup (R8) | Open question on the Capture row |
| "Semantic" retrieval meaning / index need (R9) | Open question on the Retrieve row |
| Non-CC broken-orchestration mechanism (R15) | Open question in the Design-constraints section |
| Corpus-audit safe automation boundary (R10) | Invariant stated; boundary-tuning noted as conversion-time open question |

### Step 6 — Validate against Success Criteria

Confirm:

- (a) a planner can start the first conversion without re-deriving — every candidate carries phase / pattern / criteria / impact;
- (b) every ranking traces to a named STRATEGY metric via stated rationale, acknowledging rework/churn isn't instrumented;
- (c) criteria are reusable on a fresh skill;
- (d) loose-coupling (R14) is concrete enough to reject a violating conversion.

## Reference: worked pattern exemplar

`~/.claude/workflows/mine-claude-md-from-sessions.js` — a complete dynamic workflow demonstrating **parallel mine (fan-out) → pipelined adversarial verify → loop-until-dry → synthesize**. Point the taxonomy section at it so readers see the patterns as live code, not abstractions, and so the map's "these patterns are available now" claim is grounded.

## Open decision (non-blocking)

The brainstorm flags first-conversion *sequencing* as a user decision (R7): ship `ce-code-review` first to prove the pattern (low risk) vs. lead with R9 retrieval (higher leverage, higher risk). The brainstorm's Key Decision already recommends **`ce-code-review` first**, and the map will state that recommendation. If it should instead present both as an unresolved fork for a later call, flag it and Step 4 will record it that way.
