---
date: 2026-06-04
topic: dynamic-workflows-opportunity-map
type: opportunity-map
origin: docs/brainstorms/2026-06-04-dynamic-workflows-opportunity-map-requirements.md
related:
  - docs/plans/2026-06-04-dynamic-workflows-opportunity-map-plan.md
  - docs/plans/2026-06-04-001-feat-ce-code-review-workflow-fanout-plan.md
---

# Dynamic Workflows: Opportunity Map + Selection Criteria

## 1. Summary + how to read

This map decides **where Claude Code dynamic workflows belong inside the compound-engineering plugin** — which fan-out-heavy skill steps should move off hand-orchestrated prose and onto JavaScript workflow scripts that fan out subagents in the background and return only a final answer.

It is organized around the **compounding memory loop** as its spine — **Capture -> Retrieve -> Maintain -> Understand** — with the review/optimization conversions nested as a branch inside it (they consume Retrieve and produce into Capture). Each candidate is scored against a reusable selection framework (§2), classified by orchestration pattern (§3), placed under its loop phase with a per-candidate row (§4–5), and ranked (§6). Design constraints that any conversion must honor are stated as reject-tests (§7), and the brainstorm's deferred questions are attached to the candidates they affect (§8).

**Three things to know before reading:**

1. **First conversion is already done.** `ce-code-review`'s report-only `mode:agent` fan-out shipped as a dynamic workflow (PR #2). It is the worked example this map points at as live proof — not a proposal. See §3 and the Review-branch rows.
2. **First conversion != highest leverage.** The recommended *first* conversion (de-risking, pattern-proving) is `ce-code-review`'s sub-step. The highest-*leverage* candidate is high-recall **Retrieve** (R9) — but it is **threshold-gated** and ranked below present-pain candidates until its trigger fires. These are two distinct answers; §6 keeps them separate.
3. **The baseline is headless/agent mode, not interactive mode.** Several candidates (`ce-compound`, `ce-compound-refresh`, `ce-code-review`, `ce-doc-review`) already fan out non-interactively and stage intermediate output to disk. A conversion's value is the **marginal gain over that existing baseline**, not over interactive mode. Rows assess the increment, not the absolute.

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
- **Richer pattern reference (CC-local, global workflow):** `~/.claude/workflows/mine-claude-md-from-sessions.js` — demonstrates **parallel mine (fan-out) -> pipelined adversarial-verify -> loop-until-dry -> synthesize** in one script. Use it to see the rigor patterns (`adversarial-verification`, `loop-until-dry`) the first conversion deliberately *deferred*. (Lives in user home, not the repo — a personal example, not a portable artifact.)

---

## 4. The spine

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

   (*) = first conversion, landed (PR #2)
```

The loop earns the spine because it is the literal compounding mechanism, and two of three STRATEGY metrics (Loop adoption, Learnings reuse) live in it. The review/optimization candidates are a **branch**, not a peer section: they read prior learnings (Retrieve) and emit new ones (Capture).

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

### 5.2 Retrieve

**high-recall retrieval** — workflow behind the `ce-learnings-researcher` seam (R9) — **HIGHEST LEVERAGE, THRESHOLD-GATED**
- **Source:** `plugins/compound-engineering/agents/ce-learnings-researcher.md`
- **Pattern(s):** multi-modal-sweep + adversarial-verification
- **Criteria (R2):** *Gate:* passes — retrieval is non-interactive, called as an agent seam by `ce-plan`, `ce-code-review`, `ce-ideate`, `ce-optimize`. *Baseline:* today it is **grep-first, ~4 search angles** (title / tags / module / problem_type), executed as a pre-filter then sequential scoring/read; output is **prose** (≤5 findings), no JSON envelope, nothing staged. *Marginal gain:* multi-modal sweep adds 3–4 more parallel angles (symptom, root_cause, component, recency, semantic) **and** an adversarial-verify pass that confirms each surfaced learning is *still true against current code* — which the agent does **not** do today (it only passively flags conflicts "if you notice"). *Fan-out:* 6–8 parallel search angles + per-finding verification. *Structured output:* currently prose; a thin schema could wrap it without breaking the seam. *Rigor upside:* high — verification is the whole point at scale.
- **Threshold trigger (carried verbatim from R9):** "rank this below present-pain candidates until an activation condition is crossed (an observed recall complaint, or the store exceeding a set size); its highest-leverage status is conditional on that trigger, since the recall problem is anticipatory at the current store size." The store is **31 files** in `docs/solutions/` today; grep-first has effectively perfect recall at this scale. Recall pain bites at hundreds of files.
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
- **Impact:** High — directly attacks "no reliable read on what's done vs remaining"; serves **Rework/churn** most directly of any candidate. The brainstorm flags this pain as the one a durable task-ledger redesign would also address (that redesign is out of scope; this workflow covers the pain insofar as classification does).
- **Conversion mode:** wholesale net-new workflow.

**tournament plan drafter** — net-new
- **Relates to:** `ce-plan`
- **Pattern(s):** tournament + judge-panel (draft from N angles -> judge -> synthesize)
- **Criteria (R2):** *Gate:* passes for the draft+judge sub-step; final plan selection/edit stays interactive. *Baseline:* none — `ce-plan` drafts one plan iterated, not N-from-angles judged. *Marginal gain:* draft diversity + judged synthesis. *Fan-out:* N angle-drafts + judge panel. *Structured output:* scored draft set. *Rigor upside:* high — judge panel beats one-attempt-iterated when the solution space is wide.
- **Impact:** Medium — speculative; serves **Loop adoption / Rework/churn**. Lower confidence than work-vs-plan verification.
- **Conversion mode:** sub-step (draft + judge); plan finalization stays interactive.

---

## 6. Prioritization & sequencing

Ranked by **impact × fan-out × rigor, gated by R1**, with marginal-over-baseline applied. Two distinct answers per R7.

### First conversion (recommended) — **`ce-code-review` report-only sub-step** [LANDED]

The brainstorm's Key Decision, now shipped (PR #2). Chosen as first because it is the **most mature existing orchestration, clearest structured-output contract, lowest risk to prove the pattern** — not because it is the highest leverage. It is the template; §3 points at its code as live proof.

### Highest leverage — **high-recall Retrieve (R9)**, threshold-gated

Highest leverage because it sits behind a read seam **every consumer skill uses** — improving it improves `ce-plan`, `ce-code-review`, `ce-ideate`, and `ce-optimize` at once. **But ranked below present-pain candidates** until its trigger fires (recall complaint observed, or store exceeds a set size; 31 files today). Its leverage and its risk share one root: universal dependence.

### Ranked conversion queue

| Rank | Candidate | Phase | Why here (impact × fan-out × rigor, marginal) | STRATEGY metric |
|---|---|---|---|---|
| 0 | ce-code-review sub-step (*) | Review | Done. Pattern-proving template. | Rework/churn |
| 1 | ce-doc-review | Review | Structurally identical to the template; headless envelope already exists -> lowest-risk next, high reuse. | Rework/churn |
| 2 | batch-learning-capture | Capture | Attacks the capture bottleneck; `ce-compound` 3-agent fan-out already exists to multiply; write-time dedup is real rigor upside. | Learnings reuse |
| 3 | work-vs-plan verification | Net-new | Attacks done-vs-remaining pain most directly; no baseline -> full marginal value. | Rework/churn |
| 4 | corpus-audit (Maintain) | Maintain | Headless baseline + safety invariant already specified; corpus-wide loop-until-dry is the increment. | Learnings reuse |
| 5 | ce-plan deepening sub-step | Review | Auto-mode baseline; 8-agent offload + missing adversarial-verify layer. | Rework/churn, Loop adoption |
| 6 | ce-ideate evaluate sub-step | Review | Parallelize the currently-sequential Phase 3 evaluate; clean seam at Phase 6. | Loop adoption |
| 7 | CONCEPTS.md refresh | Understand | Net-new, manual baseline -> full value, but lower frequency. | Loop adoption |
| 8 | tournament plan drafter | Net-new | Speculative; high rigor upside, lower confidence. | Loop adoption |
| 9 | ce-resolve-pr-feedback | Review | Real fan-out, but gate redesign (pre-commit split) is a prerequisite -> risk-adjusted down. | Rework/churn |
| 10 | ce-optimize | Review | Strong skill, **low marginal gain** — already headless/loop/disk-staged. | Rework/churn |
| 11 | ce-simplify-code | Review | Small fixed fan-out, no offload baseline, mutate-in-place is the core. | Rework/churn |
| — | **high-recall Retrieve (R9)** | Retrieve | **Highest leverage, threshold-gated** — promote above rank 1 once the trigger fires. | Learnings reuse |

**Caveat (no silent caps):** every impact rating is a qualitative proxy — `STRATEGY.md` confirms Rework/churn is "qualitative today, not yet instrumented." Treat the queue as reasoned sequencing, not a measured optimum. The first conversion is explicitly a **probe that produces the missing signal**, not a commitment to the full queue on the strength of asserted pain.

---

## 7. Design constraints (reject-tests)

Stated concretely enough to **reject** a violating conversion.

### R14 — Loose coupling

Skills couple to the memory loop **only through thin read (retrieval) and write (capture) seams**, never deep runtime integration. A conversion swaps the workflow *behind* a seam; it does not make the skill absorb or depend on the loop.

**Reject-test:** A conversion violates R14 if **the converted skill stops working when the knowledge store is empty**, or if it reaches *past* the `ce-learnings-researcher` (read) / `ce-compound` (write) seams into loop internals. Concretely: if a reviewer diff shows the skill importing loop state, hard-coding `docs/solutions/` paths outside the capture seam, or failing a "store is empty" smoke test — reject it. The landed `ce-code-review` conversion passes: it sits behind the `mode:agent` seam and depends on no memory-loop state.

### R15 — Claude-Code-only, no broken orchestration on other targets

Workflow-based steps are a CC-exclusive capability. Conversions owe **no graceful-degradation fallback** to non-CC targets (Codex, Cursor, Copilot, Gemini), but a converted skill **must not emit broken orchestration instructions** on those targets.

**Reject-test:** A conversion violates R15 if, when converted to a non-CC target, the skill emits workflow-invocation prose that the target cannot execute (a dangling "invoke the Workflow tool" with no fallback). The landed pattern satisfies this with an **inline guard**: "when the Workflow tool is available, run the workflow; otherwise run the prose dispatch" (`ce-code-review/SKILL.md:353-364`). Any conversion lacking an equivalent availability guard + prose fallback fails the test. **Portability is not a ranking axis (R3)** — but non-broken output on other targets is a hard constraint.

**Note:** Retiring the non-CC targets is explicitly out of scope — it contradicts `STRATEGY.md` track #3 (Cross-platform reach). Route any such proposal to `/ce-strategy` separately.

---

## 8. Open questions (recorded, not resolved)

Conversion-time questions, attached to the candidates they affect. These are downstream — the map records them; `/ce-plan` resolves them.

| Question | Lands on | Status |
|---|---|---|
| First-conversion sequencing (R7, was a user decision) | Review branch | **Resolved** by Key Decision -> `ce-code-review` sub-step first (now landed). Stated as recommendation, not left open. |
| Batch-capture trigger (per-PR / per-session / per-window) + write-time dedup against existing `docs/solutions/` (R8) | Capture row (batch-learning-capture) | Open — needs research at conversion time. |
| What "semantic" retrieval means given the grep-first, frontmatter store — does high-recall need an index/embedding layer, or is multi-modal grep + verification enough? (R9) | Retrieve row | Open — technical, resolve when the threshold trigger fires. |
| Mechanism for keeping a workflow-based skill from emitting broken orchestration on non-CC targets — guard, gate, or converter-level handling (R15) | §7 Design constraints | Open — the landed inline-guard pattern is one answer; whether the converter should handle it is undecided. |
| Safe-automation boundary for corpus-audit's archive/replace actions — how much runs unattended vs. needs a gate (R10) | Maintain row | Invariant stated (stale-marking, §5.3); boundary-tuning is a conversion-time open question. |

---

## Appendix: how this map satisfies its success criteria

- **(a) A planner can start a conversion without re-deriving** — every candidate row carries phase, pattern(s), R2 criteria assessment (marginal-over-baseline), impact, and conversion mode. §6 gives the ordered queue.
- **(b) Rankings trace to STRATEGY metrics** — each queue row names its metric (Loop adoption / Learnings reuse / Rework/churn) with a stated rationale, and the caveat acknowledges Rework/churn is uninstrumented.
- **(c) Criteria are reusable** — §2 is written to score a new skill cold (the gate, six axes, and formula stand alone).
- **(d) R14 is reject-testable** — §7 gives the empty-store smoke test and the seam-reach test a reviewer can apply to kill a violating conversion.
