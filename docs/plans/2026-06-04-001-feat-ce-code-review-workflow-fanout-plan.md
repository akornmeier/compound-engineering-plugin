---
status: active
type: feat
created: 2026-06-04
origin: docs/brainstorms/2026-06-04-dynamic-workflows-opportunity-map-requirements.md
related: docs/plans/2026-06-04-dynamic-workflows-opportunity-map-plan.md
---

# feat: Convert ce-code-review report-only fan-out to a dynamic workflow

## Summary

Move `ce-code-review`'s **report-only fan-out sub-step** (`mode:agent`: parallel persona dispatch + deterministic merge/dedup) off hand-orchestrated prose and onto a Claude Code **dynamic workflow**. The orchestrator keeps scope detection, intent discovery, and persona *selection* (model judgment); it then hands the selected personas + staged diff paths to a workflow script that fans the reviewers out in the background and runs the merge/dedup as deterministic JS, returning only the final `mode:agent` JSON. Intermediate per-persona output never reaches the orchestrator's context.

This is the brainstorm's named **first conversion** — lowest-risk, pattern-proving — and the template every later memory-loop conversion will copy. **Parity-first:** the converted path must reproduce the current `mode:agent` JSON; added rigor (adversarial-verify, loop-until-dry) is deferred.

**Why `feat` not `refactor`:** output is held at parity, but the change introduces the plugin's first dynamic-workflow integration — a new capability and the reusable pattern for the opportunity map. The commit author may downgrade to `refactor`/`perf` if they weigh the parity constraint as the dominant intent.

---

## Problem Frame

`ce-code-review`'s `mode:agent` path already stages per-persona JSON to `/tmp` and returns compact results, so the **marginal** win over today's baseline (R2's required comparison point — not over interactive mode) is specific:

1. **Context offload** — today the orchestrator still receives every persona's compact return *into its own context* and performs Stage 5 merge/dedup *by in-context reasoning*. A workflow holds the persona returns and merge working-memory in the script runtime; the orchestrator context receives only the final merged JSON.
2. **Determinism + testability** — Stage 5's mechanical steps (fingerprint dedup, anchor-step promotion, demotion, confidence gate, sort/number) are currently prose the model executes by reasoning, with run-to-run variance. Ported to a JS module they become reproducible and unit-testable for the first time.

These are real but bounded; the plan keeps the scope honest rather than overclaiming.

**Requirements advanced (origin):** R12 (ce-code-review as the review-branch candidate), R1 (non-interactive gate — only the report-only sub-step converts; interactive apply stays out), R2 (context-offload, marginal-over-headless), R14 (loose coupling — the workflow sits behind the existing `mode:agent` seam; no memory-loop dependency), R15 (CC-only with a guarded non-CC fallback). Patterns proven: **fanout-and-synthesize**; adversarial-verify / loop-until-dry deferred.

---

## Scope Boundaries

**In scope**
- A dynamic workflow that fans out the *already-selected* personas and runs the merge/dedup, returning the `mode:agent` JSON envelope.
- A standalone, unit-tested JS merge module (the ported Stage 5 mechanical logic).
- A guarded `mode:agent` entry in SKILL.md: workflow when the Workflow tool is available, existing prose Stage 4+5 otherwise.
- Parity validation against the existing contract test + an A/B eval; converter verification that the skill still ships intact to non-CC targets.

**Out of scope (non-goals)**
- Interactive/default mode and the Stage 5c apply/commit/test stage — untouched.
- Persona *selection* judgment (Stage 3) moving into the workflow — stays model-side per the script/model boundary.

**Deferred to Follow-Up Work**
- Added rigor inside the workflow: adversarial-verify of survivors, loop-until-dry, judge-panel. (Enabled by this conversion; intentionally not in the first cut.)
- Converting *default-mode* fan-out to reuse the workflow (then apply in the shell).
- SKILL.md body-size reduction by relocating the prose fallback to an on-demand reference.
- The other opportunity-map candidates (Capture / Retrieve / Maintain / Understand and the rest of the review branch).

---

## Key Technical Decisions

1. **Convert Stages 4–5 only; keep Stages 1–3 and the JSON envelope in the orchestrator.** Persona selection is model judgment (`script-first-skill-architecture.md` explicitly fences code-review judgment as model work). The workflow receives a resolved persona list + staged paths and does mechanical fan-out + merge. *(see origin: R2, R14)*
2. **Guarded fallback, not `ce_platforms: [claude]`.** ce-code-review must ship to all targets, so it cannot be platform-filtered out. The `mode:agent` entry branches: Workflow tool present → workflow; absent (non-CC, or tool unavailable) → existing prose Stage 4+5. The guard is the R15 no-broken-orchestration mechanism. The guard + invocation are load-bearing → stay inline in SKILL.md (`post-menu-routing-belongs-inline.md`). *(see origin: R15)*
3. **Parity-first.** The workflow reproduces current `mode:agent` output; `references/findings-schema.json` + `tests/review-skill-contract.test.ts` are the oracle. No new rigor in the first cut.
4. **Independent parallel persona dispatch — never batched.** One `agent()` per persona with `agentType` + `schema`; batching recreates the persona-bias problem the design escapes (`confidence-anchored-scoring.md`). *(see origin: R12)*
5. **Report-only keeps its distinct behavior:** skip Stage 5b validation; *demote* (not suppress) weak P2/P3 advisory testing/maintainability findings to soft buckets. Highest-risk regression — guarded by tests.
6. **Pass paths, not content.** The orchestrator stages `full.diff` / `files.txt` / standards paths to the run dir and passes paths in `args`; the workflow's persona prompts instruct the child to Read them (`pass-paths-not-content-to-subagents.md`).
7. **Explicit JS error handling.** Drop-on-timeout / drop-on-malformed conservatively with counts, backstop at merge — not crash-on-first-error (`codex-delegation-best-practices.md`, `prefer-python-over-bash-for-pipeline-scripts.md` real principle).

---

## High-Level Technical Design

*Directional guidance for review, not implementation specification. The implementing agent should treat it as context, not code to reproduce.*

```
mode:agent invocation
        |
  [Orchestrator — SKILL.md, stays model-side]
  Stage 1 scope detect  ->  Stage 2 intent  ->  Stage 3 persona selection (judgment)
  stage diff + standards to /tmp/compound-engineering/ce-code-review/{run_id}/
        |
  GUARD: is the Workflow tool available?
        |
   yes  v                                   no -> Stage 4+5 prose fallback (unchanged)
  Workflow(code-review-fanout.js, args={run_id, personas[], diffPaths, standardsPaths, prFlags})
        |
   [Workflow runtime — context-isolated]
   parallel agent() per persona (agentType + schema)
     each writes full artifact -> /tmp/.../{run_id}/{reviewer}.json
     each returns compact findings JSON to the script
        |
   merge-findings.js (deterministic):
     validate -> dedup(fingerprint) -> cross-reviewer anchor-step promotion
     -> separate pre-existing -> normalize routing -> mode-aware demotion
     -> confidence gate (>=75; P0 escapes at 50) -> partition -> sort/number
     -> union coverage -> preserve CE-agent artifacts
        |
   return mode:agent JSON envelope  (status, verdict, scope, findings, ...,
                                     artifact_path, run_id)
        |
  [Orchestrator] returns the workflow's JSON verbatim — no re-merge, no apply
```

The orchestrator's context sees only the final envelope. Stage 5b validator is **not** invoked (report-only). Stage 5c apply is **not** reached (`mode:agent`).

---

## Output Structure

New files live inside the skill directory (isolated-unit rule — no cross-skill or absolute refs):

```
plugins/compound-engineering/skills/ce-code-review/
  SKILL.md                         (modified: guarded mode:agent entry)
  workflows/                       (new)
    code-review-fanout.js          (new: fan-out + merge orchestration)
    merge-findings.js              (new: deterministic merge module, pure)
  references/                      (unchanged; schema + templates reused)
tests/
  review-merge.test.ts             (new: unit tests for merge-findings.js)
  review-workflow-parity.test.ts   (new: A/B parity + converter-copy checks)
```

---

## Implementation Units

### U1. Extract deterministic merge/dedup into a standalone, testable JS module

**Goal:** Port Stage 5's mechanical pipeline from SKILL.md prose into a pure function with no Workflow/Agent dependencies, so it is unit-testable in isolation and reusable by the workflow.

**Requirements:** R2 (determinism/testability), R12. Advances Key Decisions 3, 5.

**Dependencies:** none (foundation).

**Files:**
- `plugins/compound-engineering/skills/ce-code-review/workflows/merge-findings.js` (new)
- `tests/review-merge.test.ts` (new)

**Approach:** Input = array of validated per-persona compact returns; output = the merged structures the `mode:agent` envelope needs (primary findings, actionable queue, pre-existing, residual_risks, testing_gaps, coverage, drop/suppress/demote counts). Implement, in order, the steps documented in SKILL.md Stage 5 and `confidence-anchored-scoring.md`: validate against the schema vocabulary; dedup by fingerprint `normalize(file) + line_bucket(line, ±3) + normalize(title)` keeping highest severity + anchor; cross-reviewer agreement promotes one anchor step (50→75→100, integer anchors only — never float); separate `pre_existing`; normalize routing (conservative on disagreement; remap legacy `safe_auto`/`review-fixer`); mode-aware demotion of P2/P3 + advisory + *all-contributors-testing/maintainability* into `testing_gaps`/`residual_risks`; confidence gate suppress <75 except P0 at ≥50; partition actionable vs report-only; sort severity→anchor desc→file→line with monotonic `#`; union coverage; preserve CE-agent artifacts untouched. **Do not** re-score or re-classify findings — mechanical only.

**Patterns to follow:** `references/findings-schema.json` (confidence integer enum `[0,25,50,75,100]`, floats rejected), SKILL.md Stage 5 (lines ~406–444), `confidence-anchored-scoring.md`, `script-first-skill-architecture.md` (script owns deterministic work only).

**Execution note:** Test-first — the schema and existing contract test define the expected behavior precisely; write the merge tests before the module.

**Test scenarios:**
- Two reviewers flag same file within ±3 lines with matching normalized title → merged once, highest severity + anchor kept, both reviewers recorded.
- Cross-reviewer agreement: a finding at anchor 50 flagged by 2 personas → promoted to 75; 75→100; 100 stays 100.
- `pre_existing: true` findings pulled into the separate list, absent from primary.
- P2 advisory finding contributed *only* by testing reviewer → demoted to `testing_gaps`; only by maintainability → `residual_risks`; if any other persona also flagged it → stays primary.
- Confidence gate: anchor-50 P1 suppressed; anchor-50 **P0** survives (escape hatch); suppressed counts recorded by anchor.
- Sort/number: severity (P0 first) → anchor desc → file → line, `#` monotonic across the full set (no per-severity restart).
- Malformed finding (bad severity / float confidence / line ≤ 0) dropped, drop count returned; rest survive.
- Routing disagreement (security P0 vs correctness P1 same region) → keeps conservative route, annotates contributors.

**Verification:** `bun test tests/review-merge.test.ts` green; existing `tests/review-skill-contract.test.ts` still green (no contract drift).

---

### U2. Author the dynamic workflow script (fan-out + merge)

**Goal:** A Claude Code dynamic workflow that fans the selected personas out in parallel, stages full artifacts, collects compact returns, calls U1's merge, and returns the `mode:agent` JSON envelope — all context-isolated from the orchestrator.

**Requirements:** R2 (context offload), R12 (fanout-and-synthesize), R14 (behind the seam). Advances Key Decisions 1, 4, 6, 7.

**Dependencies:** U1.

**Files:**
- `plugins/compound-engineering/skills/ce-code-review/workflows/code-review-fanout.js` (new)

**Approach:** `export const meta` as a **pure literal** (name, description, phases: Fan-out, Merge). Read `args = {run_id, personas[], diffPaths, standardsPaths, prFlags}`. Dispatch one `agent()` per persona via `parallel(...)` with `agentType` set to the `ce-*` reviewer and `schema` set to the compact findings contract; each persona prompt passes the staged **paths** (not content) and instructs the child to write its full artifact to `/tmp/compound-engineering/ce-code-review/{run_id}/{reviewer}.json`. Filter nulls (skipped/failed agents), record drop counts, then call `merge-findings.js`. Assemble and return the envelope (`status`, `verdict`, `scope`, `intent`, `reviewers`, `findings`, `actionable_findings`, `pre_existing_findings`, coverage fields, `artifact_path`, `run_id`). Report-only: **do not** dispatch Stage 5b validators. Handle partial failure by degrading (`status: "degraded"`) rather than throwing.

**Patterns to follow:** `~/.claude/workflows/mine-claude-md-from-sessions.js` (pure-literal meta, `parallel`/`pipeline`, schema'd agents, loop/΅filter discipline); SKILL.md Stage 4 dispatch rules (bounded concurrency, model tiering — session model for correctness/security/adversarial, sonnet for the rest); `pass-paths-not-content-to-subagents.md`.

**Execution note:** Parity-first — mirror current dispatch + envelope exactly; no added verification rounds.

**Test scenarios:**
- *Test expectation: integration/manual* — a live Workflow run cannot be asserted in `bun test`. Cover the logic via U1's unit tests and U5's parity eval. Smoke-verify a real `mode:agent` review end-to-end and confirm the returned envelope validates against `findings-schema.json` and carries a populated `artifact_path` + `run_id`.
- Static check (assertable): the script parses, `meta` is a pure literal (no computed values), and `args` destructuring tolerates a missing `prFlags`/empty personas without throwing.

**Verification:** A real `mode:agent` invocation returns a schema-valid envelope; per-persona artifacts present under the run dir; orchestrator context shows only the final envelope (no persona returns inlined).

---

### U3. Wire the guarded `mode:agent` entry in SKILL.md

**Goal:** Branch the `mode:agent` path to the workflow when the Workflow tool is available, falling back to the existing prose Stage 4+5 otherwise — without touching interactive/default mode or Stage 5c.

**Requirements:** R1 (gate: report-only only), R15 (guarded fallback mechanism). Advances Key Decisions 2, 3.

**Dependencies:** U2.

**Files:**
- `plugins/compound-engineering/skills/ce-code-review/SKILL.md` (modified)

**Approach:** At the Stage 4 entry, *inside the `mode:agent` branch only*, add the guard: if the Workflow tool is available, stage diff/standards to the run dir, invoke `code-review-fanout.js` with the selected personas + paths, and return its JSON verbatim — orchestrator does not re-merge or apply. Else, run the existing prose Stage 4+5 unchanged. Keep Stages 1–3 and the JSON-envelope description as the shared front/back. Preserve the scope invariant (pr-remote/branch-remote still report, never apply) and the "skip Stage 5c in `mode:agent`" rule. State the script path with a co-located relative reference and a note that resolution is verified in U4. Keep the guard + invocation inline (load-bearing); the prose fallback stays inline for now (relocation deferred).

**Patterns to follow:** SKILL.md existing mode-parsing (lines ~19–48) and the Stage 5c skip seam (line ~477); `post-menu-routing-belongs-inline.md` (load-bearing routing stays inline).

**Test scenarios:**
- Guard true (Workflow available) → workflow invoked, its envelope returned; orchestrator adds no second merge.
- Guard false → prose Stage 4+5 produces an equivalent envelope (covered by U5 parity).
- Default/interactive invocation (no `mode:agent`) → no workflow, Stage 5c apply path unchanged.
- `pr-remote` scope under `mode:agent` → reports, never applies (invariant preserved on both branches).

**Verification:** Manual review of both branches; default-mode behavior unchanged; U5 parity eval passes on the workflow branch.

---

### U4. Verify the converter ships the skill intact to non-CC targets

**Goal:** Confirm the new `workflows/` files and the guarded Workflow-tool prose survive conversion to Codex/OpenCode/Gemini without breaking the skill or emitting broken orchestration — and resolve the workflow script-path resolution question.

**Requirements:** R15. Advances Key Decision 2.

**Dependencies:** U3.

**Files:**
- `tests/review-workflow-parity.test.ts` (new — converter-copy assertions; shared with U5) or an existing converter test file
- possibly `src/converters/*` / writers (only if a gap is found — not expected; `filterSkillsByPlatform` + body-copy already handle this)

**Approach:** Verify (a) ce-code-review is **not** dropped on non-CC targets — do *not* set `ce_platforms: [claude]`; (b) the converter copies the skill's `workflows/` subdir as part of the isolated-unit copy; (c) Codex content-rewriting (`src/utils/codex-content.ts` slash/tool handling) does not mangle the guarded "Workflow tool" prose or the `.js` references; (d) the converted SKILL.md retains the prose fallback so a non-CC install runs the fallback path. Resolve the **scriptPath resolution** unknown: determine whether the skill references the workflow via a skill-relative `scriptPath` the harness resolves to the skill dir, or whether it must Read the co-located file and pass `script` inline — adopt whichever resolves correctly and obey the platform-var fallback rule (no unguarded `${CLAUDE_*}`).

**Patterns to follow:** `src/types/claude.ts` `filterSkillsByPlatform`, `plugins/compound-engineering/skills/ce-update/SKILL.md` (`ce_platforms` precedent — the counter-example here), `docs/solutions/integrations/colon-namespaced-names-break-windows-paths.md`, `adding-converter-target-providers.md`, AGENTS.md "File References in Skills" + "Platform-Specific Variables".

**Test scenarios:**
- Convert to Codex → ce-code-review present in output; `workflows/code-review-fanout.js` + `merge-findings.js` copied; no broken slash/tool rewrites in the guarded prose.
- Convert to OpenCode → skill present; fallback Stage 4+5 prose intact and self-contained.
- Assert `ce_platforms` is unset (or includes all targets) on ce-code-review so it is never filtered out.

**Verification:** `bun run release:validate` passes; `bun test` green; manual diff of converted Codex/OpenCode SKILL.md shows an intact fallback and no dangling Workflow-only instruction as the sole path.

---

### U5. Parity validation + A/B eval harness

**Goal:** Prove the workflow path reproduces the prose path's `mode:agent` output within acceptable variance before this becomes the default CC path.

**Requirements:** R2, R12 (parity-first). Advances Key Decision 3.

**Dependencies:** U2, U3.

**Files:**
- `tests/review-workflow-parity.test.ts` (new — or extend U4's)
- eval fixtures under `tests/fixtures/` (small synthetic diffs covering: clean diff, P0 present, cross-reviewer agreement, demotion-eligible findings, malformed-return injection, migration-gated personas)

**Approach:** For each fixture, run the merged output through both the JS merge (deterministic, exact-assert) and — where feasible — compare envelope shape/fields between workflow and prose paths. Follow `safe-auto-rubric-calibration.md`: N≥3 trials per fixture on any model-mediated step, measure **variance reduction** (the deterministic merge should *reduce* variance vs in-context merge), keep a negative-control fixture, and do not accept "identical output" without sampling real findings (`ce-pipeline-end-to-end-learnings.md`).

**Execution note:** The merge module (U1) is exact-assertable; the persona fan-out is model-mediated — assert envelope contract + variance, not verbatim text.

**Test scenarios:**
- Deterministic merge output is byte-identical across repeated runs on a fixed persona-return set (variance = 0).
- Envelope from the workflow path validates against `findings-schema.json` and matches the prose path on: reviewer set, finding count after gate, severity ordering, suppressed/demoted counts.
- Negative control: a fixture with an injected malformed return drops exactly one finding on both paths.
- P0-at-anchor-50 survives on both paths (regression guard for the escape hatch).

**Verification:** Eval report shows parity within tolerance and variance reduction on the merge step; all new + existing tests green.

---

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| Report-only behavior drifts (Stage 5b validation accidentally added, or weak findings suppressed instead of demoted) | High — silent quality regression | U1 test scenarios assert demotion-not-suppression and no validator; `confidence-anchored-scoring.md` is the spec; contract test stays green |
| Workflow script-path won't resolve from the skill dir at runtime | Medium — blocks U2/U3 | U4 resolves it explicitly (skill-relative `scriptPath` vs inline `script`); flagged as the key execution-time unknown |
| Converter mangles guarded Workflow prose or omits `workflows/` on non-CC targets → broken install | Medium | U4 converter tests; fallback prose retained inline; no `ce_platforms: [claude]` |
| Workflow primitive limits shift (concurrency caps, research-preview) | Low | Don't over-fit to numeric caps (origin Dependencies); rely on bounded `parallel`, degrade on partial failure |
| Body-size win not realized (fallback prose retained) | Low | Acknowledged cost; relocation to on-demand reference deferred, not forced |

---

## Deferred / Open Questions (resolve at implementation)

- **Script-path resolution mechanism** (U4) — skill-relative `scriptPath` vs Read-and-inline `script`. Decide against live harness behavior, not assumption.
- **Exact `args` envelope** the workflow expects — finalize field names when wiring U3 against U2.
- **Whether default mode should later reuse the workflow** — deferred; this plan touches `mode:agent` only.

---

## Open decision for you (non-blocking)

I planned **parity-first** — the workflow reproduces current `mode:agent` output, with adversarial-verify / loop-until-dry deferred. The alternative is to add one rigor layer (e.g., adversarial-verify of surviving P0/P1 findings) in the first cut, since the workflow makes it cheap. I default to parity-first because this is the designated *lowest-risk, pattern-proving* conversion and mixing in rigor muddies the parity signal. Say the word and I'll fold an adversarial-verify round into U2 + U5 instead of deferring it.
