---
status: completed
type: feat
created: 2026-06-06
origin: docs/brainstorms/2026-06-04-dynamic-workflows-opportunity-map-requirements.md
related:
  - docs/dynamic-workflows-opportunity-map.md
  - docs/plans/2026-06-04-001-feat-ce-code-review-workflow-fanout-plan.md
---

# feat: Convert ce-doc-review headless synthesis to a dynamic workflow

## Summary

Move `ce-doc-review`'s **headless fan-out + synthesis sub-step** (`mode:headless`: parallel persona dispatch + the Phase 3 synthesis pipeline) off hand-orchestrated prose and onto a Claude Code **dynamic workflow**. The orchestrator keeps document classification, persona *selection* (model judgment), `safe_auto` document mutation, and rendering; it hands the resolved personas + the document path to a workflow script that fans the reviewers out in the background, runs synthesis, and returns the structured envelope the headless text output is built from. Intermediate per-persona findings never reach the orchestrator's context.

This is **rank 1** in the dynamic-workflows opportunity map — the recommended second conversion, chosen because it is structurally the closest follow-on to the landed `ce-code-review` conversion (the template) and its headless envelope is an already-specified, machine-consumed contract. **Lowest-risk is qualified, not absolute:** doc-review is lowest-risk on *structure and reuse* (the build/guard/test scaffold copies the template), but its synthesis is *more semantically complex* than code-review's merge — its pipeline interleaves mechanical and judgment steps with bidirectional data dependencies, so the synthesis parity work is higher-effort, not lower. The plan treats that as the load-bearing risk.

**Parity-first:** the converted path reproduces the current `mode:headless` envelope; added rigor (adversarial-verify of survivors, loop-until-dry) is deferred.

**Why `feat` not `refactor`:** output is held at parity, but this introduces `ce-doc-review`'s first dynamic-workflow integration — a new capability built on the opportunity-map pattern. The commit author may downgrade to `refactor`/`perf` if they weigh the parity constraint as the dominant intent.

---

## Problem Frame

`ce-doc-review` **already has a headless mode** (`mode:headless`) that fans out 2–7 persona reviewers in parallel and runs a fully-specified synthesis pipeline (`references/synthesis-and-presentation.md` Phase 3) into a structured text envelope. So the **marginal** win over today's baseline (R2's required comparison point — not over interactive mode) is specific:

1. **Context offload (the load-bearing win).** Today the orchestrator receives every persona's full findings (each with `why_it_matters` + `evidence`) *into its own context* and performs the multi-step synthesis *by in-context reasoning*. Headless `ce-doc-review` is a machine-handoff path: `ce-plan` Phase 5.3.8 and `ce-brainstorm` Phase 4 invoke it and consume the envelope. A workflow holds the persona returns and synthesis working-memory in the script runtime; **the named beneficiaries are those callers** — their context receives only the final envelope, not the per-persona findings. This is the concrete consumer the conversion serves.
2. **Determinism + testability of the *mechanical* steps only.** The pipeline's clean-mechanical steps (schema validation, anchor confidence gate, fingerprint dedup, the route table, sort, restatement suppression, protected-artifact drop) are currently prose the model executes by reasoning, with run-to-run variance. Ported to a JS module they become reproducible and unit-testable for the first time. **This win is explicitly scoped to that mechanical subset.** The judgment-heavy passes (collapse, contradiction, chaining, auto-promotion, and the two deterministic-but-interleaved steps folded with them — see Key Decision 2) stay model-mediated; relocating them to a context-isolated synthesis agent holds their variance *at parity or better*, it does **not** reduce it. The plan does not claim a determinism win it cannot deliver.

These are real but bounded. The conversion's value rests primarily on (1) — caller-context offload — with (2) a secondary, scoped gain.

**Requirements advanced (origin + map):** R12 (`ce-doc-review` as a review-branch candidate), R1 (non-interactive gate — only the headless fan-out+synthesis sub-step converts; the interactive walk-through stays out), R2 (context-offload, marginal-over-headless), R14 (loose coupling — the workflow sits behind the existing headless seam; no memory-loop dependency), R15 (CC-only with a guarded non-CC fallback). Patterns proven: **fanout-and-synthesize**; perspective-diverse-verify / judge-panel already live as conditional personas; adversarial-verify-of-survivors and loop-until-dry deferred.

---

## Scope Boundaries

**In scope**
- A dynamic workflow that fans out the *already-selected* personas and runs the synthesis pipeline, returning the structured envelope the `mode:headless` text output is rendered from.
- A standalone, unit-tested JS module holding the *clean-mechanical* synthesis steps that bracket the pipeline (the front: validate / gate / dedup; the back: route / sort / suppress / protected-artifact drop) — the steps that are a pure function of the finding set with no interleaved judgment.
- One **in-workflow synthesis agent** that owns the *contiguous interleaved middle* of the pipeline (same-persona premise collapse, cross-persona promotion, contradiction resolution, recommended-action tie-break, premise-dependency chaining, auto-promotion), context-isolated inside the workflow runtime, run in the pipeline's mandated order.
- A build script that inlines the mechanical module into the workflow template and a committed, runnable `*.generated.js`, with a freshness test (mirrors the code-review build).
- A guarded `mode:headless` dispatch in SKILL.md: workflow when the Workflow tool is available, existing prose fan-out + Phase 3–5 synthesis otherwise.
- Parity validation against the existing headless envelope (at finding-identity level, not just counts) + a live smoke run that exercises the synthesis agent; converter verification that the skill still ships intact to non-CC targets.

**Out of scope (non-goals)**
- Interactive/default mode — the routing question, per-finding walk-through, and bulk-preview (`references/walkthrough.md`, `references/bulk-preview.md`) are untouched.
- Persona *selection* judgment (Phase 1 conditional-persona activation) moving into the workflow — stays model-side per the script/model boundary.
- Document classification (`requirements` vs `plan`) — a single orchestrator read, no fan-out; stays model-side.
- `safe_auto` document mutation — the workflow is report-only; the orchestrator applies the edits and renders (mirrors the code-review conversion keeping apply out of the workflow).
- Multi-round decision-primer suppression (R29/R30) — headless mode is single-round; the workflow runs round-1-only with an empty primer and the synthesis agent does **not** execute R29/R30 (they have no primer to act on). The round-2+ memory stays orchestrator-side.

**Deferred to Follow-Up Work**
- Wiring **interactive** mode to reuse the same workflow (then run the walk-through in the shell). (Enabled by this conversion; intentionally not in the first cut — mirrors the code-review conversion deferring default-mode reuse.)
- Added rigor inside the workflow: adversarial-verify of surviving P0/P1 findings, loop-until-dry contradiction resolution, a judge-panel over the synthesis output.
- Re-extracting the two interleaved deterministic steps (cross-persona promotion, recommended-action tie-break) out of the synthesis agent and back into deterministic JS via a multi-call split — the determinism-preserving alternative, deferred because it adds agent round-trips (see Alternatives Considered).
- The other opportunity-map candidates (Capture / Retrieve / Maintain / Understand and the rest of the review branch).

---

## Key Technical Decisions

1. **Convert headless fan-out + synthesis only; keep classification, persona selection, `safe_auto` apply, rendering, and multi-round suppression in the orchestrator.** Persona selection and document classification are model judgment; `safe_auto` apply mutates the document; the R29/R30 round-2+ predicates need a decision primer the single-round workflow never receives — all stay orchestrator-side. The workflow receives a resolved persona list + the document path and does fan-out + synthesis, returning structured data. *(see origin: R1, R14)*
2. **Split synthesis by *contiguity*, not by tractability: clean-mechanical brackets → JS; the interleaved middle (3.3b–3.6) → one in-workflow synthesis agent, run in pipeline order.** The pipeline order is `3.1 → 3.2 → 3.3 → 3.3b → 3.4 → 3.5 → 3.5b → 3.5c → 3.6 → 3.7 → 3.8 → 3.9`, and the judgment steps are **interleaved with deterministic steps that carry bidirectional data dependencies** — 3.4 promotes the anchors that 3.5c's root/dependent logic reads; 3.5b sets the `recommended_action` that 3.5c's cascade and independence-safeguard need; 3.3b's demotions must be excluded from 3.4's promotion. A clean "all mechanical first, all judgment second" split therefore **inverts the order and silently breaks parity**. Resolution: the JS module owns only the *contiguous* clean-mechanical front (3.1 validate, 3.2 gate, 3.3 dedup) and back (3.7 route, 3.8 sort, 3.9 suppress, protected-artifact drop). One synthesis agent owns the *entire contiguous middle* 3.3b → 3.4 → 3.5 → 3.5b → 3.5c → 3.6 in prose order. **Cost, stated honestly:** the two deterministic steps in that block (3.4 promotion, 3.5b tie-break) become agent-mediated rather than pure-JS-deterministic; their reproducibility is held at parity by the agent's instructions and measured in U5, not guaranteed by JS. The alternative that preserves their determinism (a multi-call split that re-extracts them between agent calls) is deferred for adding agent round-trips and contract surfaces — see Alternatives Considered. *(confirmed fork + ordering correction)*
3. **Guarded fallback, not `ce_platforms: [claude]`.** `ce-doc-review` must ship to all targets, so it cannot be platform-filtered out. The `mode:headless` dispatch branches: Workflow tool present → workflow; absent (non-CC, or tool unavailable) → existing prose fan-out + Phase 3–5 synthesis. The guard is the R15 no-broken-orchestration mechanism, and stays inline in SKILL.md because it is load-bearing (`post-menu-routing-belongs-inline.md`). *(see origin: R15)*
4. **Parity-first.** The workflow reproduces the current `mode:headless` envelope; `references/findings-schema.json` + the Phase 4 headless envelope format + the doc-review contract tests are the oracle. No new rigor in the first cut.
5. **Independent parallel persona dispatch — never batched.** One `agent()` per persona with the plugin-namespaced `agentType` (`compound-engineering:ce-<persona>-reviewer`) + the findings `schema`; batching recreates the persona-bias problem the design escapes (`confidence-anchored-scoring.md`). *(see origin: R12)*
6. **Pass the document path, not content; personas Read it.** The orchestrator passes `document_path`, `document_type`, `origin_path`, and the resolved persona list in `args`; persona prompts instruct the child to Read the document and write full findings to the run dir (`pass-paths-not-content-to-subagents.md`).
7. **Personas return full findings (with `why_it_matters` + `evidence`) to the workflow runtime — no compact/detail strip.** This differs from the code-review conversion (which omitted `why_it_matters`/`evidence` from persona returns): doc-review's synthesis agent *needs* `why_it_matters` for collapse, contradiction, and chain linking. The detail stays inside the workflow runtime; only the final envelope leaves, so caller-context offload still holds. (Trade-off: this enlarges the synthesis agent's input surface — a variance consideration U5 measures.)
8. **Defensive runtime contracts, enforced up front (live-boundary learning).** Parse `args` as a possible JSON string; resolve `agentType` as the plugin-namespaced id; log dispatch failures instead of swallowing them; require a live smoke run as an acceptance gate. These are the three silent-empty-output failure modes the code-review conversion hit (`docs/solutions/skill-design/dynamic-workflow-conversion-live-boundary.md`). The synthesis agent adds a *fourth* surface — a populated-but-wrong envelope — so the live gate must assert synthesis correctness, not just non-emptiness (see U5). *(see origin: R15 — the whole class lives behind the CC-only guard)*

---

## High-Level Technical Design

*Directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
mode:headless invocation (document path [+ resolved personas])
        |
  [Orchestrator — SKILL.md, stays model-side]
  Phase 1 classify (requirements|plan)  ->  select conditional personas (judgment)
  stage document path + persona list + document_type + origin_path  ->  args
        |
  GUARD: is the Workflow tool available?
        |
   yes  v                                no -> prose fan-out + Phase 3-5 synthesis (unchanged)
  Workflow(doc-review-fanout.generated.js,
           args={run_id, personas[], document_path, document_type, origin_path})
        |
   [Workflow runtime — context-isolated]
   parallel agent() per persona (plugin-namespaced agentType + findings schema)
     each Reads the document, writes full findings -> /tmp/.../{run_id}/{persona}.json
     each returns full findings JSON (why_it_matters + evidence) to the script
        |
   merge-doc-findings.js  (MECHANICAL FRONT — deterministic, JS):
     3.1 validate -> 3.2 anchor gate -> 3.3 cross-persona dedup
        |
   synthesis agent  (JUDGMENT — one context-isolated call, runs the CONTIGUOUS
                     interleaved middle in mandated pipeline order):
     3.3b same-persona collapse -> 3.4 cross-persona promotion ->
     3.5 contradictions -> 3.5b recommended-action tie-break ->
     3.5c premise-dependency chains -> 3.6 auto-promotion (+ strawman safeguard)
     returns the annotated finding set (final anchors, recommended_action,
     collapse demotions, contradiction-combined findings, depends_on/dependents,
     promoted autofix_class) keyed by stable finding id
        |
   merge-doc-findings.js  (MECHANICAL BACK — deterministic, JS):
     3.7 route by autofix_class -> 3.8 sort -> 3.9 suppress restatements ->
     protected-artifact drop
        |
   return structured envelope (applied-fixes-to-apply [safe_auto], proposed_fixes
     [gated_auto], decisions [manual], fyi, residual_risks, deferred_questions,
     chains/dependents, coverage{dropped, chains, restated}, run_id, artifact_path)
        |
  [Orchestrator] apply safe_auto edits to the document; render the Phase 4
  headless text envelope from the returned data. (workflow never mutates the doc)
```

The orchestrator's (and its caller's) context sees only the final envelope. The interactive walk-through is **not** reached (`mode:headless`). Document mutation happens orchestrator-side, after the workflow returns.

> **Sequencing (resolved, not deferred):** the pipeline's mechanical and judgment steps *alternate* with data dependencies in both directions (3.4 feeds 3.5c; 3.5b feeds 3.5c; 3.3b feeds 3.4). A clean "all-mechanical-then-all-judgment" split would invert that order and break parity. The design above resolves it by giving the synthesis agent the **entire contiguous middle 3.3b–3.6** in prose order, so no dependency is crossed; the JS module is reduced to the two clean-mechanical brackets. The reproducibility of the two deterministic steps now inside the agent (3.4, 3.5b) is the residual parity risk U5 measures.

---

## Output Structure

New files live inside the skill directory (isolated-unit rule — no cross-skill or absolute refs), mirroring the code-review conversion's layout. `references/findings-schema.json` already exists in `ce-doc-review` and is **reused unchanged** (not created):

```
plugins/compound-engineering/skills/ce-doc-review/
  SKILL.md                          (modified: guarded mode:headless dispatch)
  workflows/                        (new)
    doc-review-fanout.js            (new: fan-out + synthesis-agent + merge orchestration; TEMPLATE)
    merge-doc-findings.js           (new: deterministic mechanical front+back module, pure)
    doc-review-fanout.generated.js  (new: committed, assembled, runnable artifact)
  references/                       (unchanged; findings-schema.json + synthesis prose reused)
scripts/
  build-doc-review-workflow.ts      (new: inlines merge module into the template)
tests/
  doc-review-merge.test.ts          (new: unit tests for merge-doc-findings.js)
  doc-review-workflow-parity.test.ts (new: U4 — converter-copy + cross-platform portability)
  doc-review-workflow-eval.test.ts  (new: U5 — build-invariants + identity-level parity + live smoke)
```

---

## Implementation Units

### U1. Port the clean-mechanical synthesis brackets into a standalone, testable JS module

**Goal:** Port the *contiguous clean-mechanical* synthesis steps (the front and back brackets) from `references/synthesis-and-presentation.md` Phase 3 prose into a pure module with no Workflow/Agent/filesystem dependencies, so they are unit-testable in isolation and reusable by the workflow around the synthesis agent.

**Requirements:** R2 (determinism/testability of the mechanical subset), R12. Advances Key Decisions 2, 4.

**Dependencies:** none (foundation).

**Files:**
- `plugins/compound-engineering/skills/ce-doc-review/workflows/merge-doc-findings.js` (new)
- `tests/doc-review-merge.test.ts` (new)

**Approach:** Implement only the steps that are a pure function of the finding set *and* sit in a contiguous mechanical bracket (no interleaved judgment), exposed as two entry points the workflow calls before and after the synthesis agent:
- **Front (`mergeFront`):** 3.1 validate against the findings-schema vocabulary (drop missing-field / invalid-enum, including legacy `auto`/`present` values; record malformed agent names for Coverage); 3.2 anchor confidence gate (drop `0`/`25` silently with a count; `50` → FYI; `75`/`100` → actionable); 3.3 cross-persona dedup by `normalize(section) + normalize(title)` (merge highest severity + highest anchor, union evidence, note agreeing reviewers, decrement losing-persona Coverage counts; **preserve opposing-action pairs** unmerged for the synthesis agent's contradiction pass).
- **Back (`mergeBack`):** 3.7 route by the anchor × `autofix_class` table (including the demotions: `75`+`safe_auto`→`gated_auto`, missing-`suggested_fix` demotions); 3.8 sort (P0→P3, errors before omissions, anchor desc, document order); 3.9 suppress restatements (residual/deferred items that section-and-substance overlap an actionable finding, with the count); protected-artifact drop (discard findings recommending deletion of files under `docs/brainstorms/`, `docs/plans/`, `docs/solutions/`). The back half consumes the synthesis agent's annotated set (final anchors, `recommended_action`, `autofix_class`, `depends_on`/`dependents` already set).
- **Steps 3.3b, 3.4, 3.5, 3.5b, 3.5c, 3.6 are NOT in this module** — they are the interleaved middle owned by the synthesis agent (U2). Do not implement cross-persona promotion or the recommended-action tie-break here.
- **Do not** re-score, re-classify, or invent findings — mechanical only. Where a step has a fuzzy edge (e.g. 3.9 substance overlap), implement the clear-cut predicate and leave borderline calls un-dropped (the prose's "when in doubt, keep").

**Patterns to follow:** `plugins/compound-engineering/skills/ce-code-review/workflows/merge-findings.js` for the **module *shape* only** (pure module, `[INTERP]` markers for any judgment the prose delegates, a strippable trailing `export`). **What does NOT transfer from that template — the field logic is rewritten, not ported:** doc-review keys dedup on `section + title` (no `line_bucket(±3)` window); there is **no** `pre_existing` separation, no `owner`/`requires_verification`, no `testing`/`maintainability` weak-signal demotion; the `autofix_class` enum is `safe_auto|gated_auto|manual` (not `gated_auto|manual|advisory`); the soft buckets are `residual_risks` + `deferred_questions` (not `residual_risks` + `testing_gaps`); the route table, the `75`+`safe_auto`→`gated_auto` demotion, the protected-artifact drop, and restatement suppression against `deferred_questions` are all doc-review-specific. Use `references/synthesis-and-presentation.md` as the authoritative step definitions and `references/findings-schema.json` as the enum oracle.

**Execution note:** Test-first — the schema and the synthesis prose define expected behavior precisely; write the merge tests before the module.

**Test scenarios:**
- *Happy path (3.3 dedup):* two personas flag the same `section`+normalized `title` → merged once, highest severity + anchor kept, both reviewers recorded, losing-persona Coverage count decremented; an opposing-action pair (one keep, one cut) is **not** merged (preserved for 3.5).
- *Anchor gate (3.2):* anchor `0`/`25` findings dropped with a drop count; anchor `50` routed to FYI; `75`/`100` to actionable. A P0 at anchor `25` is still dropped (anchor gates the surface, severity does not rescue it).
- *Route table (3.7):* `100`+`safe_auto` → apply bucket (requires `suggested_fix`, else demote to `gated_auto`); `75`+`safe_auto` → demoted to `gated_auto` (no silent apply below `100`); `50`+any → FYI, never actionable; `manual` with no `suggested_fix` → judgment framing (no demotion).
- *Restatement suppression (3.9):* a `deferred_question` that restates an actionable finding's concern (same section, overlapping nouns) → dropped, count recorded; a genuinely-new residual concern → kept.
- *Protected artifacts:* a finding whose `suggested_fix` recommends deleting a file under `docs/plans/` → discarded.
- *Sort/number (3.8):* P0 errors before P0 omissions before P1, anchor desc within type, document order as final tiebreak.
- *Malformed input (3.1):* a finding with a float `confidence` or `severity: "high"` → dropped, the rest survive, the producing persona noted for Coverage.

**Verification:** `bun test tests/doc-review-merge.test.ts` green; the existing doc-review contract/calibration tests still green (no contract drift).

---

### U2. Author the dynamic workflow script (fan-out + in-workflow synthesis agent + merge) and its build artifact

**Goal:** A Claude Code dynamic workflow that fans the selected personas out in parallel, runs U1's mechanical front, dispatches one context-isolated synthesis agent for the contiguous interleaved middle (3.3b–3.6), runs U1's mechanical back, and returns the structured envelope the headless text output is rendered from — all context-isolated from the orchestrator. Plus the build script + committed generated artifact.

**Requirements:** R2 (context offload), R12 (fanout-and-synthesize), R14 (behind the seam). Advances Key Decisions 2, 5, 6, 7, 8.

**Dependencies:** U1.

**Files:**
- `plugins/compound-engineering/skills/ce-doc-review/workflows/doc-review-fanout.js` (new — template)
- `plugins/compound-engineering/skills/ce-doc-review/workflows/doc-review-fanout.generated.js` (new — committed, assembled)
- `scripts/build-doc-review-workflow.ts` (new)

**Approach:** `export const meta` as a **pure literal** (name, description, `phases`: Fan-out, Synthesize, Merge). Parse `args` defensively (tolerate a JSON-string delivery; log and default on parse failure — never silently run all-defaults). Read `args = {run_id, personas[], document_path, document_type, origin_path}`. Dispatch one `agent()` per persona via `parallel(...)` with the plugin-namespaced `agentType` (`compound-engineering:ce-<persona>-reviewer`) and the findings `schema`; each persona prompt passes the **document path** (child Reads it), the `document_type`/`origin_path` slots, and a round-1 (empty) decision primer, and instructs the child to write full findings to `/tmp/compound-engineering/ce-doc-review/{run_id}/{persona}.json` and return the full findings object. Log per-persona dispatch failures; filter nulls and record a dropped-agent count. Run U1's `mergeFront` (3.1–3.3), dispatch **one** synthesis `agent()` for the contiguous middle, then run U1's `mergeBack` (3.7–3.9 + protected-artifact drop). Assemble and return the envelope (applied-fixes-to-apply, proposed_fixes, decisions, fyi, residual_risks, deferred_questions, chains/dependents, coverage{dropped, chains, restated, malformed/dropped_agents}, `run_id`, `artifact_path`). Report-only: **do not** apply edits, **do not** dispatch the walk-through, **do not** run R29/R30 (single-round; no primer). Degrade (`status: "degraded"`) on partial persona failure rather than throwing.

The **synthesis agent** is the load-bearing novel element and has **no template precedent** — the code-review template's only second-stage agent (`runValidation`) passes scalar fields of *one* finding and returns a 2-field `{validated, reason}` verdict; it never round-trips a full finding set. So specify its contract concretely rather than deferring it wholesale:
- *Input:* the post-`mergeFront` deduped finding array, each finding carrying a stable `id` (e.g. `normalize(section)+"|"+normalize(title)`), its `why_it_matters`/`evidence`, severity, anchor, `autofix_class`, and the merged reviewer list.
- *Task:* run 3.3b → 3.4 → 3.5 → 3.5b → 3.5c → 3.6 in that order (the prose definitions are authoritative).
- *Output (structured-output schema):* the same findings keyed by `id`, each annotated with: final `confidence` anchor (post-3.4 promotion), `recommended_action` (post-3.5b), `collapsed_to_fyi` + `variant_count` (post-3.3b), any contradiction-combined finding emitted as a new `manual` item, `depends_on` / `dependents` (post-3.5c), and promoted `autofix_class` (post-3.6). The workflow re-associates annotations to inputs by `id` and hands the result to `mergeBack`.
- Because 3.3b and 3.4 now run adjacent *inside one agent*, the collapse-exclusion rule ("demoted variants do not participate in cross-persona promotion") is enforced internally — no cross-stage flag is needed.

The build script (`scripts/build-doc-review-workflow.ts`) inlines `merge-doc-findings.js` (minus its trailing `export`) at a `/* __MERGE_MODULE__ */` marker and writes the generated artifact with a "DO NOT EDIT" header — a direct adaptation of `scripts/build-review-workflow.ts`.

**Patterns to follow:** `plugins/compound-engineering/skills/ce-code-review/workflows/code-review-fanout.js` (pure-literal `meta`, defensive `args` parse, `parallel` schema'd dispatch, `.catch` that logs, envelope return); `scripts/build-review-workflow.ts` (marker inlining, trailing-`export` strip, generated header); `docs/solutions/skill-design/dynamic-workflow-conversion-live-boundary.md` (the three runtime contracts); `references/subagent-template.md` (the persona prompt contract + schema slots); `references/synthesis-and-presentation.md` (the judgment passes the synthesis agent must reproduce, in order).

**Execution note:** Parity-first — mirror current persona dispatch + the synthesis passes' outcomes; no added verification rounds.

**Test scenarios:**
- *Test expectation: integration/manual* — a live Workflow run cannot be asserted in `bun test`. Cover the mechanical brackets via U1's unit tests and the synthesis agent + envelope via the U5 live smoke run. Confirm the returned envelope carries populated `run_id` + `artifact_path`, non-zero subagent execution, and renders to the existing headless text envelope.
- *Static checks (assertable, in U5's eval file):* the script parses; `meta` is a pure literal (no `${...}`, no spread); `args` destructuring tolerates empty personas without throwing; the persona `agentType` is the plugin-namespaced form (bare `ce-*` does not resolve in `agent()`); dispatch failures are logged; the synthesis-agent dispatch is present and schema'd.

**Verification:** A real `mode:headless` invocation returns an envelope that renders to the current headless text shape; per-persona artifacts present under the run dir; orchestrator context shows only the final envelope (no persona findings inlined). `bun run scripts/build-doc-review-workflow.ts` regenerates the committed artifact with no diff.

---

### U3. Wire the guarded `mode:headless` dispatch in SKILL.md

**Goal:** Branch the headless-mode dispatch to the workflow when the Workflow tool is available, falling back to the existing prose fan-out + Phase 3–5 synthesis otherwise — without touching interactive/default mode, classification, persona selection, or the walk-through.

**Requirements:** R1 (gate: headless sub-step only), R15 (guarded fallback mechanism). Advances Key Decisions 1, 3.

**Dependencies:** U2.

**Files:**
- `plugins/compound-engineering/skills/ce-doc-review/SKILL.md` (modified)

**Approach:** At the Phase 2 dispatch point, *inside the headless-mode branch only*, add the guard: if the Workflow tool is available, stage `document_path` + the resolved persona list + `document_type` + `origin_path` to `args` and invoke `doc-review-fanout.generated.js`, then apply the returned `safe_auto` (anchor `100`) fixes to the document and render the Phase 4 headless text envelope from the returned data. Else, run the existing prose dispatch + the `references/synthesis-and-presentation.md` Phase 3–5 path unchanged. Keep Phase 1 (classification + persona selection) and the headless envelope *format* as the shared front/back. Preserve the report-only contract (headless never fires interactive questions), the protected-artifact rule, and the "Review complete" terminal signal. State the script path with a co-located relative reference; resolution is verified in U4. Keep the guard inline (load-bearing); the prose fallback stays inline for now (relocation deferred).

**Patterns to follow:** `plugins/compound-engineering/skills/ce-code-review/SKILL.md` (the `mode:agent` Workflow-acceleration guard + prose-fallback subsection, ~lines 353–364); existing `ce-doc-review/SKILL.md` Phase 0 mode-parsing and Phase 2 dispatch; `docs/solutions/skill-design/post-menu-routing-belongs-inline.md` (load-bearing routing stays inline).

**Test scenarios:**
- Guard true (Workflow available) → workflow invoked, its envelope rendered; orchestrator applies `safe_auto` and adds no second synthesis pass.
- Guard false → prose fan-out + Phase 3–5 produces an equivalent headless envelope (covered by U5 parity).
- Default/interactive invocation (no `mode:headless`) → no workflow; routing question and walk-through path unchanged.
- A finding recommending deletion of a `docs/plans/` file → dropped on both branches (protected-artifact invariant preserved).

**Verification:** Manual review of both branches; interactive-mode behavior unchanged; U5 parity eval passes on the workflow branch.

---

### U4. Verify the converter ships the skill intact to non-CC targets

**Goal:** Confirm the new `workflows/` files and the guarded Workflow-tool prose survive conversion to Codex/OpenCode/Gemini without breaking the skill or emitting broken orchestration — and resolve the workflow script-path resolution question.

**Requirements:** R15. Advances Key Decision 3.

**Dependencies:** U3.

**Files:**
- `tests/doc-review-workflow-parity.test.ts` (new — owns *only* converter-copy + cross-platform-portability assertions)
- possibly `src/converters/*` / writers (only if a gap is found — not expected; the isolated-unit copy + `filterSkillsByPlatform` already handle this)

**Approach:** Verify (a) `ce-doc-review` is **not** dropped on non-CC targets — do *not* set `ce_platforms: [claude]`; (b) the converter copies the skill's `workflows/` subdir as part of the isolated-unit copy; (c) the Codex content transform (`src/utils/codex-content.ts`) and the OpenCode skill transform do not mangle the guarded "Workflow tool" prose or the `.js` references; (d) the converted SKILL.md retains the prose fallback so a non-CC install runs the fallback synthesis path. Resolve the **scriptPath resolution** unknown the code-review conversion already faced: its template resolved it by reading the generated file and passing its contents as the Workflow `script` arg (not a skill-relative `scriptPath`) — **confirm that answer transfers** before relying on it, since doc-review's build inlines a different module; obey the platform-var fallback rule (no unguarded `${CLAUDE_*}`).

**Patterns to follow:** `tests/review-workflow-parity.test.ts` (the "cross-platform portability" describe block — Codex/OpenCode transform survival, no `ce_platforms` filter); `src/types/claude.ts` `filterSkillsByPlatform`; `docs/solutions/integrations/colon-namespaced-names-break-windows-paths.md`; `docs/solutions/adding-converter-target-providers.md`; AGENTS.md "File References in Skills" + "Platform-Specific Variables in Skills".

**Test scenarios:**
- Convert to Codex → `ce-doc-review` present; `workflows/doc-review-fanout.generated.js` + `merge-doc-findings.js` copied; no broken slash/tool rewrites in the guarded prose.
- Convert to OpenCode → skill present; fallback prose fan-out + synthesis intact and self-contained.
- Assert `ce_platforms` is unset (or includes all targets) on `ce-doc-review` so it is never filtered out.

**Verification:** `bun run release:validate` passes; `bun test` green; manual diff of converted Codex/OpenCode SKILL.md shows an intact fallback and no dangling Workflow-only instruction as the sole path.

---

### U5. Parity validation + live smoke run

**Goal:** Prove the workflow path reproduces the prose path's `mode:headless` envelope at finding-identity level (not just counts) — and that the live path actually dispatches agents *and synthesizes correctly* — before this becomes the default CC headless path.

**Requirements:** R2, R12 (parity-first). Advances Key Decisions 4, 8.

**Dependencies:** U2, U3.

**Files:**
- `tests/doc-review-workflow-eval.test.ts` (new — build-invariants + identity-level parity + live smoke; distinct from U4's portability file)
- eval fixtures under `tests/fixtures/` (small synthetic requirements + plan docs covering: clean doc, P0 present, cross-persona agreement, same-persona premise cluster, a **known** contradiction pair, a **known** premise-dependency chain (one root + 2 dependents), a `safe_auto`-at-anchor-100 fix, a protected-artifact-deletion finding, malformed-return injection)

**Approach:** Assert the build/assembly invariants (freshness vs sources, `meta` first + pure-literal, syntactic validity, args-string parse present, plugin-namespaced `agentType`, dispatch-failure logging, synthesis-agent dispatch present) — the same battery `tests/review-workflow-parity.test.ts` runs. For each fixture, run the mechanical brackets (U1) deterministically (exact-assert) and compare the rendered headless envelope between the workflow and prose paths.

**Identity-level parity (not just counts).** Counts are insufficient: a run can produce identical "N roots / M dependents" while linking *different* findings, or collapse to a *different* representative, and pass a count check. For the chain and collapse fixtures, assert the **specific root finding id, the exact `depends_on` set, and the surviving-representative id** against the fixture's known-correct linkage as ground truth — not merely workflow-vs-prose count agreement (which can be jointly wrong).

**Variance, measured against baseline.** Follow `safe-auto-rubric-calibration.md`: N≥3 trials per fixture on the model-mediated steps. The mechanical brackets must show variance = 0. For the synthesis agent, **compare its variance against the current in-context synthesis variance on the same chains/collapse/contradiction fixtures** and define a fail threshold if the relocated agent's variance *exceeds* that baseline — the claim is parity-or-better, so a regression must fail the gate. Keep a negative-control fixture; do not accept "identical output" without sampling real findings (`ce-pipeline-end-to-end-learnings.md`).

**Live smoke run is a required acceptance gate** (`dynamic-workflow-conversion-live-boundary.md`), and it must assert *synthesis correctness*, not just liveness: run the real Workflow against a bounded fixture (a 2–3 persona subset on a small doc that plants one known premise-chain root + 2 dependents and one known contradiction pair) and assert (a) `status: complete`, a non-empty `reviewers` list, non-zero subagent execution; (b) the planted chain renders with the correct root and correctly nested dependents, and the contradiction renders as a combined `manual` finding. Add a diagnostic: if `reviewers` is empty, assert the dispatch-failure log is non-empty (distinguishes silent-empty from legitimate-zero).

**Execution note:** The merge brackets (U1) are exact-assertable; the persona fan-out and the synthesis agent are model-mediated — assert envelope contract + identity-level linkage + variance-vs-baseline, not verbatim text.

**Test scenarios:**
- *Deterministic brackets:* `mergeFront`/`mergeBack` output is byte-identical across repeated runs on fixed inputs (variance = 0).
- *Envelope parity:* the workflow-path envelope renders to the headless text shape and matches the prose path on persona set, actionable-finding count after gate, severity ordering, and FYI/dropped/restated counts.
- *Identity-level parity:* for the chain fixture, the root id and `depends_on` set match the fixture ground truth on both paths; for the collapse fixture, the surviving-representative id matches.
- *Negative control:* a fixture with an injected malformed persona return drops exactly the malformed finding on both paths and records the producing persona in Coverage.
- *Safety regression:* a protected-artifact-deletion finding is dropped on both paths; a `safe_auto`-at-anchor-100 fix lands on both paths.
- *Live gate (synthesis correctness):* a real bounded Workflow run returns `status: complete`, a non-empty `reviewers` list, non-zero subagent execution, the correct planted chain root + nested dependents, and the planted contradiction as a combined `manual` finding — not merely a non-empty schema-valid envelope.

**Verification:** Eval report shows identity-level envelope parity and variance-at-or-below-baseline on the synthesis agent; the live smoke run passes its synthesis-correctness assertions; all new + existing tests green.

---

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Silent empty/degraded output that passes every static test (args unparsed, bare `agentType`, swallowed dispatch error) | High — a machine-handoff path (called by ce-plan/ce-brainstorm) silently stops finding anything | The three runtime contracts (Key Decision 8) designed in up front; dispatch-failure logging; U5's **live smoke run as a required gate** (`dynamic-workflow-conversion-live-boundary.md`) |
| **Populated-but-wrong synthesis** — the agent returns a full, schema-valid envelope whose chains/collapse/contradictions are silently mis-resolved | High — parity regression invisible to non-emptiness checks and to count-only parity asserts | U5 asserts **identity-level** linkage (root id, `depends_on` set, representative id) against fixture ground truth, and the **live gate asserts the planted chain/contradiction resolve correctly**, not just that the envelope is non-empty |
| Synthesis-agent variance drifts the envelope from the prose path (relocating the judgment passes to a fresh agent changes the prompt surface; full evidence is round-tripped) | Medium | U5 measures the agent's variance **against the in-context baseline** with a fail threshold on regression; parity-first scope (no added rigor to muddy the signal); the mechanical brackets stay deterministic as an anchor |
| Synthesis-agent round-trip shape has no template precedent (array-in / annotated-array-out via structured output) | Medium — the load-bearing novel element, unspecified would block U1's back-half | U2 specifies the agent's input/output schema concretely (stable-id keying, the annotation fields `mergeBack` consumes); exercised in the U5 live smoke, not only static tests |
| 3.4/3.5b reproducibility now agent-mediated (folded into the synthesis agent to preserve pipeline order) | Medium | U5 variance-vs-baseline covers it; the determinism-preserving multi-call split is documented as the deferred alternative if variance proves unacceptable |
| Workflow script-path won't resolve from the skill dir at runtime | Medium — blocks U2/U3 | U4 resolves it explicitly and **confirms** the code-review answer transfers (doc-review inlines a different module); flagged as the key execution-time unknown |
| Converter mangles guarded Workflow prose or omits `workflows/` on non-CC targets → broken install | Medium | U4 converter tests; fallback prose retained inline; no `ce_platforms: [claude]` |
| `safe_auto` apply boundary mishandled (workflow mutates the doc, or the orchestrator double-applies) | Medium — document corruption or drift | Key Decision 1 + U3: the workflow is strictly report-only and returns a fixes-to-apply list; the orchestrator is the sole applier; U5 asserts the fix lands once |
| Workflow primitive limits shift (concurrency caps, research-preview) | Low | Don't over-fit numeric caps (origin Dependencies); bounded `parallel`, degrade on partial failure |

---

## Alternatives Considered

**Synthesis-pipeline split — how to map the interleaved pipeline onto JS + agents (chosen: clean-mechanical brackets in JS, the contiguous middle 3.3b–3.6 in one synthesis agent).**

- **Brackets-in-JS, contiguous-middle-in-one-agent (chosen).** JS owns the front (3.1–3.3) and back (3.7–3.9); one synthesis agent owns 3.3b–3.6 in prose order. Preserves the pipeline's data dependencies (3.3b→3.4, 3.4→3.5c, 3.5b→3.5c) with a single agent round-trip, gives full context offload, and keeps judgment at model quality. Cost: the two deterministic steps in the block (3.4 promotion, 3.5b tie-break) lose pure-JS determinism — held at parity by the agent and measured in U5.
- **All-mechanical-then-all-judgment split (rejected — it was the original draft).** Run every mechanical step in JS and every judgment step in the agent as two clean stages. Rejected because the steps **interleave with bidirectional data dependencies**: 3.4 (mechanical) is prose-ordered *between* 3.3b and 3.5 (judgment), and 3.5c (judgment) consumes 3.4's promoted anchors and 3.5b's `recommended_action`. A clean split inverts the order and silently breaks parity — the central correction this plan makes.
- **Multi-call split to preserve 3.4/3.5b determinism (deferred to follow-up).** Re-extract the two deterministic interleaved steps into JS by running three agent calls (`3.3b` | JS `3.4` | `3.5` | JS `3.5b` | `3.5c,3.6`). Preserves their determinism but adds two more agent round-trips — each a fresh silent-empty-output contract surface the live-boundary learning warns about — and more I/O. Deferred: revisit only if U5 shows the folded 3.4/3.5b variance is unacceptable.
- **Full deterministic JS port of the judgment passes (rejected).** Port collapse/contradiction/chaining into JS heuristics too. Fuzzy semantic clustering and chain-root identification in JS is brittle and carries the highest parity-drift risk; rejected for the lowest-risk first cut.

**Conversion surface — headless-only first vs. interactive too (chosen: headless-only).** Wiring interactive mode to reuse the workflow now is broader and higher-risk (the walk-through consumes `recommended_action`, chain/dependent structure, and conflict-context). Converting `mode:headless` first mirrors the code-review conversion's "one path first, defer the other" precedent and isolates the parity signal. Interactive reuse is deferred to follow-up.

---

## Deferred / Open Questions (resolve at implementation)

- **Exact synthesis-agent output-schema field names** (U2) — U2 sketches the contract (stable-id keying; the annotation fields `mergeBack` consumes); finalize the exact field names and the structured-output schema shape when wiring U2 against U1's back-half. The *sequencing* is no longer open — the fold into one agent resolved it.
- **Script-path resolution mechanism** (U4) — confirm the code-review conversion's "read the generated file, pass `script` inline" answer transfers given doc-review inlines a different module; decide against live harness behavior, not assumption.
- **Folded-step variance acceptability** (U5) — whether 3.4/3.5b's agent-mediated reproducibility stays within tolerance, or whether the deferred multi-call split is warranted.
- **Whether interactive mode should later reuse the workflow** — deferred; this plan touches `mode:headless` only.
- **Stable/beta + skill-doc sync** — confirm `ce-doc-review` has no `-beta` counterpart to sync (none observed); the change is internal to headless synthesis mechanics, so `docs/skills/ce-doc-review.md` likely needs no update — state the sync decision explicitly at commit per AGENTS.md.

---

## Open decision for you (non-blocking)

I planned **parity-first** — the workflow reproduces the current `mode:headless` envelope, with adversarial-verify of survivors / loop-until-dry deferred. The alternative is to fold one rigor layer (e.g., adversarial-verify of surviving P0/P1 findings) into the first cut, since the workflow makes it cheap. I default to parity-first because this is the designated *lowest-risk, pattern-proving* second conversion and mixing in rigor muddies the parity signal against the headless oracle. Say the word and I'll fold an adversarial-verify round into U2 + U5 instead of deferring it.
