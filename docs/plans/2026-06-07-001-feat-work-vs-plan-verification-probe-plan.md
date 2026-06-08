---
status: completed
type: feat
created: 2026-06-07
origin: docs/dynamic-workflows-opportunity-map.md
related:
  - docs/brainstorms/2026-06-04-dynamic-workflows-opportunity-map-requirements.md
  - docs/plans/2026-06-04-001-feat-ce-code-review-workflow-fanout-plan.md
  - docs/plans/2026-06-06-001-feat-ce-doc-review-workflow-fanout-plan.md
  - docs/adr/0001-per-metric-signal-gate.md
  - docs/adr/0002-workflow-conversion-input-contract-validation.md
  - CONTEXT.md
---

# feat: work-vs-plan verification probe (`ce-verify-work`) — Track A0 drift probe

## Summary

Build the opportunity map's **next conversion**: `work-vs-plan verification` (Track A0). A net-new Claude Code dynamic-workflow skill, `ce-verify-work`, that reads one plan document, classifies each Implementation Unit as **done / remaining / drifted / unverifiable** against the *actual repo state* (git history + file/behavior state — never plan checkboxes, which plans deliberately omit), and returns a per-unit verdict table plus a per-plan **drift rate**. This is Track A's Rework/churn **probe**: the per-plan drift rate is a per-run *reading*, **not** the gate signal itself — Track A's gate consumes an *aggregate* across runs, and the capture + aggregation that build that aggregate are deferred (see Problem Frame). The probe-only first cut ships a standalone per-plan diagnostic.

This is the **third** dynamic-workflow conversion. The first two (`ce-code-review`, `ce-doc-review`) proved the pattern; this one reuses their template (skill orchestrator + `workflows/*.js` behind a Workflow-tool guard, deterministic logic in a unit-tested module, mandatory live smoke run) but is the first **net-new** workflow — there is no existing skill to convert and no parity oracle, so correctness is anchored in the verdict contract, seeded fixtures, and variance calibration rather than output parity.

**First cut is probe-only** (user-confirmed): it produces the verdict envelope. Wiring high-drift runs into the `ce-compound` capture seam (so the eventual gate aggregation accumulates data) and the gate-aggregation itself are deferred to follow-up.

**Why `feat`:** a new analytical capability the user could not previously accomplish (automated drift detection across a plan), and the plugin's third workflow surface. Nothing was broken; this is net-new.

---

## Problem Frame

The brainstorm names a concrete pain: across the loop (ideate → brainstorm → plan → work) there is **no reliable read on what's done vs. remaining**, which produces rework and re-discovery. `ce-work` already does an *ad hoc* version of this inline — on resume it checks, one unit at a time in orchestrator context, whether "the unit's work is already present and matches the plan's intent" (`plugins/compound-engineering/skills/ce-work/SKILL.md:202`). That check is unstructured, model-mediated in-context, produces no durable signal, and floods the orchestrator with intermediate reasoning.

This probe formalizes that check into a backgrounded fan-out that returns only a structured verdict, and — critically — distinguishes **drift** (a unit claimed done where the repo diverged: *rework-shaped*) from mere **remaining** progress. Per [ADR 0001](../adr/0001-per-metric-signal-gate.md) and [CONTEXT.md](../CONTEXT.md), Track A's Signal gate reads a drift rate that is *read-time-derived by aggregating `ce-compound`-captured drift learnings across runs* — an **aggregate**, not a single plan's rate. This probe produces the **per-plan readings** that feed that aggregate. The probe-only first cut stops at the per-plan reading: the capture that turns a reading into a durable drift learning, and the aggregation that combines learnings into the gate signal, are both deferred (Scope Boundaries). So this cut ships a standalone per-plan diagnostic — it becomes a gate input only once capture + aggregation land.

**Marginal-over-baseline (R2):** today's baseline is `ce-work`'s in-context, per-unit, prose-only "already present?" check. The increment is: (1) a structured 4-verdict classification with cited evidence; (2) a per-plan **drift rate** that separates rework from progress; (3) context-offload — per-unit classification reasoning is held in the workflow runtime, not the orchestrator; (4) a machine-checkable envelope a future gate can consume.

**Requirements advanced (origin):** R13 (work-vs-plan verification net-new), R1 (non-interactive gate — fully non-interactive classification pass), R2 (context offload), R3 (impact: the Rework/churn probe), R4 (classify-and-act pattern), R14 (loose coupling, consumer profile — works with an empty store, never reaches past the seams), R15 (CC-only workflow path with a guarded prose fallback). Governing decisions: [ADR 0001](../adr/0001-per-metric-signal-gate.md) (drift rate, `T` pre-commitment, Signal gate scope), [ADR 0002](../adr/0002-workflow-conversion-input-contract-validation.md) (`complete`/`degraded`/`invalid_input` envelope, layered validation).

---

## Scope Boundaries

**In scope**
- A new skill `ce-verify-work` that takes one plan document (explicit path, or auto-detect the latest in `docs/plans/`), classifies its Implementation Units, and presents a per-unit verdict table + drift rate.
- A dynamic workflow that fans out classifier agents (batched) and runs a deterministic roll-up, returning the drift envelope context-isolated from the orchestrator.
- A standalone, unit-tested deterministic module: plan-unit parser + verdict roll-up + drift-rate math.
- The verdict contract: a 4-state enum (done / remaining / drifted / unverifiable) with required evidence citation, kept in a `references/` rubric + JSON schema.
- A guarded `ce-verify-work` SKILL.md: workflow when the Workflow tool is available, sequential prose classification otherwise (R15). Layered input-contract validation per ADR 0002.
- A live smoke + variance-calibration eval against seeded fixture plans.
- Converter verification that the skill ships intact (with its fallback) to non-CC targets.

**Out of scope (non-goals)**
- The durable-state / task-ledger redesign — explicitly out per the brainstorm; this covers the done-vs-remaining pain only insofar as stateless classification does.
- The Signal-gate **aggregation** mechanism (combining captured drift learnings + session history into the program-level reading) — that is read-time-derived and downstream.
- Retiring non-CC targets (contradicts `STRATEGY.md` track #3; route to `/ce-strategy`).

**Deferred to Follow-Up Work**
- **Closing the drift→capture loop:** writing a drift learning via the `ce-compound` write seam (direct-write-from-evidence) when drift is high, so the future gate aggregation has data. (User-confirmed deferral; the probe already gathers the cited evidence such a learning would need.)
- **`ce-work` integration:** having `/ce-work` call this probe on resume to seed its "already present?" determination.
- **Session-history "claimed done" signals:** detecting attempt/completion from session transcripts (in addition to git). The first cut is git-only; a unit reworked without a commit touching its declared paths reads as `remaining`, so uncommitted/squashed rework is invisible to the first-cut rate (a coverage gap, stated in Risk Analysis — not a rate bias, since such units fall out of the `done + drifted` denominator entirely). Wiring session-history access (via `ce-sessions`) is deferred — it is platform-specific and not reachable inside a fan-out classifier today.
- **Cross-repo plans:** plans carrying a `**Target repo:**` other than the cwd. First cut assumes the plan targets the current repo.
- Added rigor inside the workflow: adversarial re-verification of `drifted` verdicts; loop-until-dry across ambiguous units.

**Recorded decision (precondition, not code)**
- **Threshold `T`** — the absolute drift threshold that authorizes (drift ≥ T) or halts (drift < T) Track A — is committed against the gate's **aggregate** drift reading (across captured drift learnings), **not** a single plan's probe rate, and must be **pre-committed before that aggregate is first read** (ADR 0001; pre-commitment *is* the discipline). This plan builds neither the capture, the aggregation, nor the gate; it records that `T`'s value *and the object it compares against* (the aggregate) are fixed out-of-band before the signal is trusted. A single per-plan probe rate is a *diagnostic reading*, not a gate decision.

---

## Key Technical Decisions

1. **New guarded skill, not a `ce-work` sub-step.** The probe is a standalone analytical pass runnable against any plan, independent of an execution session — so it needs its own invocable home. Hosting it inside `ce-work` (already large, interactive, stateful) would entangle it; `ce-work` *consuming* the probe is a separate, deferred concern. The skill follows the landed template: orchestrator + `workflows/` behind a Workflow-tool guard. *(origin: R13, R1; precedent: `ce-doc-review/SKILL.md:146-179`)*

2. **Ship to all targets; gate only the workflow path. `ce_platforms` left unset.** The CC-only constraint governs the *workflow runtime*, not skill shipping. The classification has a sensible non-CC fallback (sequential per-unit classification in orchestrator context), so the skill ships everywhere with an inline guard — `Workflow tool available → workflow; else → prose dispatch`. Setting `ce_platforms: [claude]` would diverge from both precedents (which leave it unset and assert it). *(origin: R15; precedent: `tests/doc-review-workflow-parity.test.ts:27-32`)*

3. **Four-verdict classification, with drift separated from progress.** Per-unit verdict ∈ `{done, remaining, drifted, unverifiable}`:
   - `done` — the unit's `**Files:**` are present and its `**Verification:**` is satisfied by current repo state, with cited evidence.
   - `remaining` — no git evidence the unit was attempted (no commit touched its declared paths). *Progress, not rework — excluded from the drift-rate denominator (Key Decision 4).*
   - `drifted` — git evidence the unit was attempted (a commit touched its declared `**Files:**` paths) **but** the repo diverged — Verification unmet, Files partial/deleted — with both the attempt evidence and the divergence cited. *Rework-shaped.*
   - `unverifiable` — **reserved for the highest bar:** the unit's `**Verification:**` is *intrinsically* behavioral/runtime and cannot be settled from static repo state (e.g., "improves latency", "handles edge case X"). A unit with concrete Files and a statically-checkable Verification is **never** unverifiable. Reported separately and excluded from the denominator; a high `unverifiable` fraction flags the run as low-confidence (U4).
   **Ambiguity does not route to `unverifiable`.** When a unit is statically checkable but the done-vs-drifted call is borderline, the classifier makes a conservative `done`/`drifted` call (Key Decision 6) — it does **not** escape to `unverifiable`, which would otherwise become a denominator-shrinking dodge. The fourth state is the research-driven correction to a naive 3-state design (see Risk Analysis). *(grounding: `docs/solutions/skill-design/ce-doc-review-calibration-patterns.md`; adversarial review of the `unverifiable` skew vector)*

4. **Drift rate is over *attempted* units, not all tasks.** `drift_rate = drifted / (done + drifted)` — of the units git evidence shows were attempted *and* that are statically verifiable, the fraction that drifted. `remaining` (never-attempted) and `unverifiable` (not statically settleable) are counted and reported but **excluded from the denominator**: a never-started unit is progress, not rework, and including it would make the rate a function of how far along the plan is rather than how much work needed redoing — a plan probed early would read near-zero drift regardless of actual rework. This makes CONTEXT.md's loose "over total tasks" phrasing precise: drift is "the redo-shaped subset" (CONTEXT.md's own framing), which is the *attempted-and-resolved* set, not all tasks. **`T` is interpreted on this same `done + drifted` basis** — the aggregate it gates on is built from these per-plan readings (see the `T` recorded decision in Scope Boundaries) — and CONTEXT.md's `Drift rate` glossary entry is reconciled to match when this lands (U4). Because excluding `remaining` shrinks the denominator, an early probe can have a tiny `attempted` set (a 1-done/1-drifted plan reads 0.5 from a meaningless sample), so the roll-up emits a **`low_confidence` flag** when `attempted` is below a small floor or the `unverifiable` fraction is high — and `T` must not gate on an unflagged small-N rate. Both the workflow and the prose fallback call the **same `rollupVerdicts` module** — the single source of truth for numerator, denominator, and the flag — so the reported rate cannot diverge across paths or from the verdict table. *(grounding: adversarial review of denominator dilution + small-N volatility; `ce-doc-review-calibration-patterns.md` single-source-of-truth-for-counts)*

5. **Evidence citation is mandatory for done/drifted; "drifted" must be provable.** Each `done` and `drifted` verdict carries a **non-empty** `evidence` array (commit SHAs, repo-relative file paths, diff-hunk references); `remaining` and `unverifiable` verdicts may omit it — matching the U2 schema, which requires evidence only for done/drifted. Every classifier verdict is treated as a *hypothesis anchored to named artifacts*, not a fact — the roll-up recomputes the rate from cited verdicts only. *(grounding: `docs/solutions/best-practices/ce-pipeline-end-to-end-learnings.md`)*

6. **Fan-out classifier agents + deterministic roll-up; units batched.** The workflow fans out classification agents (each handling a **batch** of ~5–7 units to amortize per-dispatch orchestration cost), each returning structured per-unit verdicts + evidence; a pure JS roll-up aggregates them into the drift rate, verdict table, and envelope. **First cut detects "claimed done" from git + file state only** — a commit touched the unit's declared `**Files:**` paths — **never** plan checkboxes and **not** session history (deferred; see Scope Boundaries). Because the repo has no U-ID-in-commit convention, "a commit touching the paths" is the attempt signal, not "a commit naming the unit"; when a touched path may belong to another unit, the classifier adjudicates by the unit's own `**Verification:**`, conservatively. Borderline statically-checkable units take the **conservative `done`/`drifted` call** (lean `drifted` over a false `done`, which would hide rework) — they do **not** escape to `unverifiable` (Key Decision 3). "Recently changed" is **not** a done-proxy — the signal is whether the claimed artifact exists and satisfies Verification. *(grounding: `codex-delegation-best-practices.md` batching; `compound-refresh-skill-improvements.md` conservative confidence + missing-artifact signal; feasibility + adversarial review of the session-history access gap)*

7. **Deterministic logic is a pure, unit-tested module, inlined via the build-step triad.** `drift-rollup.js` exports `parsePlanUnits(planText)` and `rollupVerdicts(verdicts)` — both pure, both `bun test`-covered, both reused by the workflow (inlined, since the Workflow runtime cannot import siblings) and by the orchestrator's pre-dispatch validation. This mirrors the `merge-findings.js` → `code-review-fanout.generated.js` pattern, right-sized (the module is smaller than code-review's). The plan-unit parser is net-new ground for the repo and is the highest-value thing to test in isolation. *(precedent: `scripts/build-doc-review-workflow.ts`, `plugins/compound-engineering/skills/ce-code-review/workflows/merge-findings.js`)*

8. **Layered input-contract validation (ADR 0002), three envelope outcomes.** Envelope `status ∈ {complete, degraded, invalid_input}`. `run_id` is required-by-construction (interpolated into the `/tmp` artifact path; no safe runtime fallback). The **orchestrator** validates fully before dispatch — resolves the plan path to absolute, confirms it exists, confirms it parses to a non-empty unit set — returning `invalid_input` (not `degraded`, not a throw) on a bad call. The **workflow** keeps a structural guard (non-empty args, path-safe `run_id`, and a plugin-namespaced `agentType` *when one is set* — the default general-purpose classifier dispatches schema-only) as defense for non-orchestrator callers. *(origin: ADR 0002)*

9. **Git plumbing in single commands / Python where scripted; "absent" is data, not a crash.** Classifier agents inspect git/file state via native file tools plus single, unchained git commands (`git log`, `git diff` for a path). If any deterministic git-fact collection is scripted, it is Python with `check=False` so "file absent" / "no such ref" is captured as **drift signal**, never an aborting error. *(grounding: `docs/solutions/best-practices/prefer-python-over-bash-for-pipeline-scripts.md`)*

10. **Mandatory live smoke + variance calibration.** Static tests cannot prove the workflow dispatches; a real `Workflow` run against a seeded fixture is an acceptance gate (live-boundary contracts: args-as-JSON-string parse, plugin-namespaced `agentType`, dispatch failures logged not swallowed). Because verdicts are model-mediated and feed a numeric threshold, the eval runs **N ≥ 3 trials** and documents an expected drift-rate *range*, not an exact value. *(grounding: `dynamic-workflow-conversion-live-boundary.md`, `ce-doc-review-calibration-patterns.md`)*

---

## High-Level Technical Design

*Directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
/ce-verify-work [plan-path | blank=latest in docs/plans/]
        |
  [Orchestrator — ce-verify-work/SKILL.md, model-side]
  resolve plan path (explicit or latest .md/.html)
  validate: exists? parses to >=1 Implementation Unit?      --> no: return invalid_input (loud, pre-dispatch)
  mint run_id; stage plan path to /tmp/compound-engineering/ce-verify-work/{run_id}/
        |
  GUARD: is the Workflow tool available?
        |
   yes  v                                          no --> prose fallback: classify units sequentially
  Workflow(work-vs-plan-fanout.generated.js,             in orchestrator context with the same rubric,
           args={run_id, plan_path, batch_size})          present verdict table + drift rate
        |
   [Workflow runtime — context-isolated]
   parsePlanUnits(plan)  ->  batch units (~5-7)
   parallel agent() per batch (verdict schema; agentType plugin-namespaced only
                               if a dedicated classifier is used — else schema-only):
     each batch agent inspects git/file state for its units (Read/Grep + git log/diff),
       returns [{u_id, verdict, evidence[], rationale}]   (conservative on ambiguity)
        |
   rollupVerdicts(allVerdicts) (deterministic):
     validate -> count by verdict -> drift_rate = drifted/(done+drifted)
     -> verdict table (evidence preserved) -> remaining + unverifiable reported
        separately (both excluded from the denominator)
        |
   return envelope { status, drift_rate, low_confidence, counts, units[],
                     unverifiable[], artifact_path, run_id }
        |
  [Orchestrator] present table + drift rate to the user; envelope returned verbatim
```

**Envelope shape (directional):**

```
{ status: "complete" | "degraded" | "invalid_input",
  drift_rate: 0.0–1.0 | null,
  low_confidence: boolean,        // attempted below floor, or high unverifiable fraction
  counts: { done, remaining, drifted, unverifiable, attempted },
  units: [ { u_id, verdict, evidence: [...], rationale } ],
  unverifiable: [ { u_id, reason } ],
  plan_path, artifact_path, run_id }
```

`attempted` = `done + drifted` (the drift-rate denominator); `remaining` and `unverifiable` are reported in their own counts and never enter `attempted`. `drift_rate` is `null` when `attempted` is 0 (nothing verifiable was attempted yet). `low_confidence` is `true` when `attempted` is below a small floor (a near-empty denominator) or the `unverifiable` fraction is high — signalling the rate should not gate `T` unexamined. `invalid_input` carries a `reason` and no drift_rate. `degraded` (some batch agents failed) still returns a rate computed over the verdicts that survived, with the shortfall noted in `counts`.

---

## Output Structure

New files live inside the skill directory (isolated-unit rule — no cross-skill or absolute refs), plus a co-located build script and tests:

```
plugins/compound-engineering/skills/ce-verify-work/
  SKILL.md                          (new: guarded orchestrator + prose fallback)
  workflows/                        (new)
    drift-rollup.js                 (new: pure module — parsePlanUnits + rollupVerdicts)
    work-vs-plan-fanout.js          (new: workflow template, marker for inlined module)
    work-vs-plan-fanout.generated.js (new: committed build artifact, DO NOT EDIT)
  references/                       (new)
    verdict-rubric.md               (new: 4-state rubric, evidence + conservative rules)
    verdict-schema.json             (new: per-unit classifier output contract)
scripts/
  build-work-vs-plan-workflow.ts    (new: copy of the 52-line per-skill builder)
tests/
  work-vs-plan-rollup.test.ts       (new: unit tests for drift-rollup.js)
  work-vs-plan-workflow-parity.test.ts (new: freshness + portability + converter-copy)
  work-vs-plan-workflow-eval.test.ts   (new: live smoke + variance calibration)
plugins/compound-engineering/README.md (modified: Workflow-group row + skill count)
docs/skills/ce-verify-work.md        (new, optional: user-facing skill doc)
```

The per-unit `**Files:**` sections below are authoritative; this tree is a scope declaration.

---

## Implementation Units

### U1. Deterministic plan-parser + drift roll-up module

**Goal:** A pure, dependency-free JS module that (a) parses a plan document into Implementation Units and (b) rolls per-unit verdicts up into the drift rate + verdict table. Unit-testable in isolation and reusable by the workflow (inlined) and the orchestrator's pre-dispatch validation.

**Requirements:** R13, R2 (determinism). Advances Key Decisions 4, 7.

**Dependencies:** none (foundation).

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/workflows/drift-rollup.js` (new)
- `tests/work-vs-plan-rollup.test.ts` (new)

**Approach:** `parsePlanUnits(planText)` extracts each `### U<n>. <Name>` heading and its bold fields (`**Goal:**`, `**Files:**` split into create/modify/test paths, `**Verification:**`, `**Test scenarios:**`), preserving the **U-ID verbatim** as the unit key (U-IDs are stable, gaps allowed — never renumber). Ignore any legacy `- [ ]`/`- [x]` marks entirely. Handle markdown and HTML plans (ce-work reads both). `rollupVerdicts(verdicts)` validates each `{u_id, verdict, evidence}` against the verdict enum, drops malformed entries with a count, computes `drift_rate = drifted / (done + drifted)` (null when `attempted = done + drifted` is 0), partitions `remaining` and `unverifiable` out of the denominator (both reported in their own counts), sets a `low_confidence` flag when `attempted` is below a small floor or the `unverifiable` fraction is high, and returns the counts + ordered verdict table + flag with evidence preserved. **Pure only** — no git, no fs, no Agent/Workflow calls. End with a single strippable `export { parsePlanUnits, rollupVerdicts };` line (build-step contract).

**Patterns to follow:** `plugins/compound-engineering/skills/ce-code-review/workflows/merge-findings.js` (pure module shape, trailing single `export`, `[INTERP]` markers for judgment calls); unit-heading spec in `plugins/compound-engineering/skills/ce-plan/SKILL.md:475-497`.

**Execution note:** Test-first — the parse anchors and drift-rate math are precisely specifiable; write the tests before the module.

**Test scenarios:**
- Parses `### U1.`, `### U3.`, `### U5.` (gapped U-IDs) into three units keyed by verbatim U-ID; no renumbering.
- Extracts `**Files:**` into create/modify/test path lists and `**Verification:**` text per unit.
- A plan containing legacy `- [x]` marks on unit headings → marks ignored, not read as state.
- HTML plan with the same section/field names → parsed equivalently to its markdown form.
- A plan with no Implementation Units section → returns an empty unit set (drives `invalid_input` upstream).
- `rollupVerdicts`: drift_rate = drifted/(done+drifted); a fixture of 2 done / 1 remaining / 1 drifted / 1 unverifiable → rate = 1/3 ≈ 0.33 (denominator `attempted` = done+drifted = 3; `remaining` and `unverifiable` excluded), each excluded count reported separately.
- Empty attempted set (all `remaining`/`unverifiable`, or done+drifted = 0) → drift_rate = null, not a divide-by-zero.
- Timing-invariance: adding N more `remaining` units to a fixture does **not** change drift_rate (the denominator excludes them) — guards against the dilution defect.
- Small attempted set (1 done + 1 drifted → 0.5) → rate computed but `low_confidence` is set (attempted below floor); a healthy attempted set is not flagged.
- Malformed verdict (verdict not in enum, missing `u_id`) → dropped, drop count returned; rest survive.
- Denominator single-source-of-truth: the reported `attempted` count equals done+drifted and is the exact denominator used for the rate (no divergence).

**Verification:** `bun test tests/work-vs-plan-rollup.test.ts` green; module has no `import`/`require`/`agent(`/`fs` references.

---

### U2. Verdict contract — rubric + classifier output schema

**Goal:** Define the 4-state verdict semantics, the required evidence citation, the conservative tie-break, and the "claimed-done" evidence sources, as a `references/` rubric plus a JSON schema the classifier agents (and the prose fallback) emit against. Keeping this out of the SKILL.md body avoids the multiplicative body-size cost on every fan-out call.

**Requirements:** R4, R13. Advances Key Decisions 3, 5, 6.

**Dependencies:** none (can land parallel to U1; the schema's enum must match U1's accepted verdicts — verified by a consistency test).

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/references/verdict-rubric.md` (new)
- `plugins/compound-engineering/skills/ce-verify-work/references/verdict-schema.json` (new)

**Approach:** The rubric states, per verdict, the decision rule and the evidence required: `done` (Files present + Verification satisfied; cite the artifacts); `remaining` (no git evidence of attempt — no commit touched the declared paths; never inferred from "not recently touched"); `drifted` (a commit touched the unit's declared `**Files:**` paths **but** Verification is unmet / Files diverged; cite both the attempt evidence and the divergence; when paths are shared across units, adjudicate by the unit's own Verification); `unverifiable` (**highest bar** — Verification is *intrinsically* behavioral/runtime, unsettleable from static repo state; a statically-checkable unit is never unverifiable). Rules: **git + file state only — no session history, no plan checkboxes** (first cut; session-history claim signals are deferred — Scope Boundaries); "recently changed" is not a done-proxy — the missing/diverged-artifact is the signal; on a borderline *statically-checkable* call, take the conservative `done`/`drifted` verdict (lean `drifted`) — do **not** escape to `unverifiable`. The schema is the per-unit JSON object: `{u_id (string), verdict (enum), evidence (array of strings, non-empty for done/drifted), rationale (string)}`.

**Patterns to follow:** `plugins/compound-engineering/skills/ce-code-review/references/findings-schema.json` (compact per-agent contract); the verifiable-vs-external distinction in `docs/solutions/skill-design/ce-doc-review-calibration-patterns.md`.

**Test scenarios:**
- `verdict-schema.json` is valid JSON and its verdict enum is exactly `{done, remaining, drifted, unverifiable}` — matching U1's accepted set (consistency test guards drift between the two files).
- Schema requires a non-empty `evidence` array for `done` and `drifted`.
- Test expectation: rubric is reference prose (no behavioral assertion beyond the schema-consistency check above).

**Verification:** `bun test` schema-consistency check green; rubric load resolves co-located (relative path from skill root).

---

### U3. Dynamic workflow script + build step + generated artifact

**Goal:** A Claude Code dynamic workflow that parses the plan (inlined U1 module), fans out batched classifier agents, rolls up their verdicts, and returns the drift envelope — context-isolated from the orchestrator — plus the per-skill build script and committed generated artifact.

**Requirements:** R1, R2 (context offload), R4 (classify-and-act, fan-out), R14 (behind no memory-loop dependency). Advances Key Decisions 6, 7, 8, 9.

**Dependencies:** U1, U2.

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/workflows/work-vs-plan-fanout.js` (new)
- `plugins/compound-engineering/skills/ce-verify-work/workflows/work-vs-plan-fanout.generated.js` (new, committed)
- `scripts/build-work-vs-plan-workflow.ts` (new)
- **Conditional — only if the dedicated-`ce-*`-classifier path is taken (not the default general-purpose agent):** `plugins/compound-engineering/agents/ce-<classifier-name>.md` (new) + a `plugins/compound-engineering/README.md` agent-table row & count bump + a `bun run release:validate` pass. The default general-purpose path adds none of these.

**Approach:** `export const meta` as a **pure literal** (name, description, phases: Classify, Roll-up). Parse `args` defensively (accept JSON string or object; log and don't silently default). Read `args = {run_id, plan_path, batch_size?}`. `parsePlanUnits` (inlined at the `/* __MERGE_MODULE__ */` marker) → batch units (default ~5–7) → `parallel()` one `agent()` per batch with `schema` set to the verdict contract (default: a **general-purpose** explore/analysis agent dispatched schema-only — the proven path in `code-review-fanout.js`; set `agentType` to a **plugin-namespaced** dedicated `ce-*` classifier only if the default proves unreliable, per the Execution note); each batch prompt passes the staged plan **path**, the units in its batch, and the rubric, and instructs the agent to inspect git/file state and return one verdict object per unit with cited evidence. Log dispatch failures (never swallow). Collect, filter nulls (record dropped batches), call `rollupVerdicts`, assemble the envelope (`status` = `degraded` if any batch failed, else `complete`). The build script (`scripts/build-work-vs-plan-workflow.ts`) is a copy of `scripts/build-doc-review-workflow.ts` with this skill's paths: strip the module's trailing `export`, substitute at the marker, write the `// GENERATED ... DO NOT EDIT` artifact, export `assembleWorkVsPlanWorkflow(root)` + `GENERATED_PATH` for the freshness test. **Not** added to `package.json` (run via `bun run scripts/build-work-vs-plan-workflow.ts`, per precedent).

**Patterns to follow:** `plugins/compound-engineering/skills/ce-code-review/workflows/code-review-fanout.js` (arg parse, `parallel` schema'd dispatch, logged `.catch`, pure-literal meta, marker); `scripts/build-doc-review-workflow.ts` (builder contract); `docs/solutions/skill-design/dynamic-workflow-conversion-live-boundary.md` (the three runtime contracts).

**Execution note:** **Default to a general-purpose explore/analysis agent** dispatched schema-only (no `agentType`) — the proven dispatch path in `code-review-fanout.js`, which adds **no** new-agent scope. Only if classification proves unreliable that way, fall back to a dedicated `ce-*` classifier agent — which then pulls a new agent file + README row + `release:validate` into scope (see the conditional Files entry). A dedicated agent's `agentType` must be plugin-namespaced. Decide against live `agent()` resolution.

**Test scenarios:**
- *Test expectation: integration/manual for the live run* — covered by U5. Static (assertable): script parses; `meta` is first statement after comment-strip and is a pure literal (no `${`, no spread); `new Function(...)` constructs with the workflow globals (`agent, parallel, pipeline, phase, log, budget, workflow`); the `/* __MERGE_MODULE__ */` marker appears exactly once; inlined `parsePlanUnits`/`rollupVerdicts` are present after assembly.
- Freshness: committed `work-vs-plan-fanout.generated.js` equals a fresh `assembleWorkVsPlanWorkflow()` (regenerate-on-edit guard).
- `args` delivered as a JSON **string** is parsed (`typeof A === "string"` → `JSON.parse`); a non-JSON string logs and does not silently run all-defaults.
- A simulated batch dispatch failure is logged and degrades status, never silently dropped.

**Verification:** `bun test tests/work-vs-plan-workflow-parity.test.ts` green (freshness + static battery); `bun run scripts/build-work-vs-plan-workflow.ts` reproduces the committed artifact with no diff.

---

### U4. The `ce-verify-work` skill — guard, prose fallback, orchestrator validation

**Goal:** A new skill that resolves and validates the plan input, branches to the workflow when the Workflow tool is available (else a sequential prose classification), and presents the verdict table + drift rate — without ever reaching into memory-loop internals.

**Requirements:** R1, R14 (consumer profile: works with an empty store), R15 (guarded fallback), ADR 0002 (layered validation). Advances Key Decisions 1, 2, 8.

**Dependencies:** U3.

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/SKILL.md` (new)
- `plugins/compound-engineering/README.md` (modified: add a Workflow-group row, bump the skill count)
- `CONTEXT.md` (modified: reconcile the `Drift rate` glossary entry — "over total tasks" → "over attempted tasks (`done + drifted`)" — so the program glossary matches the operational definition this skill ships, per Key Decision 4)
- `docs/skills/ce-verify-work.md` (new, optional user-facing doc) + `docs/skills/README.md` (modified) if the doc is created

**Approach:** Frontmatter: `name: ce-verify-work` (ce- prefix required), a what+when `description` (no colon needing quoting, no raw angle brackets), `ce_platforms` **unset**. Phase 1 — resolve the plan: explicit path argument, else auto-detect the latest `docs/plans/*.md`/`*.html` (mirror `ce-work` Phase 1 detection). **Validate before dispatch** (ADR 0002): resolve to absolute, confirm existence, parse with U1 to confirm ≥1 unit; on failure return/print `invalid_input` loudly. Mint `run_id`, stage the plan path under `/tmp/compound-engineering/ce-verify-work/{run_id}/`. **Guard** (load-bearing → inline): when the Workflow tool is available, Read `workflows/work-vs-plan-fanout.generated.js` (co-located), invoke the Workflow tool passing its **contents** as `script` and `args={run_id, plan_path, batch_size}`, and present the returned envelope. Otherwise ("when the Workflow tool is unavailable, ignore this subsection and run the prose dispatch below"), classify units sequentially in orchestrator context using `references/verdict-rubric.md` + `references/verdict-schema.json`, then call the same pure `rollupVerdicts` module (U1) on those verdicts — never re-derive the rate in prose, so the fallback and workflow share one denominator and one `low_confidence` flag. Present output as a verdict table (U-ID | verdict | evidence) plus the headline drift rate, the `attempted` denominator, the `unverifiable` count, and the `low_confidence` flag — surfacing the flag prominently so a near-empty or high-`unverifiable` denominator is not read as a trustworthy gate input. Keep the SKILL.md body lean — rubric and schema stay in `references/`.

**Patterns to follow:** `plugins/compound-engineering/skills/ce-doc-review/SKILL.md:146-179` (guard wiring, read-generated-file-pass-contents, plugin-namespaced agentType note, the literal fallback sentence the portability tests assert); `post-menu-routing-belongs-inline.md` (load-bearing routing inline); `plugins/compound-engineering/skills/ce-work/SKILL.md:47-61` (latest-plan detection, no-checkbox rule).

**Test scenarios:**
- Frontmatter: `name` matches the directory, `description` is what+when and ≤1024 chars with no raw `<angle>` tokens, `ce-` prefix present (`tests/frontmatter.test.ts` passes).
- `ce_platforms` is unset (asserted in U6's converter test so the skill is never platform-filtered).
- Guard prose retains both the `Workflow tool` availability branch and a literal `run the prose dispatch` fallback line (asserted in U6).
- Invalid call (missing plan, plan with no units) surfaces `invalid_input` before any workflow dispatch — not a silent empty result.
- README skill count and the new Workflow-group row are accurate (manual check; `bun run release:validate` run per AGENTS.md).

**Verification:** `bun test tests/frontmatter.test.ts` green; `bun run release:validate` reports no drift; manual read confirms the guard branches and the empty-store smoke (the skill never reads `docs/solutions/`).

---

### U5. Live smoke + variance-calibration eval

**Goal:** Prove the workflow actually dispatches and that the drift envelope is trustworthy — both the deterministic roll-up (exact) and the model-mediated classification (variance-bounded) — against seeded fixture plans with known verdicts.

**Requirements:** R2, R4, ADR 0001 (the drift signal must be credible). Advances Key Decisions 5, 6, 10.

**Dependencies:** U3, U4.

**Files:**
- `tests/work-vs-plan-workflow-eval.test.ts` (new)
- `tests/fixtures/` — seeded plan fixtures + a repo-state shim covering: a clearly-done unit, a clearly-remaining unit, a `drifted` unit (its `**Files:**` deleted/diverged), an `unverifiable` (behavioral-claim) unit, a **false-unverifiable control** (concrete Files + statically-checkable Verification — must NOT classify `unverifiable`), a **small-attempted** fixture (1 done + 1 drifted — exercises the `low_confidence` flag), and **≥2 known-ground-truth** fixtures spanning different drifted/done ratios, each with a computable exact drift rate.

**Approach:** Exact-assert the deterministic roll-up on a fixed verdict set (byte-identical across repeated runs; drift-rate math; `remaining` + `unverifiable` excluded from the denominator). For the live path, run the real `Workflow` against a small fixture plan and assert: agents actually executed (non-zero subagent tokens, populated `units`), the envelope validates against the documented shape, `run_id`/`artifact_path` populated, and the deleted-file fixture classifies as `drifted` with cited evidence on **both** the workflow and the prose-fallback path. Because classification is model-mediated, run **N ≥ 3** trials on the fixture and assert the drift rate falls in a documented *range* (not an exact value); keep a negative-control fixture (all-done plan → drift_rate 0). Log what each trial produced (no silent caps).

**Patterns to follow:** `tests/doc-review-workflow-eval.test.ts` (freshness + identity-parity placement); `docs/solutions/skill-design/safe-auto-rubric-calibration.md` (N≥3 trials, variance, negative control); `docs/solutions/best-practices/ce-pipeline-end-to-end-learnings.md` (sample real evidence; don't trust a single confident run).

**Execution note:** The deterministic roll-up is exact-assertable; the classification is model-mediated — assert the envelope contract + a drift-rate range + cross-path agreement on the unambiguous fixtures, not verbatim rationale text.

**Test scenarios:**
- Deterministic roll-up output byte-identical across repeated runs on a fixed verdict set (variance = 0).
- Live `Workflow` run on the fixture plan: non-zero subagent tokens, `units` populated, envelope shape valid, `run_id`/`artifact_path` present.
- Deleted-`Files` fixture → `drifted` with non-empty evidence on workflow **and** prose-fallback paths.
- Behavioral-claim fixture → `unverifiable`, excluded from the denominator (not counted as done or drifted).
- False-unverifiable control: a unit with concrete Files + statically-checkable Verification is classified `done`/`drifted`, **never** `unverifiable` (guards the denominator against the skew/gaming vector).
- No-evidence fixture → `remaining` with empty evidence on workflow **and** prose-fallback paths.
- Negative control: all-done fixture → drift_rate 0; nothing miscounted as drifted.
- Known-ground-truth fixtures (≥2 ratios) → measured drift rate equals the computed value within tolerance per fixture, **demonstrating the bias direction**; magnitude is fixture-specific, so the offset is read across the fixture spread, not from a single point.
- Prose-fallback path computes the **same `drift_rate` and `low_confidence`** as the workflow on a fixed verdict set (both call `rollupVerdicts`) — guards single-source-of-truth across paths.
- Small-attempted fixture (1 done + 1 drifted) → `low_confidence` set on **both** the workflow and fallback paths.
- N≥3 trials → drift rate within the documented range; per-trial results logged.

**Verification:** Eval report shows a populated live envelope, cross-path agreement on the unambiguous fixtures, and a drift-rate range across trials; all new + existing tests green.

---

### U6. Converter verification — ships intact to non-CC targets

**Goal:** Confirm `ce-verify-work` (including its `workflows/` subdir and the guarded prose) survives conversion to Codex/OpenCode/Gemini without breaking the skill or emitting broken orchestration, and that the workflow path is cleanly gated behind the availability guard.

**Requirements:** R15. Advances Key Decision 2.

**Dependencies:** U4.

**Files:**
- `tests/work-vs-plan-workflow-parity.test.ts` (extended — converter-copy + portability assertions; shared with U3)

**Approach:** Verify (a) `ce-verify-work` is **not** dropped on non-CC targets — `ce_platforms` unset; (b) the converter copies the skill's `workflows/` subdir (the `.js` + `.generated.js`) verbatim as part of the isolated-unit copy; (c) Codex content-rewriting does not mangle the guarded "Workflow tool" prose or the `.js` references; (d) the converted SKILL.md retains the prose fallback (both the `Workflow tool` branch and the `run the prose dispatch` sentence) so a non-CC install runs the fallback path; (e) the **scriptPath-resolution** decision matches the precedent — the skill Reads the co-located generated file and passes its **contents** as the Workflow `script` arg (no skill-relative `scriptPath`, no unguarded `${CLAUDE_*}`).

**Patterns to follow:** `tests/doc-review-workflow-parity.test.ts:27-101` (ce_platforms-unset, workflows/ copy, portability markers, contents-as-script); `src/utils/files.ts:165-193` (auto-copy of non-`.md` files — expected to need no change); `src/types/claude.ts:61-63` (`filterSkillsByPlatform`).

**Test scenarios:**
- Convert to Codex → `ce-verify-work` present; `workflows/work-vs-plan-fanout.js` + `.generated.js` copied; no broken slash/tool rewrites in the guarded prose.
- Convert to OpenCode → skill present; fallback prose intact and self-contained (`Workflow tool` + `run the prose dispatch` both present).
- Assert `ce_platforms` is unset (or includes all targets) so the skill is never filtered out.

**Verification:** `bun run release:validate` passes; `bun test` green; manual diff of converted Codex/OpenCode SKILL.md shows an intact fallback and no dangling Workflow-only instruction as the sole path.

---

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| **Silent empty/degraded output that passes every static test** (live-boundary class: unparsed `args`, bare `agentType`, swallowed dispatch errors) | High — the probe confidently reports drift 0 / no units while broken | U5 mandatory live smoke run; U3 asserts JSON-string arg parse, plugin-namespaced agentType, logged dispatch failures (`dynamic-workflow-conversion-live-boundary.md`) |
| **`unverifiable` gamed to shrink the denominator** — ambiguous units dumped into `unverifiable` to skew the rate (a unit "improves latency" a static probe can't settle is legitimate; a checkable one routed there is not) | High — silently wrong drift rate feeding a gate | `unverifiable` is the **highest-bar** verdict (intrinsically-behavioral Verification only); ambiguity routes to a conservative `done`/`drifted` call, not `unverifiable` (Key Decision 3); U5 false-unverifiable control fixture; the `unverifiable` fraction is surfaced as a run-trustworthiness flag (U4) |
| **`remaining`-dilution of the rework signal** — including never-started units would make early-plan rates read near-zero regardless of actual rework | High — the gated number misrepresents rework | Denominator is `done + drifted` (attempted units only); `remaining` excluded (Key Decision 4); U1 timing-invariance test asserts adding `remaining` units doesn't move the rate |
| **Estimator bias vs. noise** — the conservative tie-break leans `drifted`, biasing the rate up among attempted units; N≥3 trials bound run-to-run *noise*, not systematic *bias* | Medium — `T` compared against a biased number | State the up-bias explicitly (the rate is a conservative upper-leaning estimate); U5 known-ground-truth fixtures (≥2 ratios) **demonstrate the bias direction** — magnitude is fixture-specific, so `T` is set against a stated directional caveat, not a single measured offset (Key Decisions 4, 6) |
| **Small-attempted-N volatility** — excluding `remaining` shrinks the denominator, so an early probe (e.g. 1 done + 1 drifted) yields a wild `0.5` from a meaningless sample | Medium — `T` gated on an unstable low-N rate | The roll-up emits a `low_confidence` flag when `attempted` is below a small floor (Key Decision 4); U4 surfaces it; `T` must not gate on an unflagged small-N rate; U1/U5 small-N scenarios assert the flag |
| **Coverage gap (git-only detection)** — a unit reworked without a commit touching its declared paths reads as `remaining`, so uncommitted/squashed rework is invisible to the first-cut rate | Medium — drift undercounted for uncommitted churn | First cut is git-only by decision; the rate is scoped to the *git-evidenced attempted* subset, not a claim about all rework (such units fall out of the `done + drifted` denominator, so it is a coverage gap, not a rate bias); session-history detection deferred (Scope Boundaries; Key Decision 6) |
| **"Recently changed" mistaken for "done"** | Medium — false `done` understates drift | Rubric encodes missing/diverged-artifact as the signal, not recency (Key Decision 6; `compound-refresh-skill-improvements.md`) |
| **Reading legacy `- [x]` marks as truth** | Medium — fabricated done-ness | U1 parser ignores checkboxes; rubric forbids reading them; explicit test scenario (`ce-work/SKILL.md:61`) |
| **Plan-parser brittleness** (net-new ground; U-ID gaps, missing fields, HTML plans, no-units plans) | Medium — wrong unit set → wrong rate | U1 unit tests across gapped U-IDs, HTML, missing fields, empty unit set; orchestrator returns `invalid_input` on no-units |
| **Generated artifact drifts from sources** | Low — stale workflow ships | Freshness test (U3); regenerate-on-edit; `// DO NOT EDIT` header |
| **Converter breaks the fallback** on non-CC targets | Medium — broken orchestration on Codex/Gemini | U6 converter tests; fallback prose retained inline; `ce_platforms` unset |
| **Cross-repo / non-git plan** run against the wrong repo | Low (scoped out) | First cut assumes plan targets the cwd repo; `**Target repo:**` plans deferred (Scope Boundaries) |

---

## Alternative Approaches Considered

- **Integrate the probe into `ce-work` instead of a standalone skill.** Rejected for the first cut: the probe is a standalone analytical pass that should run against any plan independent of an execution session, and `ce-work` is already large and stateful. `ce-work` *consuming* the probe on resume is a clean follow-up, not a reason to bury the probe inside it. (Key Decision 1.)
- **Close the drift→capture loop now** (write a `ce-compound` drift learning per high-drift run). Rejected for the first cut by user decision: keeps the probe clean, testable, and parity-honest; the probe already gathers the cited evidence such a learning needs, so closing the loop later is cheap. (Scope Boundaries → Deferred.)
- **Pure script-first deterministic classification** (no model-mediated agents). Rejected: deciding whether the code *satisfies a unit's intent/Verification* is irreducibly judgment; a script can collect cheap facts (Files existence, git log per path) but cannot adjudicate `drifted` vs `done` on behavioral or semantic Verification criteria. The chosen hybrid keeps deterministic facts in the roll-up and judgment in the classifier. (Key Decisions 6, 7, 9.)
- **Three-verdict enum** (done / remaining / drifted). Rejected: forces behavioral claims into done or drifted, silently corrupting the rate; the 4th `unverifiable` state is the calibration-grounded correction. (Key Decision 3.)
- **Drift-rate denominator over all tasks (or all verifiable tasks).** Rejected `drifted / (done + remaining + drifted)` (CONTEXT.md's literal "over total tasks"): including never-started `remaining` units makes the rate a function of plan-completion stage — a plan probed early reads near-zero drift regardless of actual rework. Chose `drifted / (done + drifted)` (attempted-and-verifiable units), measuring the redo-shaped subset CONTEXT.md actually intends. Requires reconciling CONTEXT.md's glossary entry (U4). (Key Decision 4; surfaced by adversarial review.)
- **Include session history as a first-cut `drifted` signal.** Rejected for the first cut: session history is unreachable inside a fan-out classifier (needs the `ce-sessions` skill, platform-specific, ~30-day retention) and the rubric-vs-design contradiction it created was a real coherence gap. Chose git-only detection with an explicit coverage caveat (uncommitted rework reads as `remaining`); session-history detection deferred. (Key Decision 6; surfaced by feasibility + adversarial review.)

---

## Deferred / Open Questions (resolve at implementation)

- **Classifier `agentType`** (U3) — default is a general-purpose explore/analysis agent dispatched schema-only with the rubric in-prompt (no new-agent scope); a dedicated `ce-*` classifier is the fallback and adds an agent file + README row + `release:validate` scope (U3 conditional Files entry). Decide against live `agent()` resolution; plugin-namespace it only if `agentType` is set.
- **Batch size** (U3) — default ~5–7 units per classifier; tune against fixture cost/accuracy in U5.
- **`build-step` triad vs single self-contained script** — the plan assumes the triad (testable `drift-rollup.js` inlined). If, during U1, the deterministic surface proves trivially small, a single self-contained `work-vs-plan-fanout.js` (meta-first, no separate module, roll-up tested via a thin re-export) is acceptable — decide at the U1→U3 boundary; it removes the build script and one generated file.
- **"Claimed done" git signals** (U2) — the precise git-log/diff signal set (path-touch, rename detection, squash-merge handling, shared-path adjudication) that constitutes an attempt claim; refine against the U5 fixtures. (Session-history signals are out of the first cut — Scope Boundaries.)
- **Optional `docs/skills/ce-verify-work.md`** (U4) — lean toward creating it (net-new skill with novel mechanics: 4-verdict drift, the probe/gate framing); confirm at U4.
