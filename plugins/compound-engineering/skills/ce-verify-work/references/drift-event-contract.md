# Drift-event document contract

A **drift event** is the durable artifact `ce-verify-work` writes at the end of a
qualifying probe run (Phase 4). It persists one per-plan reading — the cited
drifted/attempted unit lists — so a future Signal-gate aggregation can read
across many runs and derive a drift rate. The capture is the writer side; the
aggregation/reader is deferred follow-up work.

A run **qualifies** when it has a non-empty attempted set: write exactly one
event when `counts.attempted > 0`; skip a run with `attempted == 0` (no
denominator) and never write when `status == "invalid_input"` (there was no
run). See the skill's Phase 4 for the full gate. `low_confidence` and
`degraded` runs still qualify — they are captured with their flag, not dropped.

## Location

Write drift events to **`docs/drift-events/`** — a top-level docs directory,
committed to git.

**Deliberately not under `docs/solutions/`.** `ce-compound-refresh` audits
everything under `docs/solutions/` (excluding only README) and
`ce-learnings-researcher` searches it for human institutional knowledge. A
drift event is per-run machine telemetry, not a human-authored learning;
housing it under `docs/solutions/` would surface every event as a false "past
learning" in pre-work research and as a keep/update/delete candidate in refresh
sweeps. A dedicated top-level directory keeps telemetry out of both skills'
scope by construction — no exclusion list to maintain.

## Filename

`<plan-basename>--<run_id>.md`

- `<plan-basename>` is the plan file's name without directory or extension
  (e.g. `2026-06-07-001-feat-work-vs-plan-verification-probe-plan`). Prefixing
  it groups a plan's readings together and keeps them sortable.
- `<run_id>` is the per-run token minted in Phase 1 (timestamp + random). It is
  unique, so per-run events never collide.

## Frontmatter (minimal — NOT the ce-compound schema)

Drift events do **not** live under `docs/solutions/`, so they do **not** adopt
`ce-compound`'s `schema.yaml` contract — no `problem_type`, `component`,
`severity`, or `category`. The frontmatter is only what a reader/aggregation
needs:

```yaml
date: 2026-06-08
plan: 2026-06-07-001-feat-work-vs-plan-verification-probe-plan
run_id: 20260608-143022-a1b2c3d4
tags: [drift-event, work-vs-plan-verification, ce-verify-work]
```

- `date` — the day of the run, stamped by the orchestrator (the Workflow
  runtime cannot mint a date; `Date.now()` throws there).
- `plan` — the plan basename (matches the filename prefix).
- `run_id` — the same token used in the filename and the data block.
- `tags` — fixed marker tags; keep `drift-event` first so the directory is
  greppable.

Frontmatter must be **parser-safe** so strict YAML parsers (`yq`, `js-yaml`
strict, PyYAML) cannot silently misread it. The values above are all safe; the
rule for any future field is: quote a value that starts with `` ` `` `[` `*`
`&` `!` `|` `>` `%` `@` `?`, or that contains `: ` (colon-space) or ` #`
(space-hash) — left unquoted, those punctuation forms get silently truncated or
reframed. Flow arrays like `tags: [drift-event, ...]` are already structured and
need no quoting.

Parser-safety is a quoting concern only; it does **not** assert key presence or
enums. Required-key presence is checked separately by the eval (U5).

## Machine-read data block

A single fenced `yaml` block, **copied verbatim from the probe's returned
envelope** (`envelope.grouped` + the run's flags). The orchestrator copies these
lists; it never re-groups the flat `units[]` array itself — an LLM must never
bucket a unit. The lists are computed deterministically in `rollupVerdicts`
(`workflows/drift-rollup.js`), so the block cannot misbucket.

````markdown
```yaml
# machine-read block — copied verbatim from the envelope's grouped lists.
# The aggregation reads THIS; the rate is derived, never stored.
plan_path: docs/plans/2026-06-07-001-feat-work-vs-plan-verification-probe-plan.md
run_id: 20260608-143022-a1b2c3d4
low_confidence: false
degraded: false
drifted: [U3]
attempted: [U1, U3, U5]
remaining: [U2]
unverifiable: [U4]
```
````

Field sources, all verbatim from the envelope:

- `plan_path` — `envelope.plan_path` (the absolute or repo-relative plan path).
- `run_id` — `envelope.run_id`.
- `low_confidence` — `envelope.low_confidence` (the run's small-N / high-
  unverifiable flag; a future aggregation can down-weight or exclude it).
- `degraded` — `envelope.status === "degraded"` rendered as a boolean (some
  classifier batches failed; a 1:1 read, never an LLM judgment).
- `drifted` / `attempted` / `remaining` / `unverifiable` — the four lists from
  `envelope.grouped`, IDs only. `attempted` = done + drifted.

**Load-bearing rule (ADR 0001): never write `drift_rate` or any precomputed
rate — anywhere in the artifact.** Record the unit lists; the rate is derived at
read time as `|drifted| / |attempted|` by the deferred aggregation. Adding a
`drift_rate:` field reopens the out-of-scope task-ledger the ADR forbids — it is
a regression, not a convenience.

## Cited evidence (prose)

A `## Cited evidence` section with one bullet per **attempted** unit (the
`done` and `drifted` units — the rate's denominator and numerator), drawn from
`envelope.units[].evidence`. This is the human-readable backing for the lists;
the aggregation does not parse it.

```markdown
## Cited evidence
- U3 (drifted): <commit SHA> touched <declared path>; Verification unmet — <evidence>
- U1 (done): <declared path> present; <evidence satisfying Verification>
- U5 (done): <declared path> present; <evidence>
```

`remaining` units have no attempt to cite and `unverifiable` units are excluded
from the rate, so neither needs an evidence bullet; the `remaining` /
`unverifiable` lists in the data block already record them.
