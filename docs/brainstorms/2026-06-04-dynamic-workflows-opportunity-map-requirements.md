---
date: 2026-06-04
topic: dynamic-workflows-opportunity-map
---

# Dynamic Workflows: Opportunity Map + Selection Criteria

## Summary

Produce an opportunity map and reusable selection criteria for moving compound-engineering's fan-out-heavy skill steps onto Claude Code dynamic workflows. The map is organized around the compounding memory loop (capture → retrieve → maintain → understand) as its spine, classifies each candidate by which orchestration pattern it fits, and surfaces net-new workflow opportunities the patterns reveal. This brainstorm delivers the prioritized map and criteria; the conversions themselves are downstream.

---

## Problem Frame

Engineering work across the plugin's core loop (ideate → brainstorm → plan → work) loses progress and fractures context: a session that solves several things captures only what the user remembers to document, intermediate fan-out results flood the main context window, and there's no reliable read on what's done vs. remaining. The result is rework and re-discovery — the exact opposite of compounding.

**Evidence status:** this pain is currently a maintainer-observed hypothesis, not a measured failure — the rework/churn metric it maps to is uninstrumented today (see `STRATEGY.md`). Until that signal exists, treat the first conversion as a probe that produces it rather than committing the full map on the strength of the asserted pain alone.

Two facts make this addressable now. First, Claude Code shipped dynamic workflows: JavaScript scripts that orchestrate dozens-to-hundreds of subagents in the background, holding intermediate results in script variables so the main context receives only the final answer. Second, many of the plugin's most valuable skills already orchestrate parallel subagents by hand in prose — and the plugin's memory loop, which is the literal compounding mechanism, is bottlenecked in ways workflows directly relieve. The plugin has no workflow integration today; this is the first pass at deciding where it belongs.

---

## Requirements

**Selection criteria and pattern taxonomy**

- R1. Define the hard gate for workflow candidacy: the step must be a **non-interactive batch** (fan out → collect → synthesize with no user input mid-run). Workflows take no mid-run user input; any step needing sign-off mid-stream is excluded or split so only its non-interactive sub-step converts.
- R2. Define the candidacy criteria beyond the gate: fan-out volume, context-offload value (how much intermediate output currently pollutes context), rigor upside (would the step be more trustworthy with adversarial verify / dedup / multi-angle / loop-until-dry), repeatability (worth codifying because it runs often), and a bounded structured-output contract. Assess context-offload value and rigor upside as the **marginal gain over each candidate's existing headless/agent mode**, not over its interactive mode — several candidates (`ce-compound`, `ce-compound-refresh`, `ce-code-review`) already fan out non-interactively and stage intermediate output to disk (e.g., `ce-code-review` writes per-persona JSON to `/tmp` and returns compact results), so the real increment is measured against that baseline.
- R3. Define the prioritization formula: rank candidates by impact on rework / context-fracture × fan-out volume × rigor upside, gated by R1. The impact axis is an explicit **qualitative judgment proxy**, not a measured value — rework/churn is uninstrumented today (see `STRATEGY.md` and Success Criteria). Portability is **not** a ranking axis (see R15).
- R4. Adopt the orchestration pattern taxonomy as the classification spine for every candidate: fanout-and-synthesize, adversarial-verification, generate-and-filter, tournament, loop-until-done/dry, classify-and-act, plus compositional variants (multi-modal sweep, perspective-diverse verify, completeness-critic, judge-panel). Each candidate names the pattern(s) it maps to, not a binary "fits/doesn't."

**Opportunity map structure**

- R5. Organize the map around the compounding loop as its spine: Capture → Retrieve → Maintain → Understand, with the review/optimization fan-out conversions as one branch inside it (they are consumers of Retrieve and producers into Capture).
- R6. For each candidate, record: loop phase, skill (existing or net-new), dominant pattern(s), the criteria assessment from R2, an impact rating, and whether it converts wholesale or as a sub-step inside an interactive shell.
- R7. Name a recommended **first conversion** (lowest-risk, pattern-proving) distinct from the **highest-leverage** candidate, since de-risking and impact may point at different items (see Key Decisions).

**Memory-loop candidates (the spine)**

- R8. Capture — batch-learning-capture workflow: sweep a whole session / PR / time-window, fan out over candidate learnings, filter by a worth-keeping gate, and write all qualifying learnings. Relieves the human-triggered, one-at-a-time bottleneck in `ce-compound`. Patterns: fanout-and-synthesize + generate-and-filter.
- R9. Retrieve — high-recall retrieval workflow behind the existing `ce-learnings-researcher` seam: search multiple ways in parallel (module / tag / symbol / semantic / recency), synthesize, then adversarially verify each surfaced learning is still true against current code. Patterns: multi-modal sweep + adversarial-verification. **Threshold-triggered:** rank this below present-pain candidates until an activation condition is crossed (an observed recall complaint, or the store exceeding a set size); its highest-leverage status is conditional on that trigger, since the recall problem is anticipatory at the current store size (see Key Decisions and Dependencies).
- R10. Maintain — corpus-audit workflow: classify every learning in `docs/solutions/` (keep / update / replace / archive / merge), detect contradictions and duplicates across the whole set, verify against code, loop until dry. Scales `ce-compound-refresh` from selective-narrow to corpus-wide. Patterns: classify-and-act + loop-until-done. **Safety invariant:** because workflows take no mid-run input, this workflow forfeits `ce-compound-refresh`'s interactive ambiguity gate; it must adopt that skill's existing headless rule — mark ambiguous entries stale, never destructively archive/replace/merge on ambiguity — as a hard invariant rather than treating the automation boundary as fully open (cf. Outstanding Questions).
- R11. Understand — codebase-map refresh workflow: fan out over subsystems to rebuild `CONCEPTS.md` / an architecture-and-conventions map comprehensively, replacing the incremental per-learning seeding. Pattern: fanout-and-synthesize.

**Review / optimization branch and loop-continuity net-new**

- R12. Include the review/optimization conversion candidates with their patterns: `ce-code-review` (fanout-synthesize + adversarial-verify + loop-until-dry), `ce-optimize` (loop-until-done + judge-panel), `ce-doc-review` (fanout-synthesize + adversarial-verify), `ce-plan` deepening (tournament + adversarial-verify, sub-step), `ce-ideate` evaluate (generate-and-filter + tournament, sub-step), `ce-resolve-pr-feedback` (classify-and-act), `ce-simplify-code` (fanout-synthesize).
- R13. Include net-new loop-continuity workflows the patterns reveal — notably a **work-vs-plan verification** workflow that classifies each plan task done/remaining/drifted against the actual repo state (classify-and-act), directly attacking the done-vs-remaining pain — and a **tournament-based plan drafter** (draft from multiple angles → judge → synthesize).

**Design constraints the conversions must honor**

- R14. Loose-coupling principle: skills couple to the memory loop only through thin read (retrieval) and write (capture) seams, never deep runtime integration. Every converted skill must keep working when the knowledge store is empty. A conversion swaps the workflow *behind* a seam; it does not make the skill absorb or depend on the loop.
- R15. Claude-Code-only is accepted: workflow-based steps are a CC-exclusive capability. Conversions owe no graceful-degradation fallback to non-CC targets, but a converted skill must not emit broken orchestration instructions on those targets (mechanism deferred to planning).

---

## Success Criteria

- A planner can pick up the map and start the first conversion without re-deriving which skills qualify, which pattern each uses, or why one is ranked first — every candidate carries phase, pattern, criteria assessment, and impact.
- The map's prioritization traces to the named `STRATEGY.md` metrics (loop adoption, learnings reuse, rework/churn) via an explicit qualitative rationale per candidate — acknowledging rework/churn is not yet instrumented — so a reviewer can check each ranking's stated reasoning rather than appealing to numbers that do not yet exist.
- The criteria are reusable: a future skill can be assessed against R1–R3 to decide candidacy without re-litigating the framework.
- The loose-coupling principle (R14) is concrete enough that a reviewer can reject a conversion that violates it.

---

## Scope Boundaries

- The conversions themselves are out of scope — this brainstorm produces the prioritized map and criteria; the skill rewrites are downstream (`/ce-plan` + execution).
- The interactive dialogue phases (`ce-brainstorm`, `ce-plan` conversation, the conversational halves of `ce-ideate`) are excluded by the R1 non-interactive gate — they are not conversion candidates.
- Retiring the non-CC converter targets is out of scope. It is a strategy-level change that contradicts `STRATEGY.md` track #3; route it to `/ce-strategy` separately if pursued.
- Treating the done-vs-remaining pain as a durable-state / task-ledger redesign is out of scope here; it is addressed only insofar as the R13 work-vs-plan verification workflow covers it.
- Building a meta-skill that helps users author CE-flavored workflows, and teaching the converter to handle workflow-based skills, were considered and set aside (rejected in favor of converting existing skills).

---

## Key Decisions

- **Spine as organizing principle, not coupling**: the compounding loop organizes and prioritizes the map; it does not become a runtime dependency. Chosen because organizing principle and dependency are independent — the spine gives prioritization leverage without a fragile web of coupled skills.
- **First conversion ≠ highest leverage**: the map names both. Recommended first conversion is `ce-code-review`'s **report-only fan-out sub-step** (persona fan-out + merge/dedup — its existing `mode:agent` path), explicitly excluding the interactive apply/commit/test stage which stays in the interactive shell — the most mature existing orchestration, clearest structured-output contract, lowest risk to prove the pattern. Highest *leverage* is the high-recall retrieval workflow (R9), because it sits behind a seam every consumer skill uses — which is also why it is riskier to do first.
- **Memory loop is the highest-leverage domain**: it is the compounding mechanism and where two of three `STRATEGY.md` metrics live, so it earns the spine rather than being a peer section.
- **CC-only accepted**: workflow conversion is a Claude-Code-exclusive capability; non-CC parity is not owed.

---

## Dependencies / Assumptions

- Dynamic workflows require Claude Code v2.1.154+ and are a research-preview primitive; behavior and limits (16 concurrent agents, 1000/run, no mid-run input) may shift. The map should not over-fit to current numeric caps.
- The current store is ~30 files in `docs/solutions/`; recall problems in R9 are anticipatory (they bite at hundreds of files), not yet observed. Flagged as an assumption, not a measured failure.
- `ce-learnings-researcher` and `ce-compound` already provide the thin read/write seams R14 depends on; conversions build behind them rather than replacing them.

---

## Outstanding Questions

### Deferred to Planning

- [Affects R7][User decision] First-conversion sequencing: ship `ce-code-review` first to prove the pattern (low risk), or lead with the high-recall retrieval workflow as the spine's keystone (higher leverage, higher risk)? Deferred to `ce-plan` to decide with implementation context.
- [Affects R8][Needs research] What is the right trigger and boundary for batch-capture — per-PR, per-session, per-time-window — and how does it dedup against existing `docs/solutions/` entries at write time?
- [Affects R9][Technical] What does "semantic" retrieval mean in practice given the current grep-first, frontmatter-based store — does high-recall require an index/embedding layer, or is multi-modal grep + verification enough?
- [Affects R15][Technical] Mechanism for keeping a workflow-based skill from emitting broken orchestration on non-CC targets (guard, gate, or converter-level handling).
- [Affects R10][Needs research] Safe automation boundary for corpus-audit's archive/replace actions — how much can run unattended vs. needing a human gate, given workflows can't pause for sign-off.
