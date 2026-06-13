---
date: 2026-06-04
topic: dynamic-workflows-opportunity-map
type: opportunity-map
origin: docs/brainstorms/2026-06-04-dynamic-workflows-opportunity-map-requirements.md
revised: 2026-06-13
related:
  - docs/plans/2026-06-04-dynamic-workflows-opportunity-map-plan.md
  - docs/plans/2026-06-04-001-feat-ce-code-review-workflow-fanout-plan.md
  - docs/plans/2026-06-06-001-feat-ce-doc-review-workflow-fanout-plan.md
  - docs/plans/2026-06-07-001-feat-work-vs-plan-verification-probe-plan.md
  - docs/plans/2026-06-08-001-feat-drift-capture-loop-plan.md
  - docs/plans/2026-06-09-001-feat-ce-learning-sweep-mvp-plan.md
  - docs/plans/2026-06-12-001-feat-capture-loop-closure-plan.md
  - docs/adr/0001-per-metric-signal-gate.md
  - CONTEXT.md
---

# Dynamic Workflows: Opportunity Map + Selection Criteria

## 1. Summary + how to read

This map decides **where Claude Code dynamic workflows belong inside the compound-engineering plugin** — which fan-out-heavy skill steps should move off hand-orchestrated prose and onto JavaScript workflow scripts that fan out subagents in the background and return only a final answer.

It is organized around the **compounding memory loop** as its spine — **Capture -> Retrieve -> Maintain -> Understand** — with the review/optimization conversions nested as a branch inside it (they consume Retrieve and produce into Capture). Each candidate is scored against a reusable selection framework (§2), classified by orchestration pattern (§3), placed under its loop phase with a per-candidate row (§4–5), and ranked (§6). Design constraints that any conversion must honor are stated as reject-tests (§7), and the brainstorm's deferred questions are attached to the candidates they affect (§8).

**Three things to know before reading:**

1. **Phase 0 (pattern-proving) is complete.** Two conversions landed — `ce-code-review`'s report-only `mode:agent` fan-out (PR #2) and `ce-doc-review` (PR #6, which successfully reused the template). They are live proof, not proposals. Per [ADR 0001](adr/0001-per-metric-signal-gate.md) they are justified by **de-risking and proving the pattern**, *not* by a STRATEGY metric — the earlier "Rework/churn" tag on them was post-hoc. See §3 and §6 Phase 0.
2. **Sequencing is three per-metric tracks, not one queue.** A 2026-06-07 grilling pass found the original single linear queue was the structural cause of a "march on asserted pain." Work is now **Track A — Rework/churn** (the only one with a hard **Signal gate**, fed by a drift-rate **probe**), **Track B — Learnings reuse** (qualitative; Retrieve carries a **timing trigger**), and **Track C — Loop adoption** (qualitative). The three senses of "gate" (Candidacy / Signal / Timing) are defined in [CONTEXT.md](../CONTEXT.md). §6 has the tracks.
3. **The baseline is headless/agent mode, not interactive mode.** Several candidates (`ce-compound`, `ce-compound-refresh`, `ce-code-review`, `ce-doc-review`) already fan out non-interactively and stage intermediate output to disk. A conversion's value is the **marginal gain over that existing baseline**, not over interactive mode. Rows assess the increment, not the absolute.

**Status (refreshed 2026-06-13):** Since the 2026-06-07 revision, three pieces landed beyond Phase 0. **Track A0 — `work-vs-plan verification` shipped as `ce-verify-work`** (the drift probe). The **drift->capture loop** now persists durable drift events to `docs/drift-events/`. The **read edge `ce-drift-report`** aggregates those events at read time. Separately, the capture bottleneck (Track B0) is largely covered by the new **`ce-learning-sweep`** skill (per-PR sweep -> batched keep/reject -> capture-PR), a different design than B0's original `ce-compound` N-fan-out sketch. **The next action is now the Track A Signal gate decision** (§6): pre-commit threshold `T`, read the aggregate drift via `ce-drift-report`, then authorize (drift >= T) or halt (drift < T) the A1+ conversions. A1+, Track B1 (corpus-audit), and all of Track C remain unstarted; B2 (Retrieve) stays timing-deferred.

**Scope note:** This document records downstream conversion-time questions; it does not resolve them. The conversions themselves are out of scope here — they are downstream `/ce-plan` + execution work.

---

## 2. Reusable selection criteria

Written to be applied to a **new** skill cold — you should be able to score a future candidate without opening the brainstorm.

### 2.1 The hard gate (R1) — non-interactive batch

A step is a workflow candidate **only if** it is a non-interactive batch: fan out -> collect -> synthesize **with no user input mid-run**. Dynamic workflows take no mid-run user input; any step needing sign-off mid-stream is either excluded or **split** so that only its non-interactive sub-step converts.

**Reject-test:** If the step pauses for a human decision between fan-out and result, it fails the gate as a whole. Look for a clean seam where the non-interactive portion (generate / evaluate / classify) can be carved from the interactive portion (decide / apply / converse). If no such seam exists, it is not a candidate.

### 2.2 Candidacy axes (R2) — assessed *marginal over existing headless/agent mode*

Past the gate, score on six axes. **Critical framing:** measure each axis as the increment over the candidate's *current headless/agent baseline*, not over its interactive mode.

| Axis | Question |
|---|---|
| Fan-out volume | How many parallel units does it dispatch? (personas, candidates, threads, subsystems) |
| Context-offload value | How much intermediate output currently pollutes the orchestrator context *beyond what today's headless mode already stages to disk*? |
| Rigor upside | Would it be more trustworthy with adversarial-verify / dedup / multi-angle / loop-until-dry that prose orchestration can't cheaply add? |
| Repeatability | Does it run often enough to be worth codifying as a script? |
| Structured-output contract | Is there a bounded, machine-checkable output schema (JSON envelope, frontmatter) the workflow can return? |
| Existing baseline | Does it already fan out / stage to disk / return compact results? (Sets the marginal-gain denominator.) |

### 2.3 Prioritization formula (R3)

Rank candidates by:

> **impact on rework / context-fracture  ×  fan-out volume  ×  rigor upside**, gated by R1.

- **Impact is an explicit qualitative judgment proxy**, not a measured value — the rework/churn metric it maps to is uninstrumented today (see `STRATEGY.md` §Key metrics: "qualitative today, not yet instrumented"). Every ranking states its rationale and which STRATEGY metric it serves so a reviewer can check the reasoning rather than appeal to numbers that do not exist.
- **Portability is *not* a ranking axis** (see §7, R15). CC-only is accepted.

---

## 3. Pattern taxonomy

The classification vocabulary. Each candidate names the pattern(s) it maps to — not a binary "fits/doesn't."

| Pattern | One-line definition |
|---|---|
| **fanout-and-synthesize** | Dispatch N parallel workers, deterministically merge/dedup their results into one answer. |
| **adversarial-verification** | After a claim is produced, spawn independent skeptics prompted to refute it; kill claims that fail. |
| **generate-and-filter** | Generate many candidates, then filter by a rubric/gate to a bounded survivor set. |
| **tournament** | Score candidates against each other and rank/eliminate; keep winners. |
| **loop-until-done / dry** | Repeat rounds until a target is met or K consecutive rounds surface nothing new. |
| **classify-and-act** | Classify each item into an action bucket, then take the bucketed action per item. |
| **multi-modal-sweep** (variant) | Parallel workers each search a *different way* (module / tag / symbol / semantic / recency), blind to each other. |
| **perspective-diverse-verify** (variant) | Give each verifier a distinct lens (correctness / security / repro) instead of N identical checks. |
| **completeness-critic** (variant) | A final worker asks "what's missing — modality not run, claim unverified, source unread?" |
| **judge-panel** (variant) | N independent judges score the same artifact; aggregate their scores. |

### Worked examples (live code, not abstractions)

- **In-repo, committed, portable:** `plugins/compound-engineering/skills/ce-code-review/workflows/code-review-fanout.js` (+ `merge-findings.js`, `code-review-fanout.generated.js`) — the landed first conversion. Demonstrates **fanout-and-synthesize** with a deterministic merge/dedup module and a confidence-gated survivor set. This is the template every later conversion copies.
- **Richer pattern reference (personal, not in-repo — won't resolve for other readers):** `~/.claude/workflows/mine-claude-md-from-sessions.js` — a CC-local global workflow that demonstrates **parallel mine (fan-out) -> pipelined adversarial-verify -> loop-until-dry -> synthesize** in one script. Cited only to illustrate the rigor patterns (`adversarial-verification`, `loop-until-dry`) the first conversion deliberately *deferred*; it lives in user home and is not a portable artifact.

---

## 4. The spine — the loop-position axis (classification + dependency)

```
   THE COMPOUNDING LOOP

   CAPTURE  -------->  RETRIEVE  -------->  (work happens)
   write seam          read seam
   ce-compound         ce-learnings-researcher
      ^                     |
      |                     v
      |            +-----------------------+
      |            |   REVIEW / OPTIMIZE    |  (the branch)
      |            |   consumes Retrieve,   |
      +------------|   produces Capture     |
   produces into   |   ce-code-review (*)   |
   Capture         |   ce-doc-review        |
                   |   ce-optimize          |
                   |   ce-plan deepening    |
                   |   ce-ideate evaluate   |
                   |   ce-resolve-pr-fb     |
                   |   ce-simplify-code     |
                   +-----------------------+

   MAINTAIN  <--------  UNDERSTAND
   ce-compound-refresh  CONCEPTS.md refresh

   (*) = Phase 0 pattern-proving, landed: ce-code-review (PR #2), ce-doc-review (PR #6)
```

**Two orthogonal axes.** This spine is the **loop-position axis** — *where* each candidate sits in the compounding loop (Capture / Retrieve / Maintain / Understand), plus the **branch** that consumes Retrieve and produces Capture. It is the **classification and dependency** layer: it defines what "loop-internal" means for R14's reject-test (§7) and expresses the consume/produce relationships the track view cannot. **Prioritization is a *different* axis** — the per-metric tracks (§6) decide sequence and gating; loop-position does not. The two cross-cut: Track B collapses Capture+Retrieve+Maintain into one metric, and the branch fragments across Phase 0, Track A, and Track C.

**Highest-leverage domain ≠ goes first.** The memory loop is the highest-*leverage* domain — it is the literal compounding mechanism, and two of three STRATEGY metrics (Loop adoption, Learnings reuse) live in it. But exactly as Retrieve is highest-leverage yet deferred behind its timing trigger, the loop's centrality does **not** put its candidates first: Track A (Rework/churn) goes first because its probe **produces the missing signal**, not because it outranks the loop. Leverage and sequence are separate axes.

---

## 5. Per-candidate rows

Row schema: **Loop phase | Skill (path) | Pattern(s) | Criteria assessment (R2, marginal-over-baseline) | Impact (qualitative + STRATEGY metric) | Conversion mode**.

### 5.1 Capture

**batch-learning-capture** — net-new workflow behind `ce-compound`
- **Source:** `plugins/compound-engineering/skills/ce-compound/`
- **Pattern(s):** fanout-and-synthesize + generate-and-filter (+ latent classify-and-act for track/category routing)
- **Criteria (R2):** *Gate:* passes — capture is one-learning-at-a-time and human-triggered today; the batch sweep is fully non-interactive. *Baseline:* `ce-compound` Full mode **already fans out 3 subagents** (Context Analyzer, Solution Extractor, Related Docs Finder) per learning and writes to `docs/solutions/` with pre-write overlap dedup; subagents return text to the orchestrator, which alone writes files. *Marginal gain:* the increment is **multiplying invocations** — sweeping a whole session/PR/window and fanning over N candidate learnings (N × the existing 3-agent shape), not adding fan-out to a serial step. *Fan-out:* N learnings (unbounded) × per-learning extraction. *Structured output:* strong — frontmatter schema (`references/schema.yaml`: `problem_type`, `component`, `severity` enums; track-specific required fields). *Rigor upside:* generate-and-filter worth-keeping gate + **write-time dedup** against existing `docs/solutions/` (today's dedup is per-invocation, not corpus-aware across a batch).
- **Impact:** High — directly attacks the capture bottleneck ("captures only what the user remembers to document"). Serves **Learnings reuse** (more captured -> more to surface later).
- **Conversion mode:** sub-step inside an interactive shell. Interactive gates that stay out: Full-vs-Lightweight mode choice, session-history consent, the "What's next?" terminal menu.
- **Status (2026-06-13):** Largely covered by `ce-learning-sweep` (per-PR sweep -> batched keep/reject -> capture-PR via `ce-compound mode:headless`, with opt-in `mode:autonomous`) rather than this row's `ce-compound` N-fan-out workflow. The capture-bottleneck intent is addressed via that different design; the batch-capture-as-workflow form sketched here is superseded. See Track B (§6).

### 5.2 Retrieve

**high-recall retrieval** — workflow behind the `ce-learnings-researcher` seam (R9) — **HIGHEST LEVERAGE, THRESHOLD-GATED**
- **Source:** `plugins/compound-engineering/agents/ce-learnings-researcher.md`
- **Pattern(s):** multi-modal-sweep + adversarial-verification
- **Criteria (R2):** *Gate:* passes — retrieval is non-interactive, called as an agent seam by `ce-plan`, `ce-code-review`, `ce-ideate`, `ce-optimize`. *Baseline:* today it is **grep-first, ~4 search angles** (title / tags / module / problem_type), executed as a pre-filter then sequential scoring/read; output is **prose** (≤5 findings), no JSON envelope, nothing staged. *Marginal gain:* multi-modal sweep adds 3–4 more parallel angles (symptom, root_cause, component, recency, semantic) **and** an adversarial-verify pass that confirms each surfaced learning is *still true against current code* — which the agent does **not** do today (it only passively flags conflicts "if you notice"). *Fan-out:* 6–8 parallel search angles + per-finding verification. *Structured output:* currently prose; a thin schema could wrap it without breaking the seam. *Rigor upside:* high — verification is the whole point at scale.
- **Timing trigger (not a Signal gate — see CONTEXT.md):** this gate is about *relevance*, not *evidence* — recall does not bite until the corpus is large, so convert only once it is worth doing. Concrete trigger: **store-size ≥ 150 files** (≈5× today's 31) **or** the first observed recall complaint, whichever fires first. Made real (not theater) by having **`ce-compound-refresh`'s corpus walk emit the `docs/solutions/` file count** (it already walks the whole set), so the count is actually read rather than relying on someone noticing. Grep-first has effectively perfect recall at 31 files; the trigger reclassifies cleanly because Track B is otherwise qualitative (it is a timing trigger, not the Rework/churn Signal gate).
- **Impact:** Highest *leverage* (it sits behind a seam every consumer skill uses) but **deferred** — serves **Learnings reuse**, the metric most directly tied to retrieval quality. Its leverage and its risk come from the same fact: every consumer depends on it.
- **Conversion mode:** sub-step **behind the existing read seam** (R14). The workflow enhances the agent's internal search+verify; callers keep consuming prose. Does **not** replace the seam.

### 5.3 Maintain

**corpus-audit** — scales `ce-compound-refresh` corpus-wide (R10) — **carries a HARD SAFETY INVARIANT**
- **Source:** `plugins/compound-engineering/skills/ce-compound-refresh/`
- **Pattern(s):** classify-and-act + loop-until-done (+ adversarial-verification for cross-doc contradiction detection)
- **Criteria (R2):** *Gate:* passes in headless mode; the interactive ambiguity gate (Phase 3 sign-off) is the part that must stay out / be replaced by the stale-marking rule. *Baseline:* **already has a headless mode** and a subagent fan-out strategy (parallel investigation subagents, sequential replacement subagents); five-action taxonomy Keep / Update / Consolidate / Replace / Delete; Phase 1.75 already detects cross-doc contradictions and duplicates. *Marginal gain:* scales from **selective-narrow to corpus-wide** classification + loop-until-dry contradiction resolution across the whole set. *Fan-out:* one classify per learning (~31 today, growing). *Structured output:* report envelope (Applied / Recommended sections) + frontmatter validation script. *Rigor upside:* loop-until-dry across the corpus until no new contradictions surface.
- **HARD SAFETY INVARIANT (verbatim, `ce-compound-refresh/SKILL.md:25`):** "If classification is genuinely ambiguous (Update vs Replace vs Consolidate vs Delete) or Replace evidence is insufficient, mark as stale with `status: stale`, `stale_reason`, and `stale_date` in the frontmatter... Err toward stale-marking over incorrect action." Because a workflow takes no mid-run input, it **forfeits the interactive ambiguity gate** and must adopt this existing headless rule as a hard invariant: **mark ambiguous entries stale, never destructively archive/replace/merge on ambiguity.**
- **Impact:** Medium-High — keeps the store trustworthy as it grows; serves **Learnings reuse** (stale/contradictory learnings poison retrieval).
- **Conversion mode:** wholesale headless workflow, but bounded by the stale-marking invariant. The safe-automation boundary (how much runs unattended) is a recorded open question (§8).

### 5.4 Understand

**codebase-map refresh** — net-new workflow rebuilding `CONCEPTS.md` (R11)
- **Source:** `CONCEPTS.md` + its current seeding via `ce-compound` Phase 2.4 and `ce-compound-refresh` Phase 4.5
- **Pattern(s):** fanout-and-synthesize + completeness-critic
- **Criteria (R2):** *Gate:* passes — net-new non-interactive batch, no conversational half. *Baseline:* **purely manual/incremental today** — CONCEPTS.md accretes reactively as learnings are processed; there is no automated rebuild. *Marginal gain:* the **entire value is the increment** (manual -> scheduled comprehensive rebuild), unlike candidates with an existing headless baseline. *Fan-out:* ~7 subsystems (agents/, skills/, schemas, instruction files, metadata, core docs, fixtures). *Structured output:* clustered markdown glossary with defined entry format. *Rigor upside:* completeness-critic pass catches core nouns that friction-driven accretion never surfaces.
- **Impact:** Medium — improves agent navigability; serves **Loop adoption** indirectly (a current map lowers the cost of running the chain). Lower frequency than Capture/Retrieve.
- **Conversion mode:** wholesale net-new; no interactive boundary to carve. Writes through the same durable-write seam the maintenance skills use (R14).

### 5.5 Review / optimization branch

**ce-code-review** (report-only `mode:agent` sub-step) — **(*) FIRST CONVERSION, LANDED (PR #2)**
- **Source:** `plugins/compound-engineering/skills/ce-code-review/` (+ `workflows/code-review-fanout.js`, `merge-findings.js`)
- **Pattern(s):** fanout-and-synthesize (live) + classify-and-act + judge-panel + perspective-diverse-verify; **adversarial-verification + loop-until-dry deferred** (parity-first).
- **Criteria (R2):** *Gate:* passes for the report-only sub-step; the interactive apply/commit/test stage (Stage 5c) stays out. *Baseline:* `mode:agent` already staged per-persona JSON to `/tmp/compound-engineering/ce-code-review/{run_id}/{reviewer}.json` and returned a compact envelope. *Marginal gain realized:* intermediate per-persona output **never reaches the orchestrator context** — the workflow holds it in script variables and returns only the merged envelope. *Fan-out:* up to 16 reviewers (4 always-on + ≤7 cross-cutting + ≤2 stack-specific + CE agents). *Structured output:* full JSON envelope (`status`, `verdict`, `scope`, `intent`, `reviewers`, `findings`, `actionable_findings`, `pre_existing_findings`, `coverage`, `artifact_path`, `run_id`). Orchestrator keeps persona *selection* (model judgment); fan-out + merge/dedup are deterministic JS.
- **Impact:** High — the most mature existing orchestration, clearest output contract, lowest risk to prove the pattern; serves **Rework/churn** (review catches defects pre-merge). This is the template.
- **Conversion mode:** sub-step behind the `mode:agent` seam, guarded by Workflow-tool availability with a prose fallback (`SKILL.md:353-364`). **Status: shipped.**

**ce-doc-review** — **recommended SECOND conversion**
- **Source:** `plugins/compound-engineering/skills/ce-doc-review/`
- **Pattern(s):** fanout-and-synthesize + generate-and-filter (confidence gate) + classify-and-act (safe_auto/gated_auto/manual) + perspective-diverse-verify + judge-panel
- **Criteria (R2):** *Gate:* passes for the synthesis sub-step; the walk-through stays interactive. *Baseline:* **headless mode already exists** with a fully-specified structured-text envelope; 2 always-on + ≤5 conditional personas (max 7); confidence-anchor gate + cross-persona promotion + premise-dependency chaining already implemented. *Marginal gain:* nearly identical spine to `ce-code-review` (fanout -> synthesize -> route), **less** complexity (findings only, no fixer subagent, bounded document scope) -> lowest-risk *next* conversion. *Fan-out:* up to 7 personas. *Structured output:* `findings-schema.json` per-persona contract + headless envelope. *Rigor upside:* same as code-review; adversarial persona already conditional.
- **Impact:** Medium-High — improves plan/requirements quality upstream of work; serves **Rework/churn**.
- **Conversion mode:** sub-step (synthesis); walk-through stays interactive. Highest structural reuse from the landed template.

**ce-optimize**
- **Source:** `plugins/compound-engineering/skills/ce-optimize/`
- **Pattern(s):** loop-until-done + tournament + fanout-and-synthesize + generate-and-filter (single-rubric judge, **not** a judge-panel)
- **Criteria (R2):** *Gate:* the experiment loop is non-interactive **after** the Phase 1.7 approval gate — that gate must stay out (it approves baseline + parallel config before any experiment runs). *Baseline:* **already headless and resumable** — worktree-backed parallel experiments, append-only experiment log, crash recovery via `result.yaml` markers, disk-staged state. *Marginal gain:* **low** — the skill already implements loop-until-done with disk-staged state and bounded concurrency; a workflow would re-host existing machinery rather than add a missing capability. *Fan-out:* `max_concurrent` experiments (default 4, ≤6 worktree) + `ceil(sample/batch)` judges. *Structured output:* measurement JSON + experiment-log YAML. *Rigor upside:* modest — degenerate gates + judge already present.
- **Impact:** Medium — high-value when used, but **low marginal gain** from conversion; serves **Rework/churn**. Ranked low for *conversion* despite being a strong skill, because its baseline already captures most of the benefit.
- **Conversion mode:** sub-step at best (the experiment-batch loop), behind the Phase 1.7 gate.

**ce-plan deepening** (sub-step)
- **Source:** `plugins/compound-engineering/skills/ce-plan/references/deepening-workflow.md`
- **Pattern(s):** fanout-and-synthesize + classify-and-act (deterministic section-to-agent mapping); **tournament + adversarial-verify are upside, not present**
- **Criteria (R2):** *Gate:* passes for 5.3.3–5.3.5 (scoring + dispatch); the interactive accept/reject at 5.3.6b stays out. *Baseline:* **already runs in auto mode** (non-interactive, synthesizes findings directly) with optional artifact-backed scratch staging; deterministic 1–3 agents per section, capped at 8. *Marginal gain:* offload the 8-agent fan-out from orchestrator context + add the missing rigor layer (adversarial-verify findings before synthesis — currently absent; conflict resolution is passive prose). *Fan-out:* up to 8 personas. *Structured output:* bounded artifact (3–7 findings, source-backed) but prose, no JSON schema. *Rigor upside:* notable — no internal validation loop today.
- **Impact:** Medium — strengthens plans pre-execution; serves **Rework/churn** and **Loop adoption** (better plans -> more chain usage).
- **Conversion mode:** sub-step (5.3.3–5.3.5 + dispatch); synthesis (5.3.7) and the interactive review (5.3.6b) stay out.

**ce-ideate evaluate** (sub-step)
- **Source:** `plugins/compound-engineering/skills/ce-ideate/`
- **Pattern(s):** generate-and-filter + tournament (+ fanout-and-synthesize for the generate half)
- **Criteria (R2):** *Gate:* the generate half (Phase 2) and evaluate half (Phase 3) are non-interactive; the conversational refine/handoff (Phase 6) is excluded. *Baseline:* generation **already fans out 6 parallel agents** (~36–48 ideas) and checkpoints to `/tmp/compound-engineering/ce-ideate/<run-id>/`; **but Phase 3 filtering is orchestrator-driven, NOT fanned out** (the skill explicitly says "do not dispatch sub-agents for critique"). *Marginal gain:* the convertible increment is parallelizing/rigorizing the Phase 3 evaluate pass (per-idea adversarial critique + tournament ranking) that currently runs sequentially in orchestrator context. *Fan-out:* 6 generators (live) + N per-idea evaluators (new). *Structured output:* per-idea + per-survivor contracts already defined. *Rigor upside:* moderate — ranking exists; adversarial re-critique does not.
- **Impact:** Medium — sharper ideation upstream; serves **Loop adoption** (ideate is loop entry). Sub-step only; the dialogue is the point of the skill.
- **Conversion mode:** sub-step (Phase 3 evaluate); Phases 0–1 intake and 4–6 dialogue stay out.

**ce-resolve-pr-feedback** — **higher-risk: needs a boundary redesign**
- **Source:** `plugins/compound-engineering/skills/ce-resolve-pr-feedback/`
- **Pattern(s):** classify-and-act + fanout-and-synthesize + loop-until-done
- **Criteria (R2):** *Gate:* **conditional fail today** — the skill **pushes code before** surfacing `needs-human` decisions (step 9 is after commit). A clean non-interactive sub-step requires splitting "fix" into stage-diffs -> (gate) -> commit, or a dry-run mode. *Baseline:* already fans out one `ce-pr-comment-resolver` agent per review thread (unbounded, batched 4s), with a 6-verdict rubric and combined validation. *Marginal gain:* fan-out offload is real, but the **gate redesign is a prerequisite**, raising risk. *Fan-out:* one agent per thread/comment (unbounded). *Structured output:* per-thread verdict envelope. *Rigor upside:* loop-until-done already present (2 fix-verify cycles).
- **Impact:** Medium — but **risk-adjusted down**: the interactive boundary is entangled with the mutate-and-push path, unlike the clean report-only seams of code-review/doc-review.
- **Conversion mode:** sub-step **only after** introducing a pre-commit gate or dry-run mode. Not a drop-in.

**ce-simplify-code** — **lowest priority of the branch**
- **Source:** `plugins/compound-engineering/skills/ce-simplify-code/`
- **Pattern(s):** fanout-and-synthesize + generate-and-filter + loop-until-done (verify/revert) + classify-and-act
- **Criteria (R2):** *Gate:* the review sub-step (3 reviewers) is non-interactive; apply is in-place but agent-driven (no sign-off). *Baseline:* **no headless mode, no JSON contract** — interactive-only, applies fixes in place and verifies. Already fans out **3 fixed parallel agents** (Reuse / Quality / Efficiency). *Marginal gain:* a report-only sub-step would be **net-new** (no baseline to exceed) but the fan-out is small and fixed (3), and the apply step is the valuable part — which can't convert (it mutates). *Fan-out:* 3 (fixed). *Structured output:* none today (markdown summary). *Rigor upside:* low — behavior-preservation gate already at apply time.
- **Impact:** Low-Medium — small fixed fan-out, no offload baseline, mutate-in-place is the core. Serves **Rework/churn**.
- **Conversion mode:** sub-step (the 3-reviewer findings pass) at most; weakest case in the branch.

### 5.6 Loop-continuity net-new (R13)

**work-vs-plan verification** — net-new, attacks the done-vs-remaining pain directly
- **Relates to:** `ce-work` + plan/git state
- **Pattern(s):** classify-and-act
- **Criteria (R2):** *Gate:* passes — fully non-interactive classification pass. *Baseline:* none — there is no reliable automated read on done-vs-remaining today (the named pain). *Marginal gain:* entire value is the increment. *Fan-out:* one classify per plan task (done / remaining / drifted vs actual repo state). *Structured output:* per-task verdict table. *Rigor upside:* verify each task's claim against the repo, not the plan's checkboxes.
- **Impact:** High — but be precise about *what* it measures (see [ADR 0001](adr/0001-per-metric-signal-gate.md)). Its output is a **drift rate** — the fraction of plan tasks claimed done but the repo diverged — which is a *rework proxy*, **not** the same as "done-vs-remaining" (that is mere progress). This is **Track A's probe**: it produces the Rework/churn **Signal gate**'s reading. The reading is **read-time-derived** by aggregating `ce-compound`-captured drift learnings + session history — never stored as a number (that would reopen the out-of-scope task-ledger). The gate's first read is an **absolute threshold T pre-committed before this runs** (drift ≥ T authorizes Track A; drift < T halts it). The durable task-ledger redesign the brainstorm flags is out of scope; this covers the pain insofar as classification does.
- **Conversion mode:** wholesale net-new workflow. **LANDED as `ce-verify-work`** (2026-06-07; `work-vs-plan-fanout.js` + `drift-rollup.js`, guarded with a prose fallback). The drift->capture loop (durable events in `docs/drift-events/`, 2026-06-08) and the read edge (`ce-drift-report`, 2026-06-12) also landed. **Track A0 complete** — the open step is now the Signal gate decision (§6).

**tournament plan drafter** — net-new
- **Relates to:** `ce-plan`
- **Pattern(s):** tournament + judge-panel (draft from N angles -> judge -> synthesize)
- **Criteria (R2):** *Gate:* passes for the draft+judge sub-step; final plan selection/edit stays interactive. *Baseline:* none — `ce-plan` drafts one plan iterated, not N-from-angles judged. *Marginal gain:* draft diversity + judged synthesis. *Fan-out:* N angle-drafts + judge panel. *Structured output:* scored draft set. *Rigor upside:* high — judge panel beats one-attempt-iterated when the solution space is wide.
- **Impact:** Medium — speculative; serves **Loop adoption / Rework/churn**. Lower confidence than work-vs-plan verification.
- **Conversion mode:** sub-step (draft + judge); plan finalization stays interactive.

---

## 6. Sequencing — Phase 0 + three per-metric tracks

> **Revised 2026-06-07** after a grilling pass ([ADR 0001](adr/0001-per-metric-signal-gate.md), [CONTEXT.md](../CONTEXT.md)). The original single linear queue (rank 0–11) was the structural cause of a "march on asserted pain": it ranked candidates across incommensurable metrics as if they competed for one slot, and it hid which gate governs which candidate. The work is **three metric-tracks**, each with its own gate, preceded by a completed **pattern-proving phase**. Tracks do not buy parallel execution (one maintainer, serial) — they buy a **legible gate** and make the march impossible by construction.

### Phase 0 — pattern-proving (COMPLETE)

`ce-code-review` (PR #2) and `ce-doc-review` (PR #6). Justified by **de-risking and proving the workflow pattern** — most mature orchestration, clearest output contract, successful template reuse on the second conversion — **not** by any STRATEGY metric. The earlier queue tagged these "Rework/churn"; that was post-hoc (ADR 0001). They sit **outside** the three tracks. The pattern is now proven; every subsequent conversion must be justified by its track.

### Track A — Rework/churn (drift-gated)

The **only** track with a hard **Signal gate**. STRATEGY flags Rework/churn as "qualitative today, not yet instrumented," so this track must *produce its signal before it commits*.

| Order | Candidate | Role | Gate |
|---|---|---|---|
| A0 | **work-vs-plan verification** | **LANDED** as `ce-verify-work` (2026-06-07). Produces the per-plan drift reading; durable drift events now persist to `docs/drift-events/` (drift->capture loop, 2026-06-08) and aggregate at read time via `ce-drift-report` (2026-06-12). | done — it *was* the probe |
| GATE | **Signal gate** | **<- NEXT ACTION.** Pre-commit absolute threshold `T`, read the aggregate drift via `ce-drift-report`, then drift >= T -> Track A authorized; drift < T -> **halt Track A, reallocate** to B/C (qualitative work). `T` is committed against the aggregate reading **before the gate is first read** (ADR 0001). The reading mechanism shipped; `T` and the authorize/halt decision are the open step. | — |
| A1+ | ce-plan deepening sub-step; ce-resolve-pr-feedback; ce-optimize; ce-simplify-code | **Not started.** Authorized **only on drift >= T**, ordered by marginal-over-baseline (deepening > resolve-pr > optimize > simplify). | behind the gate |

ce-resolve-pr-feedback additionally needs a pre-commit gate redesign (§5.5); ce-optimize and ce-simplify-code are low-marginal-gain (already headless / small fixed fan-out).

### Track B — Learnings reuse (qualitative; Retrieve carries a timing trigger)

No Signal gate — proceeds on qualitative judgment. STRATEGY names a session-history measurement path for this metric (derivable-but-unbuilt, not a probe-requiring void).

| Order | Candidate | Role | Trigger |
|---|---|---|---|
| B0 | **batch-learning-capture** | **Largely landed** via `ce-learning-sweep` (per-PR sweep -> batched keep/reject -> capture-PR through `ce-compound mode:headless`, opt-in `mode:autonomous`) — a different design than this row's `ce-compound` N-fan-out sketch, attacking the same capture bottleneck. | — |
| B1 | corpus-audit (Maintain) | Headless baseline + stale-marking safety invariant already specified; corpus-wide loop-until-dry is the increment. **Emits the `docs/solutions/` file count** that feeds B2's trigger. | — |
| B2 | **high-recall Retrieve (R9)** | Highest *leverage* of any candidate (every consumer skill reads this seam) but **timing-triggered**. | **Timing trigger:** store-size >= 150 files (≈5× today's 31), read from B1's emitted count; or first observed recall complaint. |

### Track C — Loop adoption (qualitative)

| Order | Candidate | Role |
|---|---|---|
| C0 | CONCEPTS.md refresh | Net-new; manual baseline -> full marginal value; lower frequency. |
| C1 | ce-ideate evaluate sub-step | Parallelize the currently-sequential Phase 3 evaluate; clean seam at Phase 6. |
| C2 | tournament plan drafter | Speculative; high rigor upside, lower confidence. |

**Next action is the Track A Signal gate decision** — A0 (`ce-verify-work`), the drift->capture loop, and the read edge (`ce-drift-report`) have all landed, so the open step is to pre-commit `T`, read the aggregate drift via `ce-drift-report`, and authorize (drift >= T) or halt (drift < T) the A1+ conversions. Track B/C work may proceed in parallel on qualitative grounds.

**Caveat (no silent caps):** only Track A has an evidence gate, and only after A0 produces the drift reading. Track B/C orderings remain qualitative proxies — `STRATEGY.md` confirms Rework/churn is "qualitative today, not yet instrumented." This is reasoned sequencing, not a measured optimum.

---

## 7. Design constraints (reject-tests)

Stated concretely enough to **reject** a violating conversion.

### R14 — Loose coupling

Skills couple to the memory loop **only through thin read (retrieval) and write (capture) seams**, never deep runtime integration. A conversion swaps the workflow *behind* a seam; it does not make the skill absorb or depend on the loop.

**Reject-test — two profiles.** The original single test was written for a *consumer* skill (it cites `ce-code-review`) and **falsely rejects loop-internal candidates**, whose whole purpose is operating on the store. Split it:

- **Consumer conversions** (code-review, doc-review, plan-deepening, ideate-evaluate, resolve-pr-feedback, simplify-code): violate R14 if they **stop working when the store is empty**, or **reach *past* the `ce-learnings-researcher` (read) / `ce-compound` (write) seams into loop internals** — importing loop state, hard-coding `docs/solutions/` paths, or failing a "store is empty" smoke test. The landed `ce-code-review` passes: behind the `mode:agent` seam, no memory-loop state.
- **Loop-internal conversions** (batch-capture, Retrieve, corpus-audit, CONCEPTS): operating on the store **is** the contract, so the path-touching check is **N/A**. They are instead bound by **the seam they implement** — capture goes through `ce-compound`'s write+dedup path (no side-door writes), Maintain honors the stale-marking safety invariant (§5.3), Retrieve never mutates. The "store is empty" smoke test **still applies to all** (capture writes the first entries; Retrieve/audit return empty cleanly).

This is why Q7's wiring is legal: corpus-audit (loop-internal, Maintain seam) may emit the `docs/solutions/` count; the *program's convert-Retrieve-now decision* reads it, so Retrieve-the-skill never reaches for the number.

### R15 — Claude-Code-only, no broken orchestration on other targets

Workflow-based steps are a CC-exclusive capability. Conversions owe non-CC targets (Codex, Cursor, Copilot, Gemini) **no workflow-execution support** — the orchestration itself need not run there. But a converted skill **must still degrade to a working prose fallback** on those targets; it may never emit broken orchestration instructions the target cannot execute.

**Reject-test:** A conversion violates R15 if, when converted to a non-CC target, the skill emits workflow-invocation prose that the target cannot execute (a dangling "invoke the Workflow tool" with no fallback). The landed pattern satisfies this with an **inline guard**: "when the Workflow tool is available, run the workflow; otherwise run the prose dispatch" (`ce-code-review/SKILL.md:353-364`). Any conversion lacking an equivalent availability guard + prose fallback fails the test. **Portability is not a ranking axis (R3)** — but non-broken output on other targets is a hard constraint.

**Note:** Retiring the non-CC targets is explicitly out of scope — it contradicts `STRATEGY.md` track #3 (Cross-platform reach). Route any such proposal to `/ce-strategy` separately.

---

## 8. Open questions (recorded, not resolved)

Conversion-time questions, attached to the candidates they affect. These are downstream — the map records them; `/ce-plan` resolves them.

| Question | Lands on | Status |
|---|---|---|
| Sequencing / first-conversion (R7) | §6 | **Resolved + advanced** per [ADR 0001](adr/0001-per-metric-signal-gate.md): Phase 0 (code-review, doc-review), Track A0 (`ce-verify-work`), the drift->capture loop, and the read edge (`ce-drift-report`) have all landed (2026-06-07 – 2026-06-12). The **next action is the Track A Signal gate decision** (pre-commit `T`, read aggregate drift, authorize/halt A1+) — a judgment step, not a conversion. No longer a single-queue ranking. |
| Batch-capture trigger (per-PR / per-session / per-window) + write-time dedup against existing `docs/solutions/` (R8) | Capture row (batch-learning-capture) | Open — needs research at conversion time. |
| What "semantic" retrieval means given the grep-first, frontmatter store — does high-recall need an index/embedding layer, or is multi-modal grep + verification enough? (R9) | Retrieve row (B2) | Open — technical, resolve when the **timing trigger** fires (store >= 150 files, read from corpus-audit's emitted count). |
| Value of **T**, the pre-committed drift threshold that authorizes/halts Track A | Track A Signal gate (§6) | Open — **now the next action.** The probe (`ce-verify-work`) and the aggregate reading mechanism (`ce-drift-report`) have shipped; `T` must be pre-committed against the aggregate reading **before the gate is first read**, then the authorize/halt decision taken. Pre-commitment is the discipline (ADR 0001). |
| Mechanism for keeping a workflow-based skill from emitting broken orchestration on non-CC targets — guard, gate, or converter-level handling (R15) | §7 Design constraints | Open — the landed inline-guard pattern is one answer; whether the converter should handle it is undecided. |
| Safe-automation boundary for corpus-audit's archive/replace actions — how much runs unattended vs. needs a gate (R10) | Maintain row | Invariant stated (stale-marking, §5.3); boundary-tuning is a conversion-time open question. |

---

## Appendix: how this map satisfies its success criteria

- **(a) A planner can start a conversion without re-deriving** — every candidate row carries phase, pattern(s), R2 criteria assessment (marginal-over-baseline), impact, and conversion mode. §6 gives the per-metric tracks; A0 (`ce-verify-work`) has landed, so the next action is the Track A Signal gate decision.
- **(b) Rankings trace to STRATEGY metrics** — each track *is* a metric (Rework/churn / Learnings reuse / Loop adoption); only Track A carries an evidence gate (drift), and the caveat acknowledges Rework/churn is uninstrumented until A0's probe produces the reading.
- **(c) Criteria are reusable** — §2 is written to score a new skill cold (the gate, six axes, and formula stand alone).
- **(d) R14 is reject-testable** — §7 gives two profiles (consumer vs loop-internal): the empty-store smoke test plus the seam-reach test for consumers, and the seam-contract test for loop-internal conversions.
