---
name: ce-verify-work
description: Classify a plan's Implementation Units against actual repo state and report a per-unit verdict table plus a drift rate. Use when you need a read on what is done, remaining, or drifted in a plan, such as before resuming work on it.
argument-hint: "[path/to/plan.md | blank = latest plan in docs/plans/]"
---

# Work-vs-Plan Verification Probe

Read one plan document, classify each Implementation Unit against the **actual repo state** — git history plus file/behavior state, never plan checkboxes — and return a per-unit verdict table plus a per-plan **drift rate**. Each unit is `done`, `remaining`, `drifted`, or `unverifiable`; the drift rate is the fraction of *attempted* units (`done + drifted`) that drifted — the redo-shaped subset, not raw progress.

This is a **probe**, not a gate. The per-plan drift rate is a single reading for diagnosis; it is not, on its own, a threshold decision. It is report-only — it never mutates the plan or the repo.

## Phase 1: Resolve and validate the plan

**Resolve the plan path:**
- If a path argument is given, use it.
- Otherwise auto-detect the latest plan: glob `docs/plans/*.md` and `docs/plans/*.html` and pick the most recent regardless of extension (mirror `ce-work`'s detection). HTML plans carry the same section and field names as markdown.

**Validate before dispatch (ADR 0002).** The orchestrator is the primary validation tier — it alone touches the filesystem and holds this phase's context, so it fails fast here rather than spinning up a workflow for a known-bad call. Confirm:
- the plan path resolves to an **absolute** path that exists and is readable (read it now — the contents are needed below);
- it parses to **at least one Implementation Unit** (a `### U<n>.` heading). Use the `parsePlanUnits` parser in `workflows/drift-rollup.js` as the authority for "does this parse to units".

On any failure, **do not dispatch** and **do not fall back to the prose path** — a contract violation is a caller bug, not a platform gap. Print `invalid_input` with the specific reason and stop. Example: `invalid_input: plan has no Implementation Units (no "### U<n>." headings)`.

**Mint the run id and today's date, and stage the run directory:**
```bash
RUN_ID=$(date +%Y%m%d-%H%M%S)-$(head -c4 /dev/urandom | od -An -tx1 | tr -d ' ')
TODAY=$(date +%F)
mkdir -p "/tmp/compound-engineering/ce-verify-work/$RUN_ID"
```
`TODAY` (YYYY-MM-DD) stamps the drift event in Phase 4 — the Workflow runtime cannot mint a date (`Date.now()` throws there), so the date must originate here.

## Phase 2: Classify (guarded)

When the **Workflow tool is available** (Claude Code), run the classification as a dynamic workflow — the per-unit classification reasoning stays in the workflow runtime, so only the final drift envelope enters this orchestrator's context. This is also the **cross-platform guard**: on targets without the Workflow tool (Codex, Gemini, etc.) the prose fallback below is the unchanged, fully-functional probe, so a converted skill never emits orchestration the target cannot run.

1. Read `workflows/work-vs-plan-fanout.generated.js` (co-located; resolved relative to this skill).
2. Invoke the Workflow tool with `script` set to that file's contents and `args`:
   - `run_id` — from Phase 1 (a path-safe `[A-Za-z0-9_-]+` token).
   - `plan_path` — the **absolute** path confirmed in Phase 1 (the classifier agents Read it for full context).
   - `plan_text` — the plan **contents** read in Phase 1. The Workflow runtime has no filesystem access, so it cannot read the plan itself; pass the text it must parse.
   - `batch_size` — optional; omit to use the default (~6 units per classifier agent).
   - `agentType` — **omit by default.** The default classifier is a schema-only general-purpose analysis agent (the proven dispatch path, no new-agent scope). Set it only to a dedicated, **plugin-namespaced** `compound-engineering:ce-*` classifier — the workflow `agent()` registry does not resolve the bare `ce-*` form, and a bad type is swallowed into an empty result.
3. The workflow returns the drift envelope (`status`, `drift_rate`, `low_confidence`, `counts`, `units`, `unverifiable`, `plan_path`, `artifact_path`, `run_id`). Present it per Phase 3. If `status` is `invalid_input`, the staged `args` were malformed — surface the returned `error` and stop (this means the Phase 1 validation was skipped or wrong). If `status` is `degraded`, some classifier batches failed — surface `counts.failed_batches` and that `units` covers fewer than `counts.total_units`, but still present what returned.

When the Workflow tool is unavailable, ignore this subsection and run the prose dispatch below.

### Prose fallback (when the Workflow tool is unavailable)

Classify the units **sequentially in this orchestrator's context** using the same contract:
- Load `references/verdict-rubric.md` (the four-verdict decision rules, the evidence requirement, the conservative tie-break, and the git-and-file-state-only rule) and `references/verdict-schema.json` (the per-unit output shape).
- For each unit, inspect repo state with native file tools (Read/Grep/Glob) and single, unchained git commands run one at a time (`git log --oneline -- <path>`, `git log -p -- <path>`). Treat "file absent" / "no such ref" as a `remaining`/`drifted` signal, never an aborting error. Emit one verdict object per unit: `{ u_id, verdict, evidence, rationale }`, with non-empty evidence for `done`/`drifted`.
- **Roll the verdicts up with the same deterministic rules the workflow uses — do not improvise the math.** `workflows/drift-rollup.js` (`rollupVerdicts`) is the single source of truth; the workflow and this fallback share it, so the rate cannot diverge. Apply exactly these rules (the module's): drop any verdict whose `verdict` is not in `{done, remaining, drifted, unverifiable}`, whose `u_id` is empty, or that is a `done`/`drifted` lacking non-empty `evidence`; `attempted = done + drifted`; `drift_rate = drifted / attempted`, or `null` when `attempted = 0`; `remaining` and `unverifiable` are counted but **excluded** from the denominator; set `low_confidence` when `attempted` is below **3** or `unverifiable / (done + remaining + drifted + unverifiable) ≥ 0.5`. If the platform has a JS runtime and can locate the co-located module, running it is the most exact path; otherwise apply the rules above verbatim.

## Phase 3: Present the verdict table + drift rate

Render, in this order:
1. The **drift rate** as the headline (e.g. `Drift rate: 0.33 (1 of 3 attempted units drifted)`), or `Drift rate: n/a — no attempted units yet` when it is `null`.
2. **If `low_confidence` is true, surface it prominently** immediately under the headline — e.g. `⚠ low confidence: the attempted set is small or mostly unverifiable; do not read this as a trustworthy gate input.` A near-empty or high-`unverifiable` denominator must not be read as a trustworthy number.
3. The `counts` line: `done`, `remaining`, `drifted`, `unverifiable`, and the `attempted` denominator (`done + drifted`).
4. The **verdict table** — one row per unit: `U-ID | verdict | evidence`. Keep evidence to the cited artifacts (paths, commit SHAs, diff hunks).
5. The `unverifiable` units listed separately with their reason (excluded from the denominator).

End with a one-line reminder that this is a per-plan diagnostic reading, not a gate decision.

## Phase 4: Capture the drift event

Persist this run's reading as a durable **drift event** under `docs/drift-events/` (committed) so a future Signal-gate aggregation can read across runs. This is a **best-effort side effect**: Phase 3's verdict table is the primary deliverable and is already delivered — a failed capture must never degrade it. The probe's report-only contract still holds — it appends one telemetry file; it never mutates the plan or the repo's code.

**When to write — gate on a non-empty attempted set:**
- `status == "invalid_input"` → never write (there was no run).
- `counts.attempted == 0` (`drift_rate` is `null` — all `remaining`/`unverifiable`) → **skip** and print one line, e.g. `No drift event written — 0 attempted units (no denominator).` These carry no rate signal; capturing only some runs would bias the future aggregate.
- `counts.attempted > 0` → write exactly one drift event (capture **every** such run, `low_confidence` and `degraded` included — flagged, not dropped, so the aggregation can weight them).

**Assemble the event** per `references/drift-event-contract.md` (format) into the shape in `references/drift-event-template.md`. **Copy the lists verbatim from the returned envelope — do not re-group the flat `units[]` array yourself.** `envelope.grouped` was computed deterministically by the shared `rollupVerdicts`; re-grouping by hand invites misbucketing that would poison the aggregate.
- Frontmatter: `date` = `TODAY` from Phase 1; `plan` = the plan basename; `run_id` = `envelope.run_id`; `tags: [drift-event, work-vs-plan-verification, ce-verify-work]`.
- Data block, all verbatim from the envelope: `plan_path`, `run_id`, `low_confidence`, and the four grouped lists (`drifted`, `attempted`, `remaining`, `unverifiable`) from `envelope.grouped`. Set `degraded: true` when `status == "degraded"`, else `false`.
- `## Cited evidence`: one bullet per attempted (`done`/`drifted`) unit, drawn from `envelope.units[].evidence`.

**Never write `drift_rate` or any precomputed rate, anywhere in the artifact** (ADR 0001). Record the unit lists; the rate is derived at read time as `|drifted| / |attempted|` by the deferred aggregation. A stored rate reopens the out-of-scope task-ledger.

**Write** to `docs/drift-events/<plan-basename>--<run_id>.md` with the platform's file-write tool (Write in Claude Code). **On any failure, log one line and continue** — the report is already delivered.

This phase runs identically after the workflow path and the prose fallback: both produce the same envelope via the shared `rollupVerdicts`, so `envelope.grouped` is present on either path and the event is written once. (If the fallback applied the roll-up rules by hand without the module, group the same surviving verdicts by verdict — `attempted` = `done` + `drifted`, each list ordered by U-number.)
