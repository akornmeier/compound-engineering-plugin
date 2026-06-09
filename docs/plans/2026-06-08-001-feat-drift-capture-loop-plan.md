---
status: active
type: feat
created: 2026-06-08
origin: docs/brainstorms/2026-06-04-dynamic-workflows-opportunity-map-requirements.md
related:
  - docs/plans/2026-06-07-001-feat-work-vs-plan-verification-probe-plan.md
  - docs/adr/0001-per-metric-signal-gate.md
  - CONTEXT.md
  - plugins/compound-engineering/skills/ce-verify-work/SKILL.md
---

# feat: close the drift→capture loop — durable drift events from `ce-verify-work`

## Summary

Make every `ce-verify-work` probe run produce a **durable drift event** in `docs/drift-events/`, written at the end of the run from the probe's already-cited evidence. This is the capture half of the rework/churn measurement loop: the probe today emits a per-plan reading that vanishes when the turn ends; this plan persists each reading as an evidence record so the **deferred** Signal-gate aggregation can later derive a drift rate by reading across them.

The captured artifact records the **drift event** — which units drifted, which were attempted, with cited evidence — **not a stored rate**. Per [ADR 0001](../adr/0001-per-metric-signal-gate.md), the drift rate is *read-time-derived* from these events plus session history and is never stored as a number (storing it reopens the out-of-scope task-ledger). The rate is recoverable from the recorded unit lists; the number itself is not written.

**Scope is capture only.** This plan builds neither the aggregation, the Signal gate, nor the threshold `T` — those remain deferred (Scope Boundaries). It closes the gap the `ce-verify-work` plan named as its first deferred follow-up: "writing a drift learning (direct-write-from-evidence) when drift is high."

**Why `feat`:** a new capability the probe could not previously perform — persisting its reading as a durable, aggregation-ready artifact. Nothing was broken; this is net-new.

---

## Problem Frame

`ce-verify-work` (the rework/churn **probe**, conversion #3) produces a per-plan drift envelope — `done`/`remaining`/`drifted`/`unverifiable` verdicts with cited evidence, plus a drift rate over attempted units. But the envelope lives only in the orchestrator's turn: present the table, end the turn, the reading is gone. [ADR 0001](../adr/0001-per-metric-signal-gate.md) commits the program to a Signal gate that reads an **aggregate** drift rate across runs, *read-time-derived from `ce-compound`-style captured drift learnings + session history*. With nothing captured, there is nothing to aggregate — the gate has no input, and the probe's whole reason for existing (feed the rework/churn metric) is unrealized.

**Marginal-over-baseline:** today's baseline is a transient, in-turn verdict table. The increment is one durable artifact per run, carrying the cited evidence the probe already gathered, in a location and shape a future aggregation can read deterministically — turning a momentary reading into a data point that compounds.

**Requirements advanced (origin + governing decisions):** the opportunity map's **R13** (the net-new work-vs-plan verification workflow that classifies each plan task done/remaining/drifted — `ce-verify-work` is that workflow, and this plan makes its readings durable so they feed the metric) and the `ce-verify-work` plan's first deferred follow-up. Governing decision: [ADR 0001](../adr/0001-per-metric-signal-gate.md) — drift rate is read-time-derived from captured drift learnings + session history, never stored; `T` is pre-committed against the *aggregate*, not a single run.

**User-confirmed scope decisions (planning):** (1) **every-run capture**, not high-drift-only — capturing only high-drift runs would bias the eventual aggregate (it would never see clean runs, so it could not tell "3 drifts of 3 plans" from "3 of 30"); (2) **auto-write at the end** of a qualifying run; (3) the capture lives **inside `ce-verify-work`**; (4) events are **committed to git** (shared, team-aggregatable), housed in **`docs/drift-events/`** (outside `docs/solutions/`, so consuming skills do not mistake them for human learnings).

---

## Scope Boundaries

**In scope**
- A drift-event document contract: location (`docs/drift-events/`), filename, minimal drift-event-specific frontmatter, and a machine-read data block carrying the cited unit lists (never a rate).
- A pure, unit-tested extension to the probe's roll-up module that emits the verdict-grouped unit-ID lists into the envelope, so the orchestrator's capture is a verbatim copy rather than an LLM re-grouping.
- An auto-write step in `ce-verify-work` that, at the end of every attempted-bearing run (both the workflow path and the prose fallback), writes one drift event from the returned envelope.
- The skip/flag rules: skip runs with no attempted units (no denominator); record `low_confidence` and `degraded` runs but mark them so the future aggregation can weight or exclude them.
- Glossary + concept reconciliation (`CONTEXT.md`, `CONCEPTS.md`) and the user-facing skill doc.
- Verification that a real run writes a valid, parser-safe drift event whose data block matches the envelope.

**Out of scope (non-goals)**
- **The Signal-gate aggregation** — globbing the drift events + session history and read-time-deriving the aggregate rate. Deferred; this plan only produces its inputs.
- **The Signal gate and threshold `T`** — `T` is pre-committed out-of-band against the aggregate (ADR 0001); neither the gate nor `T` is built here.
- **A drift-event *reader/parser*** — the consumer-side code that loads many events and aggregates them belongs with the aggregation cut. (This plan ships the *writer-side* projection only — a different, smaller function.)
- **Session-history supplementation** — ADR 0001's aggregate also reads session history to cover the git-only probe's blind spot (uncommitted/squashed rework). Wiring that is deferred (platform-specific, downstream of capture).

**Deferred to Follow-Up Work**
- The aggregation + gate + `T` (the consuming half), including the reader/parser for the data block.
- A retention/pruning policy for `docs/drift-events/` if per-run capture grows the directory large over time.
- Surfacing captured drift events back to the user (e.g., a "drift trend" view) — a reporting nicety, not part of the loop.

**Recorded decision (precondition, not code)**
- Per ADR 0001, the captured artifact **must not store the drift rate as a number**. It stores the cited unit lists (evidence) from which the rate is derivable at read time. Any future temptation to add a `drift_rate:` field to the artifact is a regression against ADR 0001.

---

## Key Technical Decisions

1. **Every-run capture, gated on a non-empty attempted set.** Write a drift event whenever `counts.attempted > 0` (there is a denominator). Skip runs where `drift_rate` is `null` (attempted = 0 — all `remaining`/`unverifiable`): they carry no rate signal and would be noise. `low_confidence` and `degraded` runs **are** captured but carry their flag, so the future aggregation can down-weight or exclude them rather than silently trusting a thin sample. *(user-confirmed: every-run; rationale: an unbiased aggregate needs clean runs too)*

2. **Auto-write at the end, in the orchestrator, both paths.** The capture is a new Phase 4 in `ce-verify-work/SKILL.md`, after Phase 3 presents the table. The orchestrator — which has file tools on every platform, unlike the Workflow runtime — writes the event from the returned envelope. Both the workflow path and the prose fallback converge on the same envelope shape, so the write is one step after either returns. *(user-confirmed: auto-write, inside ce-verify-work)*

3. **The report is primary; the capture is a best-effort side effect.** A failed write must never degrade the probe's primary deliverable (the verdict table). On any write failure, log a one-line warning and continue — the user still gets their reading. The probe's report-only contract re: the plan and code still holds: it never mutates the plan or the repo's code; it only appends a capture artifact.

4. **Drift events live in `docs/drift-events/`, outside `docs/solutions/`, and are committed to git.** ADR 0001 *describes* them as "`ce-compound`-captured drift learnings," but `ce-compound-refresh` discovers and audits everything under `docs/solutions/` (excluding only README) and `ce-learnings-researcher` searches `docs/solutions/` for human institutional knowledge. Housing per-run machine telemetry there would pollute both: every event would surface as a false "past learning" in pre-work research and as a keep/update/delete candidate in refresh sweeps. A dedicated top-level `docs/drift-events/` keeps telemetry out of both skills' scope **by construction** — no exclusion-list edits to maintain — and is the home the placement should be driven by (who reads the directory), not by the ADR's metaphor. Events are committed so the team-level and CI aggregation can read every machine's runs, not just one checkout's. *(grounding: `ce-compound-refresh/SKILL.md` discovery scope; `ce-learnings-researcher` search scope; surfaced by product-lens + scope-guardian review)*

5. **Drift events carry their own minimal frontmatter — they are not `ce-compound` solution docs.** Because they no longer live under `docs/solutions/`, they do not adopt `ce-compound`'s `schema.yaml` contract (no `problem_type`/`component`/`severity`/`category`). The frontmatter is the small set a reader/aggregation needs: `date`, `plan` (basename), `run_id`, `tags`. **`ce-compound`'s `validate-frontmatter.py` is reused only for what it does — parser-safety (silent-YAML-corruption prevention) — not as a schema check; it does not validate field presence or enums (its own docstring says so).** Required-key presence is asserted separately (U5). *(grounding: `ce-compound/scripts/validate-frontmatter.py` docstring; surfaced by feasibility review — corrects an earlier overclaim that a parser-safety pass proved schema conformance)*

6. **The data block is a genuine verbatim copy — the envelope carries the grouped lists, computed deterministically.** The roll-up module is extended (U2) so the envelope itself carries the verdict-grouped unit-ID lists (`drifted`, `attempted` = done+drifted, `remaining`, `unverifiable`) — a pure, unit-tested group-by-verdict over the same data `rollupVerdicts` already counts. The orchestrator then **copies those lists verbatim** into the artifact rather than re-grouping the flat `units[]` array itself. This makes the determinism real at the source: the machine-read block cannot misbucket a unit, because an LLM never does the bucketing. The block records **unit lists, never `drift_rate`** (ADR 0001 — the rate is derivable from `|drifted| / |attempted|` at read time). `degraded` in the block is `envelope.status === "degraded"` — a 1:1 read, not an LLM judgment. *(grounding: the `rollupVerdicts` envelope shape in `drift-rollup.js`; surfaced by adversarial review, which correctly flagged that the *original* flat envelope made grouping LLM-mediated)*

7. **Filename `<plan-basename>--<run_id>.md`.** `run_id` is already minted per run (timestamp + random) and is unique, so per-run events never collide; prefixing the plan basename groups a plan's readings together and keeps them sortable. The date the artifact needs comes from the orchestrator (it already mints `run_id` and can stamp the date) — the Workflow runtime cannot produce a date (`Date.now()` throws there), so date never originates runtime-side. *(grounding: the `run_id` minting in `ce-verify-work/SKILL.md` Phase 1; the no-`Date`-in-runtime contract in `dynamic-workflow-conversion-live-boundary.md`)*

---

## High-Level Technical Design

*Directional guidance for review. The implementing agent should treat it as context, not code to reproduce.*

```
/ce-verify-work [plan]
   Phase 1  resolve + validate plan, mint run_id + today
   Phase 2  classify (workflow OR prose fallback)
              rollupVerdicts now ALSO emits grouped ID lists into the envelope:
                drifted=[...], attempted=[...], remaining=[...], unverifiable=[...]
   Phase 3  present verdict table + drift rate (unchanged)
   Phase 4  CAPTURE (new):
              attempted == 0 ?  -->  skip (null rate, no denominator)
              else:
                assemble drift event = VERBATIM COPY of the envelope's grouped
                lists + run_id/plan_path/low_confidence + degraded(=status==degraded)
                  - minimal drift-event frontmatter (date, plan, run_id, tags)
                  - machine-read data block (copied, NO drift_rate)
                  - cited evidence per drifted/done unit (from envelope.units[].evidence)
                Write  docs/drift-events/<plan-basename>--<run_id>.md  (committed)
                write failed ?  -->  log one-line warning, continue (report already delivered)
```

**Drift-event document shape (directional):**

```markdown
---
date: 2026-06-08
plan: 2026-06-07-001-feat-work-vs-plan-verification-probe-plan
run_id: 20260608-...
tags: [drift-event, work-vs-plan-verification, ce-verify-work]
---

# Drift event — <plan title> (<run_id>)

```yaml
# machine-read block — copied verbatim from the envelope's grouped lists.
# The aggregation reads THIS; the rate is derived, never stored.
plan_path: docs/plans/2026-06-07-001-...-plan.md
run_id: 20260608-...
low_confidence: false
degraded: false
drifted: [U3]
attempted: [U1, U3, U5]
remaining: [U2]
unverifiable: [U4]
```

## Cited evidence
- U3 (drifted): <commit SHA> touched <path>; Verification unmet — <evidence from envelope>
- U1 (done): <path> present; <evidence> ...
```

The deferred aggregation derives the rate as `|drifted| / |attempted|` summed across captured events (down-weighting `low_confidence`/`degraded` ones) — the number is computed at read time, never read from the artifact. (Example IDs match `tests/fixtures/verify-work/sample-plan.md`: U1 done, U2 remaining, U3 drifted, U4 unverifiable, U5 done.)

---

## Output Structure

```
plugins/compound-engineering/skills/ce-verify-work/
  workflows/
    drift-rollup.js                     (modified: rollupVerdicts also emits grouped ID lists)
    work-vs-plan-fanout.generated.js    (regenerated: inlines the updated module)
  SKILL.md                              (modified: new Phase 4 capture step)
  references/
    drift-event-contract.md             (new: format, location, frontmatter, data block, no-rate rule)
    drift-event-template.md             (new: fill-in template the orchestrator copies into)
docs/drift-events/                      (new top-level dir — first event lands here at runtime)
  README.md                             (new: what this dir holds; that the aggregation globs it; not human learnings)
docs/skills/ce-verify-work.md           (modified: document the capture capability — file exists as of merged PR #10)
CONTEXT.md                              (modified: note the capture half of the loop now exists)
CONCEPTS.md                             (modified: add "Drift event" entry)
tests/work-vs-plan-rollup.test.ts       (modified: unit-test the grouped-list projection)
tests/work-vs-plan-workflow-eval.test.ts (modified: assert a drift event is written, parser-safe, keys present, block matches envelope)
```

The per-unit `**Files:**` sections are authoritative; this tree is a scope declaration.

---

## Implementation Units

### U1. Drift-event document contract + template + `docs/drift-events/` home

**Goal:** Define the durable artifact: where it lives (`docs/drift-events/`, committed), its filename, its minimal drift-event-specific frontmatter, and the machine-read data block that records the cited unit lists (never a rate). Provide a fill-in template the orchestrator copies into, and a `docs/drift-events/README.md` explaining the directory to humans and the future aggregation.

**Requirements:** R13; ADR 0001 (never store the number). Advances Key Decisions 4, 5, 6, 7.

**Dependencies:** none (foundation).

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/references/drift-event-contract.md` (new)
- `plugins/compound-engineering/skills/ce-verify-work/references/drift-event-template.md` (new)
- `docs/drift-events/README.md` (new)

**Approach:** The contract states: location `docs/drift-events/` (a top-level docs directory, deliberately **not** under `docs/solutions/` — name the reason: `ce-compound-refresh` and `ce-learnings-researcher` both scope to `docs/solutions/` and would mis-handle telemetry); filename `<plan-basename>--<run_id>.md`; minimal frontmatter (`date`, `plan` = plan basename, `run_id`, `tags`) — explicitly **not** the `ce-compound` `schema.yaml` contract; a single fenced data block carrying `plan_path`, `run_id`, `low_confidence`, `degraded`, and the four verdict-grouped unit-ID lists **copied verbatim from the envelope**; a "Cited evidence" prose section drawn from `envelope.units[].evidence`. State the load-bearing rule in bold: **never write `drift_rate` or any precomputed rate — record the unit lists; the rate is derived at read time (ADR 0001).** The README explains the directory holds machine-read drift telemetry (committed, one file per qualifying run) that a future Signal-gate aggregation globs — and that it is **not** human-authored learnings, so `ce-learnings-researcher`/`ce-compound-refresh` neither search nor audit it.

**Patterns to follow:** `ce-compound/assets/resolution-template.md` (template shape only); the YAML-safety quoting rule in `ce-compound/references/yaml-schema.md` (parser-safety applies to any frontmatter).

**Test scenarios:** Test expectation: none — reference/README prose; the contract is exercised by U3's write and U5's validation.

**Verification:** A hand-filled example following the template passes `python3 plugins/compound-engineering/skills/ce-compound/scripts/validate-frontmatter.py` (parser-safety); the contract states the no-rate rule and the verbatim-from-envelope requirement explicitly, and names why `docs/drift-events/` is outside `docs/solutions/`.

---

### U2. Emit verdict-grouped unit-ID lists from the roll-up module

**Goal:** Extend the probe's pure roll-up so the envelope carries the verdict-grouped unit-ID lists (`drifted`, `attempted`, `remaining`, `unverifiable`), making the orchestrator's capture a verbatim copy rather than an LLM re-grouping of the flat `units[]` array. This is the **writer-side projection** — small, pure, deterministic, unit-tested — distinct from the deferred consumer-side reader/parser.

**Requirements:** R13; ADR 0001 (the captured input must be trustworthy). Advances Key Decision 6.

**Dependencies:** none (pure-module change; can land parallel to U1).

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/workflows/drift-rollup.js` (modified)
- `plugins/compound-engineering/skills/ce-verify-work/workflows/work-vs-plan-fanout.generated.js` (regenerated)
- `tests/work-vs-plan-rollup.test.ts` (modified)

**Approach:** In `rollupVerdicts` (or a small pure helper it calls), in the same pass that counts by verdict, also collect the surviving unit IDs into four ordered lists — `drifted`, `remaining`, `unverifiable`, and `attempted` (= the union of `done` + `drifted` IDs). Return them on the envelope object alongside the existing `counts`/`drift_rate`/`low_confidence`/`units`. Pure only — no rate stored in the lists, no fs, no Agent/Workflow calls; preserve the existing single trailing `export`. Regenerate the workflow artifact (`bun run scripts/build-work-vs-plan-workflow.ts`) so the inlined copy matches; the freshness test guards it. The prose fallback already calls the same `rollupVerdicts`, so it inherits the grouped lists with no extra work.

**Execution note:** Test-first — the grouped-list projection from a fixed verdict set is precisely specifiable; write the assertions before the change.

**Test scenarios:**
- A fixed verdict set (2 done / 1 remaining / 1 drifted / 1 unverifiable, U-IDs U1–U5 per the rollup test's existing fixtures) projects to `drifted` = the drifted IDs, `attempted` = done+drifted IDs in order, `remaining` and `unverifiable` = their IDs — exact match.
- `attempted` equals the union of done and drifted IDs and its length equals `counts.attempted` (single-source-of-truth: the grouped list and the count cannot disagree).
- Dropped/malformed verdicts (already excluded from counts) do not appear in any grouped list.
- Empty/all-remaining input → `drifted`/`attempted` empty, `remaining` populated; no throw.
- Determinism: byte-identical grouped lists across repeated runs on a fixed set.

**Verification:** `bun test tests/work-vs-plan-rollup.test.ts` green; `bun run scripts/build-work-vs-plan-workflow.ts` reproduces the committed artifact with no diff (freshness test passes); the module still has no `import`/`require`/`agent(`/`fs`.

---

### U3. Auto-write capture step in `ce-verify-work` (both paths)

**Goal:** After Phase 3 presents the table, write one drift event per qualifying run by copying the envelope's grouped lists verbatim into the contract's artifact — on both the workflow path and the prose fallback — honoring the every-run / skip / flag / fail-soft rules.

**Requirements:** R13; the `ce-verify-work` plan's first deferred follow-up. Advances Key Decisions 1, 2, 3, 6, 7.

**Dependencies:** U1, U2.

**Files:**
- `plugins/compound-engineering/skills/ce-verify-work/SKILL.md` (modified: add Phase 4)

**Approach:** Add a `## Phase 4: Capture the drift event` after Phase 3. Load-bearing rules inline (per the SKILL.md-caches / references-load-on-demand principle), with format details in `references/drift-event-contract.md`:
- Fire when `counts.attempted > 0`. When `attempted == 0` (drift_rate null), skip and say so in one line. When `status` is `invalid_input`, never write (there was no run).
- Stamp the date the orchestrator already has (mint `today` alongside `run_id` in Phase 1). Assemble the artifact per the contract, **copying the grouped lists, `run_id`, `plan_path`, and `low_confidence` verbatim from the envelope** (U2 put them there) and the per-unit evidence from `envelope.units[]`. Set `degraded: true` in the block when `status == "degraded"`.
- Write to `docs/drift-events/<plan-basename>--<run_id>.md` with the platform's file-write tool. On failure, log one line and continue — the verdict table is already delivered.
- The prose fallback reaches the same Phase 4 (it produced the same envelope shape via the shared `rollupVerdicts`), so the capture is written once regardless of path.

**Execution note:** Behavioral skill change — validate by running the skill against the fixture (see U5), not by reading alone; SKILL.md edits do not take effect until reload, so use the skill-creator eval path or a fresh session to test.

**Test scenarios:**
- *Integration/manual (covered by U5):* a fixture run with `attempted > 0` writes exactly one drift event whose data block's lists equal the envelope's grouped lists.
- *Integration/manual:* an all-`remaining` fixture (attempted 0) writes **no** event and prints the skip line.
- *Integration/manual:* a `degraded` run writes an event flagged `degraded: true`.
- *Manual:* a simulated write failure logs a warning and still prints the verdict table.

**Verification:** Manual read confirms Phase 4 fires only on `attempted > 0`, copies verbatim from the envelope, records no `drift_rate`, writes under `docs/drift-events/`, and fails soft; U5's eval proves the end-to-end write.

---

### U4. Glossary, concepts, and skill-doc reconciliation

**Goal:** Name the new artifact in the program's shared vocabulary and document the capability so future readers (and the deferred aggregation) understand what `docs/drift-events/` holds and how it relates to the gate. Non-blocking for capture mechanics (U1–U3 + U5 deliver a working loop); this unit makes the loop discoverable and correctly named.

**Requirements:** R13; documentation completeness. Advances Key Decision 4.

**Dependencies:** U1 (vocabulary derives from the contract). Reflects U3's behavior, so author after U3 is settled.

**Files:**
- `CONCEPTS.md` (modified: add a `Drift event` entry near `Drift rate`/`Dynamic workflow`)
- `CONTEXT.md` (modified: note the capture half of the rework/churn loop now exists; the gate aggregation remains deferred)
- `docs/skills/ce-verify-work.md` (modified: document the auto-capture capability — the file exists as of merged PR #10)

**Approach:** `CONCEPTS.md`: define `Drift event` as a durable, per-run record of one `ce-verify-work` reading — the cited drifted/attempted unit lists for a plan, in `docs/drift-events/` — from which the rework/churn drift rate is derived at read time, never stored. Cross-reference `Drift rate` and `Dynamic workflow`. `CONTEXT.md`: in the drift-rate framing, note that captured drift events now exist as the aggregation's input, while the aggregation/gate/`T` stay deferred. `docs/skills/ce-verify-work.md`: add a short "Capture" section under the probe/gate framing — every attempted-bearing run writes a committed drift event; this is the input the future Signal gate aggregates.

**Test scenarios:** Test expectation: none — documentation-only unit.

**Verification:** `CONCEPTS.md` entry follows the glossary rules (definition sentence, no implementation specifics); `docs/skills/README.md` link to `ce-verify-work` still resolves; prose is accurate to U1/U3.

---

### U5. Eval: end-to-end capture is written, parser-safe, key-complete, and faithful

**Goal:** Prove a real run writes a drift event to `docs/drift-events/`, that it is parser-safe, carries the required keys, and that its data block faithfully mirrors the envelope's grouped lists (so the future aggregation reads true data).

**Requirements:** R13; ADR 0001 (the captured input must be trustworthy). Advances Key Decisions 5, 6.

**Dependencies:** U2, U3.

**Files:**
- `tests/work-vs-plan-workflow-eval.test.ts` (modified)

**Approach:** Extend the eval. The deterministic core is now real code (U2's grouped-list projection), so assert against it directly: given the recorded fixture envelope, the grouped lists equal the expected IDs, and the artifact assembled from them per the contract (a) lists exactly those IDs by verdict, (b) contains **no** `drift_rate`/rate field anywhere, (c) passes `validate-frontmatter.py` for **parser-safety** (shell out on a written temp file, assert exit 0), and (d) **contains the required drift-event keys** (`date`, `plan`, `run_id` in frontmatter; `plan_path`, `run_id`, the four lists in the block) — asserted explicitly, since `validate-frontmatter.py` does not check key presence. Skip-case: the all-`remaining` fixture yields no data block (attempted 0). `degraded` case: block carries `degraded: true`. For the live path, document (as with the existing live-smoke record) that a real `/ce-verify-work` run writes `docs/drift-events/<plan>--<run_id>.md` whose block matches the presented table.

**Execution note:** Test-first for the projection + assembly assertions (real code now, precisely specifiable); the live write is the manual acceptance gate, recorded like the existing smoke.

**Test scenarios:**
- Fixture envelope (U1 done, U2 remaining, U3 drifted, U4 unverifiable, U5 done) → grouped lists `drifted: [U3]`, `attempted: [U1, U3, U5]`, `remaining: [U2]`, `unverifiable: [U4]` — exact match (mirrors `tests/fixtures/verify-work/sample-plan.md`).
- Assembled artifact contains no `drift_rate` and no precomputed rate anywhere.
- Assembled frontmatter passes `validate-frontmatter.py` (exit 0) on a written temp file — asserted as parser-safety, not schema conformance.
- Required keys present: `date`/`plan`/`run_id` in frontmatter; `plan_path`/`run_id`/`drifted`/`attempted`/`remaining`/`unverifiable` in the block.
- Attempted-0 envelope (all `remaining`/`unverifiable`) → no event assembled (skip path).
- `degraded` envelope → block carries `degraded: true`.
- Recorded live-run note: a real probe run writes one event under `docs/drift-events/` whose block matches the verdict table.

**Verification:** `bun test tests/work-vs-plan-workflow-eval.test.ts` green; a manual `/ce-verify-work` run leaves a valid drift event on disk that `validate-frontmatter.py` accepts and that carries all required keys.

---

## Risk Analysis & Mitigation

| Risk | Impact | Mitigation |
|---|---|---|
| **Capture stores the rate, regressing ADR 0001** — a future edit adds `drift_rate:` to the artifact, reopening the task-ledger the ADR forbids | High — the gate input becomes a stored metric, not derived evidence | U1 states the no-rate rule in bold; U5 asserts no rate field is present; the contract records the unit-lists-only principle |
| **Aggregate bias from selective capture** — capturing only some runs skews the eventual rate | High — the gate reads a biased number | Every-run capture (Key Decision 1); the only skip is attempted-0 (no denominator), which contributes nothing to the rate either way |
| **Model-authored block drifts from the envelope** — wrong unit IDs poison the future aggregate | High — the gate reads false data | The grouped lists are computed deterministically in the roll-up module and carried on the envelope (U2); the orchestrator copies them verbatim (Key Decision 6), so an LLM never buckets units; U2 unit-tests the projection and U5 asserts the artifact matches |
| **Telemetry pollutes the human-learning corpus** — events surface as false "past learnings" or refresh candidates | High — `ce-learnings-researcher` misguides pre-work; `ce-compound-refresh` audits noise | `docs/drift-events/` is outside `docs/solutions/`, so neither skill's scope includes it (Key Decision 4) — structural, no exclusion list to maintain (surfaced by product-lens + scope-guardian) |
| **A write failure breaks the probe's report** | Medium — users lose their verdict table over a capture side effect | Capture is best-effort and fail-soft (Key Decision 3); the report is delivered before the write; failure logs and continues |
| **"Schema-conformant" overclaim** — treating a `validate-frontmatter.py` pass as proof of field/enum validity | Medium — an event missing required keys ships "validated" | Key Decision 5 uses the script for parser-safety only; U5 asserts required-key presence separately (surfaced by feasibility) |
| **Designing capture without the consumer** — the artifact shape may not fit the deferred aggregation | Medium — rework when aggregation lands | Shape is anchored to ADR 0001's stated read model (events + session history, derive don't store); the committed `docs/drift-events/` dir + verbatim grouped lists are the minimal sound input; the reader/parser is explicitly deferred and is a *different* function from U2's writer-side projection, so deferring it costs no rework here (acknowledged FYI, adversarial) |
| **`docs/drift-events/` grows unbounded** under per-run committed capture | Low–Medium | A retention/pruning policy is a named follow-up; per-run files are small; committed-to-git was the user's explicit choice for team aggregation |
| **Non-CC fallback variance** — the prose-path write is model-authored | Low | The grouped lists still come from the deterministic `rollupVerdicts` the fallback also calls; only prose framing varies, which the aggregation does not read |

---

## Alternative Approaches Considered

- **High-drift-only capture** (the original framing). Rejected on user confirmation: it biases the aggregate by never recording clean runs, so the gate could not distinguish a high-rework program from a well-behaved one. Every-run capture with an attempted-0 skip is the unbiased choice.
- **Store the drift rate in the artifact (or a metrics ledger).** Rejected — directly violates ADR 0001 ("store the drift number in a metrics ledger" is a rejected option; it reopens the task-ledger redesign). The rate is derived at read time from recorded unit lists.
- **House drift events under `docs/solutions/` (e.g., `docs/solutions/drift-events/`).** Rejected after review: `ce-compound-refresh` audits and `ce-learnings-researcher` searches everything under `docs/solutions/` (excluding only README), so per-run telemetry would surface as false learnings and refresh-sweep noise. A claimed "dedicated subdir keeps them out of search" is unsupported — nothing in those skills honors such an exclusion. `docs/drift-events/` solves it structurally. (The ADR's "drift learnings" phrasing is a conceptual description, not a placement mandate.)
- **Let the orchestrator group the flat `units[]` array into verdict buckets via a prose template.** Rejected: that is LLM-mediated re-derivation — an LLM can misbucket, drop, or include a dropped verdict, poisoning the aggregate. Computing the grouped lists deterministically in the roll-up module (U2) and copying them verbatim makes the determinism real where it matters, for a few lines of pure code.
- **Invoke the full `ce-compound` skill to write the learning.** Rejected: `ce-compound`'s research/overlap/parallel-subagent machinery is built for human learnings discovered through investigation. A drift event is direct-from-evidence telemetry — the probe already holds the cited evidence, so a direct write against a fixed contract is correct and far cheaper. (This is the "direct-write-from-evidence" the origin deferral named.)
- **Build the consumer-side reader/parser now.** Rejected for this cut: the writer-side projection (U2, envelope→grouped lists) and the reader-side parser (many files→aggregate) are different functions; the gate/aggregation is deferred by scope, and the parser belongs with it. Shipping the writer alone incurs no rework because the artifact shape is fixed to ADR 0001's read model.

---

## Deferred / Open Questions (resolve at implementation)

- **Exactly which evidence to inline** in the prose "Cited evidence" section (U3) — the full `envelope.units[].evidence` per drifted/done unit vs. drifted-only. Lean drifted + done (the attempted set), since those are the rate's numerator and denominator; refine against the first real captures.
- **Whether the block's `attempted` list is needed** given `drifted` + a `done` list would also convey it (U1/U2) — keeping `attempted` explicit avoids the aggregation recomputing a union, but a `done` list may be more natural. Confirm the field set against the reader when the aggregation cut starts; the writer is cheap to adjust.
- **Retention policy for `docs/drift-events/`** (deferred follow-up, flagged here) — per-run committed files will accumulate; decide a pruning/rotation approach when volume warrants, not now.
